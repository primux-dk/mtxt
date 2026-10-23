//! Capture sources. Each one delivers mono f32 samples at its own rate into
//! a lock-free ring from the audio thread; the mixer reads the other end.
//!
//! The microphone is the same code on both platforms (`mic`, cpal). System
//! audio is one module per platform behind `system_audio()`: a Core Audio
//! process tap on macOS (`macos`), WASAPI loopback on the default output
//! device on Windows (`windows`). Each hands the mixer a `Capture`; the mixer,
//! the file and the live transcript do not know which platform they run on.
//!
//! A source follows the device under it. The microphone reopens on the new
//! default input when the user switches it or when the device disappears;
//! while no device works, the source is `Lost`, the window says so, and the
//! mixer writes silence and notes the gap.

mod loopback;
mod mic;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

pub use mic::microphone;

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

/// A running source. Dropping it stops the capture.
pub trait Capture: Send {
    fn shared(&self) -> Arc<SourceShared>;
    fn stop(&mut self);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceState {
    On,
    Lost,
}

/// What a source tells the mixer and the window while it runs.
#[derive(Debug)]
pub struct SourceShared {
    rate: AtomicU32,
    lost: AtomicBool,
}

impl SourceShared {
    pub fn new(rate: u32) -> Arc<SourceShared> {
        Arc::new(SourceShared { rate: AtomicU32::new(rate), lost: AtomicBool::new(false) })
    }
    /// Samples per second of what goes into the ring now.
    pub fn rate(&self) -> u32 {
        self.rate.load(Ordering::Relaxed)
    }
    pub fn set_rate(&self, rate: u32) {
        self.rate.store(rate, Ordering::Relaxed)
    }
    pub fn state(&self) -> SourceState {
        if self.lost.load(Ordering::Relaxed) {
            SourceState::Lost
        } else {
            SourceState::On
        }
    }
    pub fn set_state(&self, s: SourceState) {
        self.lost.store(s == SourceState::Lost, Ordering::Relaxed)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CaptureError {
    #[error("permission denied")]
    PermissionDenied,
    #[error("no device")]
    NoDevice,
    /// This operating system has no system audio capture the recorder can use
    /// (macOS before 14.2).
    #[error("system audio capture is not supported here")]
    Unsupported,
    #[error("{0}")]
    Other(String),
}

pub type Sink = rtrb::Producer<f32>;
/// The ring's write end, shared by the streams a source opens one after another.
pub type SharedSink = Arc<Mutex<Sink>>;

/// Ring size per source: 10 s at 48 kHz. The mixer drains it every 10 ms.
pub const RING_SAMPLES: usize = 480_000;
/// How often a source checks its device.
pub const WATCH_EVERY: Duration = Duration::from_millis(1000);

/// Average the channels of interleaved frames into the ring. A full ring
/// drops the newest samples: the mixer is behind, and blocking here would
/// stall the audio thread.
pub fn push_mono<T: Copy>(sink: &mut Sink, data: &[T], channels: usize, to_f32: impl Fn(T) -> f32) {
    let frames = data.len() / channels;
    let n = frames.min(sink.slots());
    if n == 0 {
        return;
    }
    if let Ok(mut chunk) = sink.write_chunk(n) {
        let (a, b) = chunk.as_mut_slices();
        let scale = 1.0 / channels as f32;
        for (i, slot) in a.iter_mut().chain(b.iter_mut()).enumerate() {
            let frame = &data[i * channels..(i + 1) * channels];
            *slot = frame.iter().map(|s| to_f32(*s)).sum::<f32>() * scale;
        }
        chunk.commit_all();
    }
}

/// A source whose device work runs on its own thread until `stop`.
pub struct ThreadCapture {
    pub shared: Arc<SourceShared>,
    pub stop: Option<mpsc::Sender<()>>,
    pub thread: Option<JoinHandle<()>>,
}

impl Capture for ThreadCapture {
    fn shared(&self) -> Arc<SourceShared> {
        self.shared.clone()
    }
    fn stop(&mut self) {
        if let Some(tx) = self.stop.take() {
            let _ = tx.send(());
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for ThreadCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The system audio source for this platform.
pub fn system_audio(sink: Sink) -> Result<Box<dyn Capture>, CaptureError> {
    #[cfg(target_os = "macos")]
    {
        macos::start(sink)
    }
    #[cfg(target_os = "windows")]
    {
        windows::start(sink)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = sink;
        Err(CaptureError::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interleaved_frames_are_averaged_into_the_ring() {
        let (mut p, mut c) = rtrb::RingBuffer::<f32>::new(4);
        push_mono(&mut p, &[0.2f32, 0.4, -1.0, 1.0, 0.5, 0.5], 2, |s| s);
        let got: Vec<f32> = std::iter::from_fn(|| c.pop().ok()).collect();
        assert_eq!(got.len(), 3);
        assert!((got[0] - 0.3).abs() < 1e-6 && got[1].abs() < 1e-6 && (got[2] - 0.5).abs() < 1e-6);
        // A full ring takes what fits and drops the rest.
        push_mono(&mut p, &[1i16; 10], 1, |s| f32::from(s));
        assert_eq!(c.slots(), 4);
    }

    #[test]
    fn shared_state_and_rate() {
        let s = SourceShared::new(48_000);
        assert_eq!(s.state(), SourceState::On);
        s.set_state(SourceState::Lost);
        s.set_rate(16_000);
        assert_eq!((s.state(), s.rate()), (SourceState::Lost, 16_000));
    }
}
