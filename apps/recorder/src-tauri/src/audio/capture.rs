//! Capture sources. Each one delivers mono f32 samples at its own rate into
//! a lock-free ring from the audio thread; the mixer reads the other end.
//!
//! macOS: the microphone through cpal, system audio through a Core Audio
//! process tap (`macos_tap`). Windows (packet 10) adds WASAPI loopback as a
//! second `Capture` behind `system_audio()`; nothing else changes.
//!
//! A source follows the device under it. The microphone reopens on the new
//! default input when the user switches it or when the device disappears;
//! while no device works, the source is `Lost`, the window says so, and the
//! mixer writes silence and notes the gap.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
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
    #[error("needs macOS 14.2 or later")]
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

/// The default input device, through cpal, followed across device changes.
/// The streams live on one thread, because a cpal stream may not move
/// between threads.
pub fn microphone(sink: Sink) -> Result<Box<dyn Capture>, CaptureError> {
    let sink: SharedSink = Arc::new(Mutex::new(sink));
    let (ready_tx, ready_rx) = mpsc::channel::<Result<Arc<SourceShared>, CaptureError>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let thread = std::thread::Builder::new()
        .name("mic".into())
        .spawn(move || {
            let host = cpal::default_host();
            let failed = Arc::new(AtomicBool::new(false));
            let (mut stream, shared, mut device_id) = match open_default(&host, sink.clone(), failed.clone()) {
                Ok((s, rate, id)) => {
                    let shared = SourceShared::new(rate);
                    let _ = ready_tx.send(Ok(shared.clone()));
                    (Some(s), shared, id)
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            while let Err(mpsc::RecvTimeoutError::Timeout) = stop_rx.recv_timeout(WATCH_EVERY) {
                let default_id = host.default_input_device().and_then(|d| d.id().ok()).map(|i| i.to_string());
                let switched = default_id.is_some() && default_id != device_id;
                if stream.is_some() && !switched && !failed.load(Ordering::Relaxed) {
                    continue;
                }
                drop(stream.take());
                failed.store(false, Ordering::Relaxed);
                match open_default(&host, sink.clone(), failed.clone()) {
                    Ok((s, rate, id)) => {
                        log::info!("microphone: now on {id:?} at {rate} Hz");
                        shared.set_rate(rate);
                        shared.set_state(SourceState::On);
                        device_id = id;
                        stream = Some(s);
                    }
                    Err(e) => {
                        if shared.state() == SourceState::On {
                            log::warn!("microphone lost: {e}");
                        }
                        shared.set_state(SourceState::Lost);
                        device_id = None;
                    }
                }
            }
            drop(stream);
        })
        .map_err(|e| CaptureError::Other(e.to_string()))?;
    let shared = ready_rx.recv().map_err(|_| CaptureError::Other("mic thread ended".into()))??;
    Ok(Box::new(ThreadCapture { shared, stop: Some(stop_tx), thread: Some(thread) }))
}

fn open_default(
    host: &cpal::Host,
    sink: SharedSink,
    failed: Arc<AtomicBool>,
) -> Result<(cpal::Stream, u32, Option<String>), CaptureError> {
    let device = host.default_input_device().ok_or(CaptureError::NoDevice)?;
    let id = device.id().ok().map(|i| i.to_string());
    let (stream, rate) = open_mic(&device, sink, failed)?;
    Ok((stream, rate, id))
}

fn open_mic(device: &cpal::Device, sink: SharedSink, failed: Arc<AtomicBool>) -> Result<(cpal::Stream, u32), CaptureError> {
    let config = device.default_input_config().map_err(|e| CaptureError::Other(e.to_string()))?;
    let rate = config.sample_rate();
    let channels = usize::from(config.channels()).max(1);
    let err = move |e: cpal::Error| {
        log::warn!("microphone stream: {e}");
        failed.store(true, Ordering::Relaxed);
    };
    macro_rules! build {
        ($t:ty, $conv:expr) => {{
            let sink = sink.clone();
            device.build_input_stream(
                config.clone().into(),
                move |data: &[$t], _| {
                    // Uncontended: one stream at a time writes.
                    if let Ok(mut s) = sink.try_lock() {
                        push_mono(&mut s, data, channels, $conv);
                    }
                },
                err,
                None,
            )
        }};
    }
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => build!(f32, |s| s),
        cpal::SampleFormat::I16 => build!(i16, |s| f32::from(s) / 32768.0),
        cpal::SampleFormat::I32 => build!(i32, |s| s as f32 / 2_147_483_648.0),
        other => return Err(CaptureError::Other(format!("sample format {other:?}"))),
    }
    .map_err(|e| match e.kind() {
        cpal::ErrorKind::DeviceNotAvailable => CaptureError::NoDevice,
        cpal::ErrorKind::PermissionDenied => CaptureError::PermissionDenied,
        _ => CaptureError::Other(e.to_string()),
    })?;
    stream.play().map_err(|e| CaptureError::Other(e.to_string()))?;
    Ok((stream, rate))
}

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
        super::macos_tap::start(sink)
    }
    #[cfg(not(target_os = "macos"))]
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
