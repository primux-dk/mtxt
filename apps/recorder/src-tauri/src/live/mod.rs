//! The live transcript: a local model reading the 16 kHz mono mix while a
//! recording runs. A preview only. Its text lives in memory, goes to the live
//! window, and is dropped when the recording stops; nothing of it is uploaded
//! or written to disk.

pub mod models;
#[cfg(feature = "parakeet")]
pub mod parakeet;
pub mod segmenter;
#[cfg(feature = "whisper")]
pub mod whisper;

use crate::audio::recorder::LiveFeed;
use segmenter::{Cut, Segmenter};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
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
        #[cfg(feature = "parakeet")]
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
    /// `loading`, `listening`, `paused`, `needs_model` or `error`.
    pub state: &'static str,
    /// Finished lines, oldest first; the window shows the last two.
    pub lines: Vec<String>,
    /// The utterance in progress.
    pub partial: String,
}

const KEEP_LINES: usize = 20;

pub struct LiveSession {
    stop: Arc<AtomicBool>,
    pub paused: Arc<AtomicBool>,
    feed: Arc<LiveFeed>,
    thread: Option<JoinHandle<()>>,
}

impl LiveSession {
    pub fn start(
        models_dir: PathBuf,
        model: String,
        feed: Arc<LiveFeed>,
        emit: impl Fn(LiveUpdate) + Send + 'static,
    ) -> LiveSession {
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
                let mut engine = match load_engine(&models_dir, &model) {
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
        LiveSession { stop, paused, feed, thread: Some(thread) }
    }

    /// Stop and drop the text. The model is unloaded with the thread.
    pub fn stop(mut self) {
        self.halt();
    }

    fn halt(&mut self) {
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
