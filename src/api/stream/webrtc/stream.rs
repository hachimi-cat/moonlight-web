use moonlight_common::stream::{
    proto::{
        audio::AudioStreamEvent,
        control::{ControlStreamEvent, packet::ControlPacket},
        video::VideoStreamEvent,
    },
    tokio::{MoonlightStream, MoonlightStreamEvent},
};
use std::time::Duration;
use tokio::{select, time::timeout};
use tracing::{debug, info, warn};
use webrtc::peer_connection::{RTCPeerConnection, peer_connection_state::RTCPeerConnectionState};

use crate::{
    api::stream::webrtc::{
        audio::AudioChannel,
        control::{ControlChannel, ControlChannelEvent},
        video::{VideoChannel, VideoChannelEvent},
    },
    app::AppError,
};

/// How long to keep writing queued control packets after the moonlight
/// stream dies. Small: the queue holds a handful of packets and the peer is
/// on its way out either way.
const CONTROL_FLUSH_TIMEOUT: Duration = Duration::from_millis(750);

/// Write out whatever the host sent us on its way down before tearing the
/// peer connection apart.
///
/// [`ControlChannel::send`] only ENQUEUES — the write happens inside its
/// `drive()`, which only runs from the `select!` in [`webrtc_loop`]. When a
/// player quits a game the host sends ServerTermination and the moonlight
/// peer disconnects in the same breath (`disconnect_now`, see
/// moonlight-common-rust's control stream), so `is_alive()` goes false on
/// the very next iteration and the loop broke with that packet still in the
/// queue. It never reached the browser, which therefore could not tell a
/// deliberate quit from a dropped connection and showed "connection lost"
/// for every clean exit.
async fn flush_control_channel(control_channel: &mut ControlChannel) {
    if !control_channel.has_pending_sends() {
        return;
    }
    let flushed = timeout(CONTROL_FLUSH_TIMEOUT, async {
        while control_channel.has_pending_sends() {
            if control_channel.drive().await.is_err() {
                return;
            }
        }
    })
    .await;
    if flushed.is_err() {
        warn!("timed out flushing control packets before teardown");
    }
}

pub async fn webrtc_loop(
    mut stream: MoonlightStream,
    peer: &RTCPeerConnection,
    mut audio_channel: AudioChannel,
    mut video_channel: VideoChannel,
    mut control_channel: ControlChannel,
) -> Result<(), AppError> {
    info!("started main webrtc loop");

    let mut moonlight_disconnected = false;
    let mut control_channel_active = false;
    loop {
        if !stream.is_alive() {
            info!("stopping stream because the moonlight stream is dead");
            flush_control_channel(&mut control_channel).await;
            break;
        }

        if matches!(
            peer.connection_state(),
            RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed
        ) && !moonlight_disconnected
        {
            let _ = stream.disconnect();
            moonlight_disconnected = true;
        }

        select! {
            result = stream.drive() => {
                if moonlight_disconnected {
                    continue;
                }

                let event = result?;

                match event {
                    MoonlightStreamEvent::Audio(AudioStreamEvent::OnFrame(frame)) => {
                        if !control_channel_active {
                            continue;
                        }

                        audio_channel.on_frame(frame);
                    }
                    MoonlightStreamEvent::Video(VideoStreamEvent::SignalIdr) => {
                        if let Err(err) = stream.send_raw(ControlPacket::RequestIdr) {
                            warn!(error = %err, "failed to send idr");
                        }
                    }
                    MoonlightStreamEvent::Video(VideoStreamEvent::OnFrame(frame)) => {
                        if !control_channel_active {
                            continue;
                        }

                        video_channel.on_frame(frame);
                    }
                    MoonlightStreamEvent::Control(ControlStreamEvent::Packet(packet)) => {
                        control_channel.send(packet);
                    }
                    _ => {}
                }
            }
            result = video_channel.drive() => {
                let event = result?;

                match event {
                    VideoChannelEvent::SignalIdr => {
                        if let Err(err) = stream.send_raw(ControlPacket::RequestIdr) {
                            warn!(error = %err, "failed to send idr");
                        }
                    }
                }
            }
            result = control_channel.drive() => {
                let event = result?;

                match event {
                    ControlChannelEvent::Active => {
                        control_channel_active = true;
                        debug!("control channel active");
                    },
                    ControlChannelEvent::Inactive => {
                        control_channel_active = false;
                        debug!("control channel inactive");
                    },
                    ControlChannelEvent::Packet(packet) => {
                        if let Err(err) = stream.send_raw(packet) {
                            warn!(error = %err, "failed to relay webrtc client packet to server");
                        }
                    },
                }
            }
        }
    }

    Ok(())
}
