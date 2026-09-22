//! Keep NACK repairs from starving current game frames. Registered BEFORE
//! webrtc-rs's NACK responder, so its direct retransmissions also pass here.
use async_trait::async_trait;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use webrtc::{
    interceptor::{
        Attributes, Error, Interceptor, InterceptorBuilder, RTCPReader, RTCPWriter, RTPReader,
        RTPWriter, stream_info::StreamInfo,
    },
    rtp::packet::Packet,
};

const HISTORY: usize = 16384; // Larger than the upstream 8192-packet NACK cache.
const MAX_AGE: Duration = Duration::from_millis(250);
const RETRY_INTERVAL: Duration = Duration::from_millis(20);
const BURST: f64 = 8000.0;

#[derive(Clone, Copy)]
struct Sent {
    sequence: u16,
    timestamp: u32,
    at: Instant,
    repaired: Option<Instant>,
    retries: u8,
}

struct RepairBudget {
    history: Vec<Option<Sent>>,
    newest: Option<u16>,
    bytes_per_second: f64,
    tokens: f64,
    updated: Instant,
    report_at: Instant,
    allowed: u64,
    rejected: u64,
}

impl RepairBudget {
    fn new(bitrate_kbps: u32, now: Instant) -> Self {
        Self {
            history: vec![None; HISTORY],
            newest: None,
            // Fresh RTP already reserves 15% overhead; leave room for audio
            // inside the portal's 25% egress headroom. Never queue old repairs.
            bytes_per_second: f64::from(bitrate_kbps) * 1000.0 / 8.0 * 0.08,
            tokens: BURST,
            updated: now,
            report_at: now,
            allowed: 0,
            rejected: 0,
        }
    }

    fn allow(&mut self, seq: u16, timestamp: u32, bytes: usize, now: Instant) -> bool {
        let slot = &mut self.history[usize::from(seq) % HISTORY];
        if let Some(sent) = slot
            .as_mut()
            .filter(|s| s.sequence == seq && s.timestamp == timestamp)
        {
            self.tokens = (self.tokens
                + now.saturating_duration_since(self.updated).as_secs_f64()
                    * self.bytes_per_second)
                .min(BURST);
            self.updated = now;
            if now.saturating_duration_since(sent.at) > MAX_AGE
                || sent.retries >= 2
                || sent
                    .repaired
                    .is_some_and(|t| now.saturating_duration_since(t) < RETRY_INTERVAL)
                || self.tokens < bytes as f64
            {
                self.rejected += 1;
                return false;
            }
            self.tokens -= bytes as f64;
            sent.retries += 1;
            sent.repaired = Some(now);
            self.allowed += 1;
            return true;
        }
        // An evicted repair must not masquerade as a new packet. Originals
        // are serialized by the video relay; sequence numbers wrap at u16.
        if self
            .newest
            .is_some_and(|n| seq.wrapping_sub(n) >= 32768 || seq == n)
        {
            self.rejected += 1;
            return false;
        }
        self.newest = Some(seq);
        *slot = Some(Sent {
            sequence: seq,
            timestamp,
            at: now,
            repaired: None,
            retries: 0,
        });
        true
    }

    fn report(&mut self, now: Instant) {
        if now.saturating_duration_since(self.report_at) >= Duration::from_secs(10) {
            tracing::info!(
                repairs = self.allowed,
                suppressed_repairs = self.rejected,
                "video repair budget"
            );
            self.allowed = 0;
            self.rejected = 0;
            self.report_at = now;
        }
    }
}

pub(super) struct RepairGuard(pub u32);
impl InterceptorBuilder for RepairGuard {
    fn build(&self, _: &str) -> Result<Arc<dyn Interceptor + Send + Sync>, Error> {
        Ok(Arc::new(Self(self.0)))
    }
}

struct GuardedWriter {
    next: Arc<dyn RTPWriter + Send + Sync>,
    budget: Mutex<RepairBudget>,
}

