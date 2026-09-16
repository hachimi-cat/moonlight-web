use std::{
    collections::HashMap,
    mem::swap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use bytes::Bytes;
use moonlight_common::{
    stream::{
        proto::video::frame::OwnedVideoFrame,
        video::{FrameType, VideoFormat, VideoFormats, VideoSetup},
    },
    webrtc::sdp::Session,
};
use tokio::{
    select, spawn,
    sync::{
        Notify,
        mpsc::{Sender, channel},
    },
};
use tracing::{Instrument, debug, debug_span, info, warn};
use webrtc::{
    api::media_engine::{MIME_TYPE_AV1, MIME_TYPE_H264, MIME_TYPE_HEVC},
    peer_connection::RTCPeerConnection,
    rtcp::payload_feedbacks::{
        picture_loss_indication::PictureLossIndication,
        receiver_estimated_maximum_bitrate::ReceiverEstimatedMaximumBitrate,
    },
    rtp::{
        codecs::{
            av1::Av1Payloader,
            h264::H264Payloader,
            h265::{HevcPayloader, RTP_OUTBOUND_MTU},
        },
        extension::{HeaderExtension, playout_delay_extension::PlayoutDelayExtension},
        header::Header,
        packet::Packet,
        packetizer::Payloader,
    },
    rtp_transceiver::{
        RTCPFeedback,
        rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters},
        rtp_sender::RTCRtpSender,
    },
    track::track_local::track_local_static_rtp::TrackLocalStaticRTP,
};

use super::pacer::{FrameDecision, FrameGate, VideoPacer};
use crate::app::AppError;

struct QueuedFrame {
    frame: OwnedVideoFrame,
    received_at: Instant,
}

pub enum VideoChannelEvent {
    SignalIdr,
}

enum State {
    SelectVideoFormat,
    Panic,
    Sending {
        rtcp_buffer: Vec<u8>,
        rtcp_receiver: Arc<RTCRtpSender>,
        frame_sender: Sender<QueuedFrame>,
        overflowed: Arc<AtomicBool>,
        request_idr: Arc<Notify>,
    },
}

pub struct VideoChannel {
    video_formats: HashMap<VideoFormat, RTCRtpCodecParameters>,
    state: State,
}

impl VideoChannel {
    pub fn new(sdp: &Session) -> Result<Self, AppError> {
        let video_formats_mapping = get_video_formats(sdp);

        Ok(Self {
            video_formats: video_formats_mapping,
            state: State::SelectVideoFormat,
        })
    }

    pub fn supported_video_formats(&self) -> &HashMap<VideoFormat, RTCRtpCodecParameters> {
        &self.video_formats
    }

