//! Run on the target Windows host to check timer-limited pacing throughput:
//! cargo build --release --target x86_64-pc-windows-gnu --example pacing_probe
//! This isolates scheduling; it does not claim to test encoding or the network.

#[allow(dead_code)]
#[path = "../src/api/stream/webrtc/pacer.rs"]
mod pacer;

use std::time::{Duration, Instant};

#[tokio::main]
async fn main() {
    let mut passed = true;
    for bitrate in [40_000u32, 64_000] {
        let start = Instant::now();
        let mut pacing = pacer::VideoPacer::new(bitrate, start);
        let wire_bytes_per_frame = (bitrate as usize * 1000 / 8 / 60) * 1258 / 1194;
        let mut max_lag = Duration::ZERO;
        let mut waits = 0;
        for frame in 0..360u32 {
            let produced = start + Duration::from_secs_f64(f64::from(frame) / 60.0);
            tokio::time::sleep_until(produced.into()).await;
            let mut remaining = wire_bytes_per_frame;
            while remaining > 0 {
                let packet = remaining.min(1258);
                remaining -= packet;
                if let Some(deadline) = pacing.deadline(packet, Instant::now()) {
                    waits += 1;
                    tokio::time::sleep_until(deadline.into()).await;
                }
            }
            max_lag = max_lag.max(Instant::now().duration_since(produced));
        }
        println!(
            "bitrate_kbps={bitrate} frames=360 seconds={:.3} max_lag_ms={:.2} waits={waits}",
            start.elapsed().as_secs_f64(),
            max_lag.as_secs_f64() * 1000.0
        );
        passed &= max_lag < Duration::from_millis(60);
    }
    assert!(passed, "pacing accumulated more than 60 ms of delay");
}
