//! Two live sessions in a row with a real model, the way two recordings run:
//! start, feed speech, stop, start again. Reproduces "the local model could not run".
//!
//!   cargo run --release --example live_twice -- <models dir> parakeet speech.wav

use mtxt_recorder::audio::recorder::LiveFeed;
use mtxt_recorder::live::{LiveSession, LiveUpdate};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let mut args = std::env::args().skip(1);
    let dir = std::path::PathBuf::from(args.next().expect("models dir"));
    let model = args.next().unwrap_or_else(|| "parakeet".into());
    let wav = std::fs::read(args.next().expect("wav")).unwrap();
    let samples: Vec<f32> = wav[44..].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect();
    for round in 1..=3 {
        let feed = Arc::new(LiveFeed::default());
        let seen: Arc<Mutex<Vec<LiveUpdate>>> = Arc::default();
        let s2 = seen.clone();
        let session = LiveSession::start(dir.clone(), model.clone(), feed.clone(), 0.0, move |u| s2.lock().unwrap().push(u));
        std::thread::sleep(Duration::from_secs(6));
        for block in samples.chunks(1600) {
            if let Some(sink) = feed.sink.lock().unwrap().as_mut() {
                for s in block {
                    let _ = sink.push(*s);
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        std::thread::sleep(Duration::from_secs(3));
        let updates = seen.lock().unwrap().clone();
        let states: Vec<&str> = updates.iter().map(|u| u.state).collect();
        let text: Vec<String> = updates.iter().flat_map(|u| u.append.iter().chain(u.partial.iter())).map(|l| format!("{:.1}s {}", l.at_s, l.text)).collect();
        let reasons: Vec<String> = updates.iter().filter_map(|u| u.reason.clone()).collect();
        println!("round {round}: states {:?}; reasons {reasons:?}; text {:?}", states.iter().collect::<std::collections::BTreeSet<_>>(), text.last());
        session.stop();
    }
}
