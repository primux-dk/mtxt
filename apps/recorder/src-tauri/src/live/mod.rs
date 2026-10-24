//! The live transcript: a local model reading the 16 kHz mono mix while a
//! recording runs. A preview only. Its text lives in memory, goes to the live
//! window, and is dropped when the recording stops; nothing of it is uploaded
//! or written to disk.

pub mod models;
#[cfg(all(feature = "parakeet", any(target_arch = "aarch64", target_os = "windows")))]
pub mod parakeet;
pub mod segmenter;
#[cfg(feature = "whisper")]
pub mod whisper;

use crate::audio::recorder::LiveFeed;
use segmenter::{Cut, Segmenter};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

pub trait Engine: Send {
    fn transcribe(&mut self, audio: &[f32]) -> Result<String, String>;
}

pub fn load_engine(models_dir: &std::path::Path, id: &str) -> Result<Box<dyn Engine>, String> {
    let spec = models::spec(id).ok_or("unknown model")?;
    if !models::is_downloaded(models_dir, spec) {
        return Err("not downloaded".into());
    }
    let dir = models::dir(models_dir, spec);
    match id {
        #[cfg(all(feature = "parakeet", any(target_arch = "aarch64", target_os = "windows")))]
        "parakeet" => parakeet::Parakeet::load(&dir).map(|e| Box::new(e) as Box<dyn Engine>).map_err(|e| e.to_string()),
        #[cfg(feature = "whisper")]
        "whisper" => whisper::Whisper::load(&dir).map(|e| Box::new(e) as Box<dyn Engine>),
        _ => {
            let _ = dir;
            Err("not in this build".into())
        }
    }
}

/// One line of the live transcript: where it starts in the recording, and its text.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LiveLine {
    pub at_s: f64,
    pub text: String,
}

/// What changed since the last update. The window appends; `reset` clears first.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LiveUpdate {
    /// `loading`, `listening`, `paused`, `needs_model`, `error`, or `stopped` (clear everything).
    pub state: &'static str,
    /// Why the model could not run, for `error`.
    pub reason: Option<String>,
    /// Lines the engine finished since the last update.
    pub append: Vec<LiveLine>,
    /// The utterance in progress, replaced on every update.
    pub partial: Option<LiveLine>,
    /// Drop what the window holds before applying this update.
    pub reset: bool,
    /// Which live session this belongs to (one per start), and its order
    /// within it, so a window that starts late can reconcile what it missed.
    pub session: u64,
    pub seq: u64,
}

impl LiveUpdate {
    /// The session ended: the window clears its text.
    pub fn stopped(session: u64, seq: u64) -> LiveUpdate {
        LiveUpdate { state: "stopped", reason: None, append: Vec::new(), partial: None, reset: true, session, seq }
    }
    fn state(state: &'static str) -> LiveUpdate {
        LiveUpdate { state, reason: None, append: Vec::new(), partial: None, reset: false, session: 0, seq: 0 }
    }
}

/// The whole live transcript of the running recording, for a window that
/// opens late. In memory only; dropped when the recording stops.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct LiveTranscript {
    pub state: &'static str,
    pub reason: Option<String>,
    pub lines: Vec<LiveLine>,
    pub partial: Option<LiveLine>,
    /// The session and the last update applied.
    pub session: u64,
    pub seq: u64,
}

impl LiveTranscript {
    pub fn apply(&mut self, u: &LiveUpdate) {
        if u.reset {
            *self = LiveTranscript::default();
        }
        self.session = u.session;
        self.seq = u.seq;
        self.state = u.state;
        self.reason = u.reason.clone();
        self.lines.extend(u.append.iter().cloned());
        self.partial = u.partial.clone();
    }
}

/// A 4-hour meeting is a few thousand lines; this caps a runaway engine.
const KEEP_LINES: usize = 20_000;

pub struct LiveSession {
    stop: Arc<AtomicBool>,
    pub paused: Arc<AtomicBool>,
    feed: Arc<LiveFeed>,
    /// True while the session may emit. `halt` sets it false under the lock,
    /// so no update can leave the worker after `stop` returns.
    alive: Arc<Mutex<bool>>,
    pub session: u64,
    next_seq: Arc<std::sync::atomic::AtomicU64>,
    thread: Option<JoinHandle<()>>,
}

type Loader = Box<dyn FnOnce() -> Result<Box<dyn Engine>, String> + Send>;

impl LiveSession {
    /// `offset_s`: how far into the recording the session starts, for the timestamps.
    pub fn start(
        models_dir: PathBuf,
        model: String,
        feed: Arc<LiveFeed>,
        offset_s: f64,
        session: u64,
        emit: impl Fn(LiveUpdate) + Send + 'static,
    ) -> LiveSession {
        let name = model.clone();
        Self::spawn(name, Box::new(move || load_engine(&models_dir, &model)), feed, offset_s, session, emit)
    }

