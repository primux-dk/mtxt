//! The recorder's whole path against a running install, without the window:
//! connect through the browser, record (or encode a speech file), upload in
//! chunks, and poll until the library has transcribed it. For the manual run
//! of packet 9 and for checking an install after a deploy.
//!
//!   cargo run --release --example manual_run -- http://localhost:8788 --wav speech.wav --title "Manual run"
//!   cargo run --release --example manual_run -- https://app.mtxt.co --capture 60
//!
//! `--capture N` records N seconds of microphone and system audio (macOS asks
//! for both permissions the first time); `--wav` encodes a 16-bit WAV instead.
//! The token is kept in memory only.

use mtxt_recorder::api::{Api, PollResult};
use mtxt_recorder::audio::{ogg_opus, recorder};
use mtxt_recorder::connect::{self, Pkce};
use mtxt_recorder::queue::chunks::hash_file;
use mtxt_recorder::queue::state::{Event, RecordingState, Status};
use mtxt_recorder::queue::uploader::{attempt, refresh_server_status};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let host = connect::normalise_host(args.first().expect("host")).expect("a host");
    let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let title = flag("--title").unwrap_or_else(|| "Manual run of the desktop recorder".into());
    let api = Api::new(&host).unwrap();

    // 1. Connect.
    let pkce = Pkce::generate();
    let url = connect::connect_url(&host, &pkce.challenge, &connect::device_name("Manual run"));
    println!("pairing code {}", connect::pairing_code(&pkce.challenge));
    println!("approve at {url}");
    let started = Instant::now();
    let token = loop {
        match api.poll_token(&pkce).await {
            PollResult::Token(t) => break t,
            PollResult::Pending { retry_after } | PollResult::RateLimited { retry_after } => {
                tokio::time::sleep(Duration::from_secs(retry_after)).await
            }
            PollResult::TryAgain => tokio::time::sleep(Duration::from_secs(2)).await,
            other => panic!("connect failed: {other:?}"),
        }
        assert!(started.elapsed() < Duration::from_secs(600), "not approved in 10 minutes");
    };
    println!(
        "connected as {} <{}> (user {}) to {} (accent {}, language {:?}, live default {:?})",
        token.user.name,
        token.user.email,
        token.user.id, token.install.product_name, token.install.theme_accent, token.install.interface_language, token.install.live_transcript_default
    );

    // 2. Record, or encode a WAV.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("recording.ogg");
    let started_at = chrono::Utc::now();
    if let Some(secs) = flag("--capture").and_then(|s| s.parse::<u64>().ok()) {
        println!("permissions {:?}", mtxt_recorder::permissions::current());
        let rec = recorder::start(&path, Arc::new(recorder::LiveFeed::default()), recorder::Wanted { microphone: true, system_audio: true })
            .expect("start");
        println!("sources {:?}", rec.sources);
        let mut peak = (0f32, 0f32);
        for _ in 0..secs * 10 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let (m, s) = rec.levels.get();
            peak = (peak.0.max(m), peak.1.max(s));
        }
        println!("peak meter: microphone {:.2}, system {:.2}", peak.0, peak.1);
        let done = rec.finish().expect("finish");
        println!("gaps {:?}", done.gaps);
    } else {
        let wav = std::fs::read(flag("--wav").expect("--wav or --capture")).unwrap();
        let samples: Vec<f32> = wav[44..].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect();
        // A 16 kHz WAV up to 48 kHz, the same speech on both channels.
        let mut up = Vec::new();
        mtxt_recorder::audio::resample::Resampler::new(16_000, 48_000).process(&samples, &mut up);
        let mut w = ogg_opus::OggOpusWriter::create(&path).unwrap();
        for frame in up.chunks(ogg_opus::FRAME) {
            let mut stereo = vec![0f32; ogg_opus::FRAME * 2];
            for (i, s) in frame.iter().enumerate() {
                stereo[2 * i] = *s;
                stereo[2 * i + 1] = *s;
            }
            w.write_frame(&stereo).unwrap();
        }
        w.finish().unwrap();
    }
    let duration = ogg_opus::duration_of(&path).unwrap();
    let (sha256, size) = hash_file(&path).unwrap();
    println!("file {:.1} s, {size} bytes, sha256 {sha256}", duration);

    // 3. Upload.
    let mut rec = RecordingState::new(uuid::Uuid::new_v4().to_string(), host.clone(), title, started_at);
    rec.owner = Some(mtxt_recorder::queue::state::Owner { user_id: token.user.id.clone(), email: token.user.email.clone() });
    rec.apply(Event::Stopped { at: chrono::Utc::now(), duration_s: duration.round() as u64, sha256, size_bytes: size }, chrono::Utc::now());
    loop {
        let outcome = attempt(&mut rec, &api, &token.token, &path, &mut |r: &RecordingState| {
            let (d, t) = r.progress();
            println!("  {:?} {d}/{t}", r.status);
            Ok(())
        })
        .await;
        println!("attempt: {outcome:?} ({:?})", rec.pending_reason);
        if rec.status == Status::Confirmed {
            break;
        }
        assert!(rec.due(chrono::Utc::now() + chrono::Duration::minutes(10)), "not retryable: {:?}", rec.pending_reason);
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    println!("confirmed at {:?}, recording {:?}, meeting {:?}", rec.confirmed_at, rec.server_recording_id, rec.server_meeting_id);

    // 4. Poll until the library has the transcript.
    let poll_started = Instant::now();
    while poll_started.elapsed() < Duration::from_secs(300) {
        refresh_server_status(&mut rec, &api, &token.token).await.unwrap();
        println!("server status {:?}", rec.server_status);
        if matches!(rec.server_status.as_deref(), Some("transcribed") | Some("failed")) {
            break;
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    println!("meeting {host}/meetings/{}", rec.server_meeting_id.clone().unwrap_or_default());

    // 5. Disconnect.
    api.revoke(&token.token, &token.token_id).await.expect("revoke");
    println!("disconnected (token {} revoked)", token.token_id);
}
