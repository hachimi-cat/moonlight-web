use std::{ops::Deref, sync::Arc, time::Duration};

use tokio::{
    spawn,
    sync::{mpsc::Sender, oneshot, watch},
    time::{sleep, timeout},
};
use tracing::{debug, warn};

use crate::app::{
    App, AppError,
    user::{AuthenticatedUser, RoleType, User},
};

pub enum ExternalStreamEvent {
    WebRTCAddIceCandidate {
        ice_sdp_frag: String,
    },
    /// Renegotiate ICE on the existing WebRTC peer. The Moonlight/Apollo
    /// stream deliberately stays alive so its virtual XInput device keeps
    /// the same Windows slot while a dead browser media route is repaired.
    WebRTCIceRestart {
        offer_sdp: String,
        answer: oneshot::Sender<Result<String, AppError>>,
    },
    Stop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct StreamId(pub u32);

#[derive(Clone)]
pub struct Stream {
    inner: Arc<StreamInner>,
}

impl Stream {
    pub async fn new(
        app: &App,
        owner: &AuthenticatedUser,
        event_sender: Sender<ExternalStreamEvent>,
        stopped: watch::Receiver<bool>,
    ) -> Result<Self, AppError> {
        app.insert_stream(|id| {
            let app_ref = app.new_ref();

            spawn({
                let event_sender = event_sender.clone();

                async move {
                loop {
                    sleep(Duration::from_secs(30)).await;

                    {
                        let app = match app_ref.access() {
                            Ok(value) => value,
                            Err(err) => {
                                warn!(stream_id = ?id, error = %err, "failed to aquire app in alive check for stream");
                                return;
                            }
                        };

                        if event_sender.is_closed() {
                            debug!("identified stream as closed, waiting some time and then removing it");
                            sleep(Duration::from_secs(10)).await;

                            let mut streams = app.streams.write().await;
                            streams.remove(&id);

                            debug!(stream_id = ?id, "removed stopped stream from app");
                            return;
                        }
                    }
                }
            }});

            Self {
                inner: Arc::new(StreamInner {
                    id,
                    owner: owner.deref().clone(),
                    event_sender,
                    stopped,
                }),
            }
        })
        .await
    }

    pub fn id(&self) -> StreamId {
        self.inner.id
    }

    pub async fn owner(&self) -> Result<User, AppError> {
        Ok(self.inner.owner.clone())
    }

    async fn has_permissions(&self, user: &mut AuthenticatedUser) -> Result<(), AppError> {
        if matches!(user.role().await?.ty().await?, RoleType::Admin)
            || user.id() == self.owner().await?.id()
        {
            Ok(())
        } else {
            Err(AppError::Forbidden)
        }
    }

    pub async fn send_event(
        &self,
        user: &mut AuthenticatedUser,
        event: ExternalStreamEvent,
    ) -> Result<(), AppError> {
        self.has_permissions(user).await?;

        self.inner
            .event_sender
            .send(event)
            .await
            .map_err(|_| AppError::StreamClosed)?;

        Ok(())
    }

    /// Ask the stream task to stop and wait until its Moonlight connection
    /// and WebRTC peer have actually been torn down.
    ///
    /// Merely enqueueing `Stop` allowed a replacement stream to reach Apollo
    /// while the old client was still alive. Apollo then assigned the same
    /// browser controller to a second global XInput device, and the game's
    /// controller identity changed when the old client eventually timed out.
    pub async fn stop_and_wait(
        &self,
        user: &mut AuthenticatedUser,
        max_wait: Duration,
    ) -> Result<bool, AppError> {
        let mut stopped = self.inner.stopped.clone();

        self.send_event(user, ExternalStreamEvent::Stop).await?;

        if *stopped.borrow() {
            return Ok(true);
        }

        Ok(matches!(
            timeout(max_wait, stopped.wait_for(|done| *done)).await,
            Ok(Ok(_))
        ))
    }

    #[allow(unused)]
    pub fn is_alive(&self) -> Result<bool, AppError> {
        Ok(!self.inner.event_sender.is_closed())
    }
}

pub(crate) struct StreamInner {
    pub(crate) id: StreamId,
    pub(crate) owner: User,
    pub(crate) event_sender: Sender<ExternalStreamEvent>,
    pub(crate) stopped: watch::Receiver<bool>,
}