    fn spawn(
        model: String,
        load: Loader,
        feed: Arc<LiveFeed>,
        offset_s: f64,
        session: u64,
        emit: impl Fn(LiveUpdate) + Send + 'static,
    ) -> LiveSession {
        let alive = Arc::new(Mutex::new(true));
        let alive2 = alive.clone();
        let next_seq = Arc::new(std::sync::atomic::AtomicU64::new(1));
        let seq_out = next_seq.clone();
        // Every update leaves stamped with the session and the next number.
        let emit = move |mut u: LiveUpdate| {
            let guard = alive2.lock().unwrap_or_else(|p| p.into_inner());
            if *guard {
                u.session = session;
                u.seq = next_seq.fetch_add(1, Ordering::SeqCst);
                emit(u);
            }
        };
        let stop = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));
        let (tx, mut rx) = rtrb::RingBuffer::<f32>::new(segmenter::RATE * 60);
        *feed.sink.lock().unwrap() = Some(tx);
        feed.enabled.store(true, Ordering::SeqCst);
        let (stop2, paused2) = (stop.clone(), paused.clone());
        let thread = std::thread::Builder::new()
            .name("live".into())
            .spawn(move || {
                let mut first = LiveUpdate::state("loading");
                first.reset = true;
                emit(first);
                let mut engine = match load() {
                    Ok(e) => e,
                    Err(e) => {
                        log::warn!("live model {model}: {e}");
                        let mut u = LiveUpdate::state(if e == "not downloaded" { "needs_model" } else { "error" });
                        u.reason = Some(e);
                        emit(u);
                        return;
                    }
                };
                emit(LiveUpdate::state("listening"));
                let at = |pos: u64| offset_s + pos as f64 / segmenter::RATE as f64;
                // Every sample that arrived, paused or not, so time keeps running.
                let mut pos: u64 = 0;
                let mut seg = Segmenter::default();
                let mut block = Vec::new();
                let mut was_paused = false;
                let mut kept = 0usize;
                while !stop2.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(100));
                    block.clear();
                    while let Ok(s) = rx.pop() {
                        block.push(s);
                    }
                    let block_start = pos;
                    pos += block.len() as u64;
                    let is_paused = paused2.load(Ordering::SeqCst);
                    if is_paused != was_paused {
                        was_paused = is_paused;
                        seg = Segmenter::starting_at(if is_paused { pos } else { block_start });
                        emit(LiveUpdate::state(if is_paused { "paused" } else { "listening" }));
                    }
                    if is_paused {
                        continue;
                    }
                    for cut in seg.push(&block) {
                        let (audio, start, done) = match cut {
                            Cut::Partial(a, s) => (a, s, false),
                            Cut::Final(a, s) => (a, s, true),
                        };
                        match engine.transcribe(&audio) {
                            Ok(text) => {
                                let mut u = LiveUpdate::state("listening");
                                let line = LiveLine { at_s: at(start), text };
                                if done {
                                    if !line.text.is_empty() && kept < KEEP_LINES {
                                        kept += 1;
                                        u.append.push(line);
                                    }
                                } else if !line.text.is_empty() {
                                    u.partial = Some(line);
                                }
                                if !stop2.load(Ordering::SeqCst) {
                                    emit(u);
                                }
                            }
                            Err(e) => {
                                log::warn!("live transcription: {e}");
                                let mut u = LiveUpdate::state("error");
                                u.reason = Some(e);
                                emit(u);
                                return;
                            }
                        }
                    }
                }
            })
            .expect("live thread");
        LiveSession { stop, paused, feed, alive, session, next_seq: seq_out, thread: Some(thread) }
    }

    /// Stop and drop the text. The model is unloaded with the thread. The
    /// stopped update to send, numbered after the session's last one.
    pub fn stop(mut self) -> LiveUpdate {
        self.halt();
        LiveUpdate::stopped(self.session, self.next_seq.fetch_add(1, Ordering::SeqCst))
    }

    fn halt(&mut self) {
        *self.alive.lock().unwrap_or_else(|p| p.into_inner()) = false;
        self.feed.enabled.store(false, Ordering::SeqCst);
        *self.feed.sink.lock().unwrap() = None;
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            // A decode in progress finishes first; nothing waits for it.
            std::thread::spawn(move || {
                let _ = t.join();
            });
        }
    }
}