    pub async fn on_video_format_selected(
        &mut self,
        setup: VideoSetup,
        peer: &RTCPeerConnection,
        bitrate_kbps: u32,
    ) -> Result<(), AppError> {
        let mut new_state = State::Panic;
        swap(&mut new_state, &mut self.state);

        // Check video format
        let format = setup.format;
        let Some(codec) = self.video_formats.remove(&format) else {
            return Err(AppError::WebRtcClientCodecNotSupported);
        };

        // Create video track
        let clock_rate = codec.capability.clock_rate;
        let track = Arc::new(TrackLocalStaticRTP::new(
            codec.capability.clone(),
            "video".to_string(),
            "moonlight".to_string(),
        ));

        let video_sender = peer.add_track(track.clone()).await?;

        let mut payloader = if format.contained_in(VideoFormats::MASK_H264) {
            Box::new(H264Payloader::default()) as Box<dyn Payloader + Send + Sync>
        } else if format.contained_in(VideoFormats::MASK_H265) {
            Box::new(HevcPayloader::default()) as Box<dyn Payloader + Send + Sync>
        } else {
            Box::new(Av1Payloader::default()) as Box<dyn Payloader + Send + Sync>
        };

        let (frame_sender, mut frame_receiver) = channel::<QueuedFrame>(8);
        let overflowed = Arc::new(AtomicBool::new(false));
        let request_idr = Arc::new(Notify::new());

        self.state = State::Sending {
            rtcp_buffer: vec![0u8; 1500],
            rtcp_receiver: video_sender,
            frame_sender,
            overflowed: overflowed.clone(),
            request_idr: request_idr.clone(),
        };

        spawn(
            async move {
                let mut sequence_number = 0u16;
                let mut binding_was_paused = false;
                let mut next_send_warning_at = Instant::now();
                let mut suppressed_send_failures = 0u64;
                let mut pacer = VideoPacer::new(bitrate_kbps, Instant::now());
                let mut frame_gate = FrameGate::default();
                let mut metrics = RelayMetrics::new();

                while let Some(queued) = frame_receiver.recv().await {
                    let frame = queued.frame.as_ref();
                    metrics.frame(&queued);
                    let decision = frame_gate.inspect(
                        overflowed.swap(false, Ordering::Relaxed),
                        queued.received_at.elapsed(),
                        frame.parsed_frame_type == FrameType::Idr,
                    );
                    if decision == FrameDecision::Resync {
                        // Never build seconds of picture/input latency. Once a
                        // delta is discarded its dependents are unusable too:
                        // clear stale work and resume only at a fresh keyframe.
                        while frame_receiver.try_recv().is_ok() {}
                        pacer = VideoPacer::new(bitrate_kbps, Instant::now());
                        request_idr.notify_one();
                        warn!("video relay fell behind; discard stale frames and request keyframe");
                        continue;
                    }
                    if decision == FrameDecision::Drop {
                        continue;
                    }

                    // Micros, not millis: at a 90kHz clock a millisecond is
                    // 90 ticks, so ms truncation quantizes every frame's
                    // timestamp and shows up as synthetic jitter at the
                    // receiver.
                    let timestamp = (frame.metadata.timestamp.as_micros() * clock_rate as u128
                        / 1_000_000) as u32;

                    if track.all_binding_paused().await {
                        if !binding_was_paused {
                            debug!(
                                "video track bindings paused; dropping frames until they resume"
                            );
                            binding_was_paused = true;
                        }
                        // A binding can be paused transiently while the peer remains
                        // alive. Ending this task here made that pause permanent: the
                        // control/ICE connection stayed connected but no video packet
                        // could ever be sent again. Drop frames without advancing the
                        // RTP sequence number, then check again on the next frame.
                        continue;
                    }
                    if binding_was_paused {
                        debug!("video track bindings resumed");
                        binding_was_paused = false;
                    }

                    let mut payloads = Vec::with_capacity(10);

                    // Each buffer is one nal
                    for buffer in &frame.buffers {
                        let nal_payloads = payloader
                            .payload(RTP_OUTBOUND_MTU, &Bytes::copy_from_slice(buffer.data))
                            .expect("failed to payload frame");

                        payloads.extend(nal_payloads);
                    }

                    let len = payloads.len();
                    for (i, payload) in payloads.into_iter().enumerate() {
                        // Include IPv4/UDP/RTP/SRTP/extensions in the budget.
                        if let Some(deadline) = pacer.deadline(payload.len() + 64, Instant::now()) {
                            tokio::time::sleep_until(deadline.into()).await;
                            metrics.max_timer_late = metrics
                                .max_timer_late
                                .max(Instant::now().saturating_duration_since(deadline));
                        }
                        sequence_number = sequence_number.wrapping_add(1);

                        let write_started = Instant::now();
                        if let Err(err) = track
                            .write_rtp_with_extensions(
                                &Packet {
                                    header: Header {
                                        version: 2,
                                        // Marker needs to mark the end of one frame
                                        marker: i == len - 1,
                                        sequence_number,
                                        timestamp,
                                        payload_type: codec.payload_type,
                                        ..Default::default()
                                    },
                                    payload,
                                },
                                &[HeaderExtension::PlayoutDelay(PlayoutDelayExtension {
                                    min_delay: 0,
                                    max_delay: 0,
                                })],
                            )
                            .await
                        {
                            // An ICE restart temporarily closes the selected
                            // UDP route. Continuing through every payload of
                            // the frame produced thousands of identical
                            // WSAENETUNREACH lines per second and made the
                            // recovery itself compete with the stream. Once
                            // one RTP packet failed, the frame is unusable;
                            // drop its remaining payloads and rate-limit the
                            // operational warning.
                            let now = Instant::now();
                            if now >= next_send_warning_at {
                                warn!(
                                    error = %err,
                                    suppressed = suppressed_send_failures,
                                    "failed to send video frame"
                                );
                                suppressed_send_failures = 0;
                                next_send_warning_at = now + Duration::from_secs(5);
                            } else {
                                suppressed_send_failures += 1;
                            }
                            break;
                        }
                        metrics.max_write = metrics.max_write.max(write_started.elapsed());
                    }
                    metrics.report();
                }
            }
            .instrument(debug_span!("video frame relay")),
        );

        info!(setup = ?setup, codec = ?codec, "finished video track setup");

        Ok(())
    }

