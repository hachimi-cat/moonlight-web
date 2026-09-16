use std::time::{Duration, Instant};

/// Pace small RTP batches, not complete encoded frames. Without pacing a
/// 40-Mbit/s frame is emitted at the socket's line rate, producing hundreds
/// of Mbit/s of short bursts even on an otherwise idle connection.
pub(super) struct VideoPacer {
    bytes_per_second: f64,
    burst_bytes: usize,
    batch_bytes: usize,
    next_batch: Instant,
}

const QUANTUM: Duration = Duration::from_millis(1);
// Tokio/Windows sleeps can wake 1–2 ms after their deadline. Preserve
// that small scheduling credit or a nominal 40-Mbit/s stream is throttled
// below its encoded rate and continually builds a stale-frame queue.
const MAX_CATCH_UP: Duration = Duration::from_millis(3);

impl VideoPacer {
    pub fn new(bitrate_kbps: u32, now: Instant) -> Self {
        // The setting is encoded payload. Leave 15% for RTP/UDP/SRTP
        // overhead, below the portal's 25% egress headroom; audio/control
        // remain independent and must not queue behind video.
        let bytes_per_second = f64::from(bitrate_kbps.max(100)) * 1000.0 / 8.0 * 1.15;
        Self {
            bytes_per_second,
            burst_bytes: (bytes_per_second * QUANTUM.as_secs_f64()).max(1500.0) as usize,
            batch_bytes: 0,
            next_batch: now,
        }
    }

    pub fn deadline(&mut self, wire_bytes: usize, now: Instant) -> Option<Instant> {
        if self.batch_bytes != 0 && self.batch_bytes + wire_bytes > self.burst_bytes {
            self.next_batch +=
                Duration::from_secs_f64(self.batch_bytes as f64 / self.bytes_per_second);
            self.batch_bytes = 0;
        }
        // Idle time or a late Windows timer is not permission to dump a
        // backlog at line rate. Permit only a few milliseconds of credit,
        // enough for Windows timer overshoot, never a complete frame burst.
        self.next_batch = self.next_batch.max(now - MAX_CATCH_UP);
        self.batch_bytes += wire_bytes;
        (self.next_batch > now).then_some(self.next_batch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forty_mbit_frame_is_spread_out_instead_of_a_single_burst() {
        let start = Instant::now();
        let mut now = start;
        let mut pacer = VideoPacer::new(40_000, start);
        for _ in 0..70 {
            if let Some(deadline) = pacer.deadline(1258, now) {
                now = deadline;
            }
        }
        assert!(now - start > Duration::from_millis(12));
        assert!(now - start < Duration::from_millis(17));
    }

    #[test]
    fn idle_time_does_not_accumulate_unlimited_burst_credit() {
        let start = Instant::now();
        let now = start + Duration::from_secs(10);
        let mut pacer = VideoPacer::new(40_000, start);
        let mut immediate = 0;
        while pacer.deadline(1258, now).is_none() {
            immediate += 1;
            assert!(immediate < 30);
        }
        assert!(immediate <= 16, "at most four small batches after a stall");
    }

    #[test]
    fn windows_timer_overshoot_does_not_throttle_sustained_video() {
        for bitrate in [40_000u32, 64_000] {
            let start = Instant::now();
            let mut now = start;
            let mut pacer = VideoPacer::new(bitrate, start);
            let wire_bytes_per_frame = (bitrate as usize * 1000 / 8 / 60) * 1258 / 1194;
            let mut max_lag = Duration::ZERO;
            for frame in 0..360u32 {
                let produced = start + Duration::from_secs_f64(f64::from(frame) / 60.0);
                now = now.max(produced);
                let mut remaining = wire_bytes_per_frame;
                while remaining > 0 {
                    let packet = remaining.min(1258);
                    remaining -= packet;
                    if let Some(deadline) = pacer.deadline(packet, now) {
                        now = deadline + Duration::from_millis(2);
                    }
                }
                max_lag = max_lag.max(now.duration_since(produced));
            }
            assert!(
                max_lag < Duration::from_millis(30),
                "{bitrate} kbps accumulated {max_lag:?}"
            );
        }
    }
}

#[derive(Debug, PartialEq)]
pub(super) enum FrameDecision {
    Send,
    Drop,
    Resync,
}

#[derive(Default)]
pub(super) struct FrameGate {
    awaiting_keyframe: bool,
}

impl FrameGate {
    pub fn inspect(&mut self, overflowed: bool, age: Duration, keyframe: bool) -> FrameDecision {
        if overflowed || age > Duration::from_millis(150) {
            self.awaiting_keyframe = true;
            return FrameDecision::Resync;
        }
        if self.awaiting_keyframe && !keyframe {
            return FrameDecision::Drop;
        }
        self.awaiting_keyframe = false;
        FrameDecision::Send
    }
}

#[cfg(test)]
mod frame_tests {
    use super::*;

    #[test]
    fn overflow_drops_dependent_frames_until_a_fresh_keyframe() {
        let mut gate = FrameGate::default();
        assert_eq!(
            gate.inspect(false, Duration::ZERO, false),
            FrameDecision::Send
        );
        assert_eq!(
            gate.inspect(true, Duration::ZERO, false),
            FrameDecision::Resync
        );
        assert_eq!(
            gate.inspect(false, Duration::ZERO, false),
            FrameDecision::Drop
        );
        assert_eq!(
            gate.inspect(false, Duration::ZERO, true),
            FrameDecision::Send
        );
        assert_eq!(
            gate.inspect(false, Duration::ZERO, false),
            FrameDecision::Send
        );
    }

    #[test]
    fn even_a_keyframe_must_not_replay_a_stale_picture() {
        let mut gate = FrameGate::default();
        assert_eq!(
            gate.inspect(false, Duration::from_millis(151), true),
            FrameDecision::Resync
        );
        assert_eq!(
            gate.inspect(false, Duration::ZERO, false),
            FrameDecision::Drop
        );
    }
}
