//! Records a few seconds of microphone and system audio to a file and prints
//! the levels: a check of the capture path without the window.
//!
//!   cargo run --example capture_probe -- /tmp/probe.ogg 5

use mtxt_recorder::audio::recorder;
use std::sync::Arc;

fn main() {
    env_logger::init();
    let mut args = std::env::args().skip(1);
    let path = args.next().unwrap_or_else(|| "/tmp/mtxt-probe.ogg".into());
    let secs: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(5);
    println!("permissions: {:?}", mtxt_recorder::permissions::current());
    let rec = recorder::start(std::path::Path::new(&path), Arc::new(recorder::LiveFeed::default()), recorder::Wanted { microphone: true, system_audio: true }).expect("start");
    println!("sources: {:?}", rec.sources);
    let mut peak = (0f32, 0f32);
    for _ in 0..secs * 10 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        let (m, s) = rec.levels.get();
        peak = (peak.0.max(m), peak.1.max(s));
    }
    println!("peak meter: microphone {:.2}, system {:.2}", peak.0, peak.1);
    let duration = rec.finish().expect("finish").duration_s;
    println!("wrote {path}: {duration:.2} s");
}