    pub fn on_frame(&mut self, frame: OwnedVideoFrame) {
        match &mut self.state {
            State::SelectVideoFormat | State::Panic => {
                panic!("VideoChannel is in an invalid state")
            }
            State::Sending {
                frame_sender,
                overflowed,
                ..
            } => {
                if frame_sender
                    .try_send(QueuedFrame {
                        frame,
                        received_at: Instant::now(),
                    })
                    .is_err()
                {
                    overflowed.store(true, Ordering::Relaxed);
                }
            }
        }
    }

    pub async fn drive(&mut self) -> Result<VideoChannelEvent, AppError> {
        loop {
            let State::Sending {
                rtcp_buffer,
                rtcp_receiver,
                request_idr,
                ..
            } = &mut self.state
            else {
                panic!("VideoChannel is in an invalid state");
            };

            select! {
                _ = request_idr.notified() => return Ok(VideoChannelEvent::SignalIdr),
                // This function seems cancel safe
                result = rtcp_receiver.read(rtcp_buffer) => {
                    let Ok((packets, _)) = result else {
                        continue;
                    };

                    for packet in packets {
                        let packet = packet.as_any();

                        if packet.downcast_ref::<PictureLossIndication>().is_some() {
                            debug!("got picture loss indication, set need idr flag");
                            return Ok(VideoChannelEvent::SignalIdr);
                        } else if let Some(ReceiverEstimatedMaximumBitrate { bitrate: _, .. }) =
                            packet.downcast_ref::<ReceiverEstimatedMaximumBitrate>()
                        {
                            // TODO
                        }
                    }
                }
            }
        }
    }
}

/// Low-volume host evidence: distinguish an encoder pause, relay backlog,
/// Windows timer delay, and a blocked network write without packet contents.
struct RelayMetrics {
    since: Instant,
    last_received: Option<Instant>,
    frames: u64,
    bytes: usize,
    max_frame_bytes: usize,
    max_arrival_gap: Duration,
    max_queue: Duration,
    max_timer_late: Duration,
    max_write: Duration,
}

impl RelayMetrics {
    fn new() -> Self {
        Self {
            since: Instant::now(),
            last_received: None,
            frames: 0,
            bytes: 0,
            max_frame_bytes: 0,
            max_arrival_gap: Duration::ZERO,
            max_queue: Duration::ZERO,
            max_timer_late: Duration::ZERO,
            max_write: Duration::ZERO,
        }
    }

    fn frame(&mut self, queued: &QueuedFrame) {
        let bytes = queued
            .frame
            .as_ref()
            .buffers
            .iter()
            .map(|b| b.data.len())
            .sum();
        self.bytes += bytes;
        self.max_frame_bytes = self.max_frame_bytes.max(bytes);
        self.frames += 1;
        self.max_queue = self.max_queue.max(queued.received_at.elapsed());
        if let Some(previous) = self.last_received {
            self.max_arrival_gap = self
                .max_arrival_gap
                .max(queued.received_at.saturating_duration_since(previous));
        }
        self.last_received = Some(queued.received_at);
    }