impl Drop for LiveSession {
    fn drop(&mut self) {
        self.halt();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// Takes 300 ms per decode and always hears the same words.
    struct Slow;
    impl Engine for Slow {
        fn transcribe(&mut self, _: &[f32]) -> Result<String, String> {
            std::thread::sleep(Duration::from_millis(300));
            Ok("Vi mangler stadig at teste det nye skift.".into())
        }
    }

    #[test]
    fn nothing_is_emitted_after_stop_and_nothing_is_kept() {
        let feed = Arc::new(LiveFeed::default());
        let seen: Arc<Mutex<Vec<LiveUpdate>>> = Arc::default();
        let seen2 = seen.clone();
        let session = LiveSession::spawn("fake".into(), Box::new(|| Ok(Box::new(Slow) as Box<dyn Engine>)), feed.clone(), 0.0, 1, move |u| {
            seen2.lock().unwrap().push(u)
        });
        // Speech, then stop while a decode runs.
        let tone: Vec<f32> = (0..segmenter::RATE * 3).map(|i| (i as f32 * 0.07).sin() * 0.2).collect();
        {
            let mut sink = feed.sink.lock().unwrap();
            for s in &tone {
                let _ = sink.as_mut().unwrap().push(*s);
            }
        }
        let t = Instant::now();
        while seen.lock().unwrap().iter().all(|u| u.partial.is_none()) && t.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(seen.lock().unwrap().iter().any(|u| u.partial.is_some()), "the fake engine was heard");
        let stopped = session.stop();
        assert_eq!(stopped.state, "stopped");
        let count = seen.lock().unwrap().len();
        assert!(!feed.enabled.load(Ordering::SeqCst));
        assert!(feed.sink.lock().unwrap().is_none());
        std::thread::sleep(Duration::from_millis(800));
        assert_eq!(seen.lock().unwrap().len(), count, "a late decode reached the window");
    }

    /// Runs a session over 3 s of speech-like tone and returns what it emitted.
    fn session_hears(load: Loader, offset_s: f64) -> Vec<LiveUpdate> {
        let feed = Arc::new(LiveFeed::default());
        let seen: Arc<Mutex<Vec<LiveUpdate>>> = Arc::default();
        let seen2 = seen.clone();
        let session = LiveSession::spawn("t".into(), load, feed.clone(), offset_s, 7, move |u| seen2.lock().unwrap().push(u));
        let t = Instant::now();
        while !seen.lock().unwrap().iter().any(|u| u.state == "listening" || u.state == "error") && t.elapsed() < Duration::from_secs(60) {
            std::thread::sleep(Duration::from_millis(20));
        }
        let tone: Vec<f32> = (0..segmenter::RATE * 3).map(|i| (i as f32 * 0.07).sin() * 0.2).collect();
        let quiet = vec![0.0005f32; segmenter::RATE];
        for block in tone.chunks(1600).chain(quiet.chunks(1600)) {
            if let Some(sink) = feed.sink.lock().unwrap().as_mut() {
                for s in block {
                    let _ = sink.push(*s);
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        std::thread::sleep(Duration::from_millis(1500));
        let stopped = session.stop();
        let mut out = seen.lock().unwrap().clone();
        // Numbered in order within the session, the stopped update last.
        assert!(out.iter().all(|u| u.session == 7));
        assert!(out.windows(2).all(|w| w[0].seq < w[1].seq));
        assert!(out.last().is_none_or(|l| l.seq < stopped.seq));
        out.push(stopped);
        out
    }

    #[test]
    fn two_sessions_in_a_row_both_get_live_text() {
        for round in 0..2 {
            let updates = session_hears(Box::new(|| Ok(Box::new(Slow) as Box<dyn Engine>)), 600.0);
            assert!(updates.iter().all(|u| u.state != "error"), "round {round}: {updates:?}");
            let line = updates.iter().flat_map(|u| u.append.iter()).next().expect("a finished line");
            // The session started 10 minutes into the recording.
            assert!(line.at_s >= 600.0 && line.at_s < 601.0, "{}", line.at_s);
        }
    }

    /// The same with the real Parakeet model, when it is on this Mac:
    /// `MTXT_MODELS_DIR=~/Library/Application\ Support/co.mtxt.recorder/models cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn two_parakeet_sessions_in_a_row_both_run() {
        let Ok(dir) = std::env::var("MTXT_MODELS_DIR") else { return };
        for round in 0..2 {
            let dir = std::path::PathBuf::from(&dir);
            let updates = session_hears(Box::new(move || load_engine(&dir, "parakeet")), 0.0);
            assert!(
                updates.iter().all(|u| u.state != "error"),
                "round {round}: {:?}",
                updates.iter().filter_map(|u| u.reason.clone()).collect::<Vec<_>>()
            );
            assert!(updates.iter().any(|u| u.state == "listening"), "round {round}");
        }
    }

    #[test]
    fn the_transcript_appends_and_resets() {
        let mut t = LiveTranscript::default();
        let line = |at: f64, s: &str| LiveLine { at_s: at, text: s.into() };
        t.apply(&LiveUpdate { state: "listening", reason: None, append: vec![line(1.0, "En")], partial: Some(line(3.0, "To")), reset: true, session: 3, seq: 1 });
        t.apply(&LiveUpdate { state: "listening", reason: None, append: vec![line(3.0, "To tre")], partial: None, reset: false, session: 3, seq: 2 });
        assert_eq!(t.lines.len(), 2);
        assert_eq!(t.partial, None);
        assert_eq!((t.session, t.seq), (3, 2));
        t.apply(&LiveUpdate::stopped(3, 3));
        assert!(t.lines.is_empty() && t.state == "stopped");
        assert_eq!((t.session, t.seq), (3, 3));
    }

    #[test]
    fn a_model_that_cannot_load_says_why() {
        let updates = session_hears(Box::new(|| Err("only one environment is allowed per process".into())), 0.0);
        let err = updates.iter().find(|u| u.state == "error").expect("an error update");
        assert_eq!(err.reason.as_deref(), Some("only one environment is allowed per process"));
    }
}
