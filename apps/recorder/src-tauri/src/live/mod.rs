//! The live transcript: a local model reading the 16 kHz mono mix while a
//! recording runs. A preview only. Its text lives in memory, goes to the live
//! window, and is dropped when the recording stops; nothing of it is uploaded
//! or written to disk.

pub mod models;
#[cfg(all(feature = "parakeet", target_arch = "aarch64"))]
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
        #[cfg(all(feature = "parakeet", target_arch = "aarch64"))]
        "parakeet" => parakeet::Parakeet::load(&dir).map(|e| Box::new(e) as Box<dyn Engine>).map_err(|e| e.to_string()),
        #[cfg(feature = "whisper")]
        "whisper" => whisper::Whisper::load(&dir).map(|e| Box::new(e) as Box<dyn Engine>),
        _ => {
            let _ = dir;
            Err("not in this build".into())
        }
    }
}

/// What the live window shows.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LiveUpdate {
    /// `loading`, `listening`, `paused`, `needs_model`, `error`, or `stopped` (clear everything).
    pub state: &'static str,
    /// Finished lines, oldest first; the window shows the last two.
    pub lines: Vec<String>,
    /// The utterance in progress.
    pub partial: String,
}

impl LiveUpdate {
    /// The session ended: the window clears its text.
    pub fn stopped() -> LiveUpdate {
        LiveUpdate { state: "stopped", lines: Vec::new(), partial: String::new() }
    }
}

const KEEP_LINES: usize = 20;

pub struct LiveSession {
    stop: Arc<AtomicBool>,
    pub paused: Arc<AtomicBool>,
    feed: Arc<LiveFeed>,
    /// True while the session may emit. `halt` sets it false under the lock,
    /// so no update can leave the worker after `stop` returns.
    alive: Arc<Mutex<bool>>,
    thread: Option<JoinHandle<()>>,
}

type Loader = Box<dyn FnOnce() -> Result<Box<dyn Engine>, String> + Send>;

impl LiveSession {
    pub fn start(
        models_dir: PathBuf,
        model: String,
        feed: Arc<LiveFeed>,
        emit: impl Fn(LiveUpdate) + Send + 'static,
    ) -> LiveSession {
        let name = model.clone();
        Self::spawn(name, Box::new(move || load_engine(&models_dir, &model)), feed, emit)
    }

    fn spawn(model: String, load: Loader, feed: Arc<LiveFeed>, emit: impl Fn(LiveUpdate) + Send + 'static) -> LiveSession {
        let alive = Arc::new(Mutex::new(true));
        let alive2 = alive.clone();
        let emit = move |u: LiveUpdate| {
            let guard = alive2.lock().unwrap_or_else(|p| p.into_inner());
            if *guard {
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
                let mut update = LiveUpdate { state: "loading", lines: Vec::new(), partial: String::new() };
                emit(update.clone());
                let mut engine = match load() {
                    Ok(e) => e,
                    Err(e) => {
                        log::warn!("live model {model}: {e}");
                        update.state = if e == "not downloaded" { "needs_model" } else { "error" };
                        emit(update);
                        return;
                    }
                };
                update.state = "listening";
                emit(update.clone());
                let mut seg = Segmenter::default();
                let mut block = Vec::new();
                let mut was_paused = false;
                while !stop2.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(100));
                    block.clear();
                    while let Ok(s) = rx.pop() {
                        block.push(s);
                    }
                    let is_paused = paused2.load(Ordering::SeqCst);
                    if is_paused != was_paused {
                        was_paused = is_paused;
                        seg = Segmenter::default();
                        update.partial.clear();
                        update.state = if is_paused { "paused" } else { "listening" };
                        emit(update.clone());
                    }
                    if is_paused {
                        continue;
                    }
                    for cut in seg.push(&block) {
                        let (audio, done) = match cut {
                            Cut::Partial(a) => (a, false),
                            Cut::Final(a) => (a, true),
                        };
                        match engine.transcribe(&audio) {
                            Ok(text) => {
                                if done {
                                    if !text.is_empty() {
                                        update.lines.push(text);
                                        if update.lines.len() > KEEP_LINES {
                                            update.lines.remove(0);
                                        }
                                    }
                                    update.partial.clear();
                                } else {
                                    update.partial = text;
                                }
                                if !stop2.load(Ordering::SeqCst) {
                                    emit(update.clone());
                                }
                            }
                            Err(e) => {
                                log::warn!("live transcription: {e}");
                                update.state = "error";
                                emit(update.clone());
                                return;
                            }
                        }
                    }
                }
            })
            .expect("live thread");
        LiveSession { stop, paused, feed, alive, thread: Some(thread) }
    }

    /// Stop and drop the text. The model is unloaded with the thread.
    pub fn stop(mut self) {
        self.halt();
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
        let session = LiveSession::spawn("fake".into(), Box::new(|| Ok(Box::new(Slow) as Box<dyn Engine>)), feed.clone(), move |u| {
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
        while seen.lock().unwrap().iter().all(|u| u.partial.is_empty()) && t.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(seen.lock().unwrap().iter().any(|u| !u.partial.is_empty()), "the fake engine was heard");
        session.stop();
        let count = seen.lock().unwrap().len();
        assert!(!feed.enabled.load(Ordering::SeqCst));
        assert!(feed.sink.lock().unwrap().is_none());
        std::thread::sleep(Duration::from_millis(800));
        assert_eq!(seen.lock().unwrap().len(), count, "a late decode reached the window");
    }
}