    fn report(&mut self) {
        let elapsed = self.since.elapsed().as_secs_f64();
        if elapsed < 10.0 {
            return;
        }
        info!(
            fps = self.frames as f64 / elapsed,
            encoded_mbps = self.bytes as f64 * 8.0 / elapsed / 1_000_000.0,
            max_frame_bytes = self.max_frame_bytes,
            arrival_gap_ms = self.max_arrival_gap.as_secs_f64() * 1000.0,
            queue_ms = self.max_queue.as_secs_f64() * 1000.0,
            timer_late_ms = self.max_timer_late.as_secs_f64() * 1000.0,
            write_ms = self.max_write.as_secs_f64() * 1000.0,
            "video relay timing"
        );
        let last_received = self.last_received;
        *self = Self::new();
        self.last_received = last_received;
    }
}

fn get_video_formats(sdp: &Session) -> HashMap<VideoFormat, RTCRtpCodecParameters> {
    let mut formats = HashMap::default();

    // -- Find and extract codec and sdp fmtp line
    let mut codec_and_clock_rate = HashMap::<_, (&str, _)>::default();
    let mut sdp_fmtp_lines = HashMap::<_, &str>::default();

    for media in &sdp.medias {
        for attribute in &media.attributes {
            let Some(value) = &attribute.value else {
                continue;
            };

            match attribute.attribute.as_str() {
                "rtpmap" => {
                    let Some((pt, codec, clock_rate)) = parse_rtpmap(value) else {
                        warn!(attribute = ?attribute, "failed to parse rtpmap");
                        continue;
                    };

                    codec_and_clock_rate.insert(pt, (codec, clock_rate));
                }
                "fmtp" => {
                    let Some((pt, sdp_fmtp_line)) = parse_fmtp(value) else {
                        warn!(attribute = ?attribute, "failed to parse fmtp");
                        continue;
                    };

                    sdp_fmtp_lines.insert(pt, sdp_fmtp_line);
                }
                _ => {}
            }
        }
    }

    // -- Add all recognized codecs
    for (pt, (codec, clock_rate)) in &codec_and_clock_rate {
        let sdp_fmtp_line = sdp_fmtp_lines.get(pt).unwrap_or(&"");
        debug!(pt = *pt, codec = ?codec, clock_rate = ?clock_rate, sdp_fmtp_line = ?sdp_fmtp_line, "got codec");

        if codec.eq_ignore_ascii_case("H264") {
            if !sdp_fmtp_line.contains("packetization-mode=1") {
                // Single NAL mode is not supported
                continue;
            }

            // Get profile
            let mut format = VideoFormat::H264;

            let attributes = sdp_fmtp_line.split(";");
            for (attribute, value) in attributes.filter_map(|attribute| attribute.split_once("=")) {
                if attribute == "profile-level-id" {
                    if value.starts_with("64") {
                        format = VideoFormat::H264;
                    } else if value.starts_with("f4") {
                        format = VideoFormat::H264High8_444;
                    } else {
                        debug!(profile_level_id = ?value, "found unknown h264 profile-level-id");
                    }
                }
            }

            formats.insert(
                format,
                RTCRtpCodecParameters {
                    capability: RTCRtpCodecCapability {
                        mime_type: MIME_TYPE_H264.to_string(),
                        sdp_fmtp_line: sdp_fmtp_line.to_string(),
                        clock_rate: *clock_rate,
                        rtcp_feedback: rtcp_feedback(),
                        ..Default::default()
                    },
                    payload_type: *pt,
                    ..Default::default()
                },
            );
        } else if codec.eq_ignore_ascii_case("H265") {
            // Get profile
            let mut format = VideoFormat::H265;

            let attributes = sdp_fmtp_line.split(";");
            for (attribute, value) in attributes.filter_map(|attribute| attribute.split_once("=")) {
                if attribute == "profile-id" {
                    match value {
                        "1" => format = VideoFormat::H265,
                        "2" => format = VideoFormat::H265Main10,
                        "4" => {
                            // TODO: range extensions
                        }
                        _ => debug!(profile_id = ?value, "unknown h265 profile-id"),
                    }
                }
            }

            formats.insert(
                format,
                RTCRtpCodecParameters {
                    capability: RTCRtpCodecCapability {
                        mime_type: MIME_TYPE_HEVC.to_string(),
                        sdp_fmtp_line: sdp_fmtp_line.to_string(),
                        clock_rate: *clock_rate,
                        rtcp_feedback: rtcp_feedback(),
                        ..Default::default()
                    },
                    payload_type: *pt,
                    ..Default::default()
                },
            );
        } else if codec.eq_ignore_ascii_case("AV1") {
            // Get profile
            let mut format = VideoFormat::Av1Main8;

            let attributes = sdp_fmtp_line.split(";");
            for (attribute, value) in attributes.filter_map(|attribute| attribute.split_once("=")) {
                if attribute == "profile" {
                    match value {
                        "1" => format = VideoFormat::Av1Main8,
                        "2" => format = VideoFormat::Av1High8_444,
                        // TODO: how do the Main10 / High10 profiles work?
                        _ => debug!(profile = ?value, "unknown av1 profile"),
                    }
                }
            }

            formats.insert(
                format,
                RTCRtpCodecParameters {
                    capability: RTCRtpCodecCapability {
                        mime_type: MIME_TYPE_AV1.to_string(),
                        sdp_fmtp_line: sdp_fmtp_line.to_string(),
                        clock_rate: *clock_rate,
                        rtcp_feedback: rtcp_feedback(),
                        ..Default::default()
                    },
                    payload_type: *pt,
                    ..Default::default()
                },
            );
        }
    }

    // Browser support includes software decoders. Apollo otherwise prefers
    // High 4:4:4 over ordinary H.264, even when the latter is hardware-decoded.
    // Keep interactive streaming on 4:2:0 instead of silently spending the
    // client's CPU on a more expensive chroma format. Preserve HEVC/HDR.
    formats.remove(&VideoFormat::H264High8_444);

    debug!(formats = ?formats, "found video codecs");

    formats
}
fn parse_rtpmap(attribute_value: &str) -> Option<(u8, &str, u32)> {
    let (pt_str, full_codec) = attribute_value.split_once(' ')?;
    let pt = pt_str.parse::<u8>().ok()?;

    // identify codec
    let (codec_str, clock_rate_str) = full_codec.split_once('/')?;

    let clock_rate = clock_rate_str.parse::<u32>().ok()?;

    Some((pt, codec_str, clock_rate))
}
fn parse_fmtp(attribute_value: &str) -> Option<(u8, &str)> {
    let (pt_str, sdp_fmtp_line) = attribute_value.split_once(' ')?;
    let pt = pt_str.parse::<u8>().ok()?;

    Some((pt, sdp_fmtp_line))
}

