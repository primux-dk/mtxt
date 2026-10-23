//! Transcribes a 16 kHz mono WAV file with one of the local models:
//! a check of the live engines without the window.
//!
//!   cargo run --release --example live_probe -- <models dir> parakeet speech.wav

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = std::path::PathBuf::from(args.next().expect("models dir"));
    let model = args.next().unwrap_or_else(|| "parakeet".into());
    let wav = args.next().expect("wav file");
    let bytes = std::fs::read(&wav).unwrap();
    // A canonical 44-byte header, then 16-bit samples.
    let samples: Vec<f32> = bytes[44..].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect();
    let t = std::time::Instant::now();
    let mut engine = mtxt_recorder::live::load_engine(&dir, &model).expect("load");
    println!("loaded {model} in {:?}", t.elapsed());
    let t = std::time::Instant::now();
    let text = engine.transcribe(&samples).expect("transcribe");
    println!("{:.1} s of audio in {:?}: {text}", samples.len() as f32 / 16000.0, t.elapsed());
}