#[async_trait]
impl RTPWriter for GuardedWriter {
    async fn write(&self, packet: &Packet, attributes: &Attributes) -> Result<usize, Error> {
        let allowed = {
            let mut budget = self.budget.lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            let allowed = budget.allow(
                packet.header.sequence_number,
                packet.header.timestamp,
                packet.payload.len() + 64,
                now,
            );
            budget.report(now);
            allowed
        };
        if allowed {
            self.next.write(packet, attributes).await
        } else {
            Ok(0)
        }
    }
}

#[async_trait]
impl Interceptor for RepairGuard {
    async fn bind_rtcp_reader(
        &self,
        reader: Arc<dyn RTCPReader + Send + Sync>,
    ) -> Arc<dyn RTCPReader + Send + Sync> {
        reader
    }
    async fn bind_rtcp_writer(
        &self,
        writer: Arc<dyn RTCPWriter + Send + Sync>,
    ) -> Arc<dyn RTCPWriter + Send + Sync> {
        writer
    }
    async fn bind_local_stream(
        &self,
        info: &StreamInfo,
        writer: Arc<dyn RTPWriter + Send + Sync>,
    ) -> Arc<dyn RTPWriter + Send + Sync> {
        if !info.mime_type.to_ascii_lowercase().starts_with("video/") {
            return writer;
        }
        Arc::new(GuardedWriter {
            next: writer,
            budget: Mutex::new(RepairBudget::new(self.0, Instant::now())),
        })
    }
    async fn unbind_local_stream(&self, _: &StreamInfo) {}
    async fn bind_remote_stream(
        &self,
        _: &StreamInfo,
        reader: Arc<dyn RTPReader + Send + Sync>,
    ) -> Arc<dyn RTPReader + Send + Sync> {
        reader
    }
    async fn unbind_remote_stream(&self, _: &StreamInfo) {}
    async fn close(&self) -> Result<(), Error> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recent_repairs_work_but_four_second_old_packets_do_not() {
        let start = Instant::now();
        let mut b = RepairBudget::new(40_000, start);
        assert!(b.allow(1, 1, 1258, start));
        assert!(b.allow(1, 1, 1258, start + Duration::from_millis(30)));
        assert!(!b.allow(1, 1, 1258, start + Duration::from_secs(4)));
        assert!(b.allow(2, 2, 1258, start + Duration::from_secs(4)));
    }
    #[test]
    fn storm_cannot_consume_the_upload_allowance_or_block_new_frames() {
        let start = Instant::now();
        let mut b = RepairBudget::new(40_000, start);
        for seq in 0..8192 {
            assert!(b.allow(seq, 1, 1258, start));
        }
        let repaired = (0..8192)
            .filter(|seq| b.allow(*seq, 1, 1258, start + Duration::from_millis(50)))
            .count();
        assert_eq!(repaired, 6);
        assert!(b.allow(8192, 2, 1258, start + Duration::from_millis(50)));
        let repaired = (0..8192)
            .filter(|seq| b.allow(*seq, 1, 1258, start + Duration::from_millis(70)))
            .count();
        assert!(repaired <= 7);
    }
    #[test]
    fn repeated_nacks_are_deduplicated_and_bounded() {
        let start = Instant::now();
        let mut b = RepairBudget::new(40_000, start);
        assert!(b.allow(1, 1, 1258, start));
        assert!(b.allow(1, 1, 1258, start + Duration::from_millis(30)));
        assert!(!b.allow(1, 1, 1258, start + Duration::from_millis(31)));
        assert!(b.allow(1, 1, 1258, start + Duration::from_millis(60)));
        assert!(!b.allow(1, 1, 1258, start + Duration::from_millis(90)));
    }
    #[test]
    fn originals_survive_sequence_wrap_and_evicted_repairs_stay_rejected() {
        let start = Instant::now();
        let mut b = RepairBudget::new(40_000, start);
        for i in 0..70000u32 {
            assert!(b.allow(i as u16, i, 1258, start));
        }
        assert!(!b.allow(
            69999u32.wrapping_sub(HISTORY as u32) as u16,
            69999 - HISTORY as u32,
            1258,
            start
        ));
        assert!(b.allow(
            69999u32 as u16,
            69999,
            1258,
            start + Duration::from_millis(30)
        ));
    }
}