fn rtcp_feedback() -> Vec<RTCPFeedback> {
    vec![
        RTCPFeedback {
            // negative acknowledgement
            typ: "nack".to_string(),
            parameter: "".to_string(),
        },
        RTCPFeedback {
            // picture loss indicator (idr)
            typ: "nack".to_string(),
            parameter: "pli".to_string(),
        },
        RTCPFeedback {
            // receiver estimated maximum bitrate
            typ: "goog-remb".to_string(),
            parameter: "".to_string(),
        },
    ]
}

#[cfg(test)]
mod codec_tests {
    use super::*;

    #[test]
    fn browser_h264_offer_must_not_select_the_software_444_profile() {
        let sdp = Session::parse(b"v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96 97 98\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 packetization-mode=1;profile-level-id=640c1f\r\na=rtpmap:97 H264/90000\r\na=fmtp:97 packetization-mode=1;profile-level-id=f4001f\r\na=rtpmap:98 H265/90000\r\na=fmtp:98 profile-id=1\r\n").expect("valid offer");
        let formats = get_video_formats(&sdp);
        assert!(formats.contains_key(&VideoFormat::H264));
        assert!(formats.contains_key(&VideoFormat::H265));
        assert!(!formats.contains_key(&VideoFormat::H264High8_444));
    }
}
