use moonlight_common::{
    AppId, ServerVersion,
    high::tokio::MoonlightHost,
    stream::{
        MoonlightStreamSettings, proto::control::packet::ControlPacketConfig, video::VideoFormats,
    },
};
use std::{sync::Arc, time::Duration};
use tokio::time::sleep;
use tracing::{info, warn};

use crate::api::bindings::StreamPermissions;
use crate::app::{AppError, RequestClient};

pub mod web_socket;
pub mod webrtc;

fn server_version() -> ServerVersion {
    ServerVersion::new(7, 0, 0, 0)
}
fn create_control_packet_config(encrypted: bool) -> ControlPacketConfig {
    ControlPacketConfig::new(server_version(), encrypted).expect("control packet config")
}

/// Stop a different app before asking Apollo to launch the selected one.
///
/// Apollo treats /launch while any app is current as "resume that session",
/// even when the request names a different app. That made the sequence
/// Desktop -> close browser tab -> game cover reconnect to Desktop forever.
/// Native clients expose an explicit Stop action first; direct Pawpado cover
/// links do not, so enforce the transition at the streaming boundary shared
/// by both transports.
async fn stop_conflicting_app(
    host: &Arc<MoonlightHost<RequestClient>>,
    requested_app: AppId,
) -> Result<(), AppError> {
    let current_app = host.server_info().await?.current_game;
    if current_app == 0 || current_app == requested_app.0 {
        return Ok(());
    }

    info!(
        current_app,
        requested_app = requested_app.0,
        "stopping current app before launch"
    );
    if !host.cancel().await? {
        warn!(
            current_app,
            requested_app = requested_app.0,
            "host rejected current app stop request"
        );
    }

    // Do not race Apollo's asynchronous app cleanup with /launch. Launching
    // while current_game still names Desktop simply resumes Desktop again.
    for _ in 0..48 {
        sleep(Duration::from_millis(250)).await;
        let current_app = host.server_info().await?.current_game;
        if current_app == 0 || current_app == requested_app.0 {
            return Ok(());
        }
    }

    Err(AppError::HostAppSwitchTimeout)
}

/// IMPORTANT: This doesn't handle transport restrictions!
pub fn apply_role_restrictions(
    permissions: &StreamPermissions,
    settings: &mut MoonlightStreamSettings,
) {
    let StreamPermissions {
        allow_add_hosts: _,
        maximum_bitrate_kbps,
        allow_codec_h264,
        allow_codec_h265,
        allow_codec_av1,
        allow_hdr,
        allow_transport_webrtc: _,
        allow_transport_websockets: _,
    } = permissions;

    if let Some(maximum_bitrate) = maximum_bitrate_kbps
        && settings.bitrate > *maximum_bitrate
    {
        settings.bitrate = *maximum_bitrate;
    }

    let mut supported_formats = settings.supported_video_formats;
    if !allow_codec_h264 {
        supported_formats &= !VideoFormats::MASK_H264;
    }
    if !allow_codec_h265 {
        supported_formats &= !VideoFormats::MASK_H265;
    }
    if !allow_codec_av1 {
        supported_formats &= !VideoFormats::MASK_AV1;
    }
    settings.supported_video_formats = supported_formats;

    if !allow_hdr {
        settings.hdr = false;
    }
}
