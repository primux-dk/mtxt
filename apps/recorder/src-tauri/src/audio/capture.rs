//! Capture sources. Each one delivers mono f32 samples at its own rate into
//! a lock-free ring from the audio thread; the mixer reads the other end.
//!
//! macOS: the microphone through cpal, system audio through a Core Audio
//! process tap (`macos_tap`). Windows (packet 10) adds WASAPI loopback as a
//! second `Capture` behind `system_audio()`; nothing else changes.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::mpsc;
use std::thread::JoinHandle;

/// A running source. Dropping it stops the capture.
pub trait Capture: Send {
    /// Samples per second of what goes into the ring.
    fn rate(&self) -> u32;
    fn stop(&mut self);
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

/// Ring size per source: 10 s at 48 kHz. The mixer drains it every 10 ms.
pub const RING_SAMPLES: usize = 480_000;

/// The default input device, through cpal. The stream lives on its own
/// thread, because a cpal stream may not move between threads.
pub fn microphone(sink: Sink) -> Result<Box<dyn Capture>, CaptureError> {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, CaptureError>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let thread = std::thread::Builder::new()
        .name("mic".into())
        .spawn(move || {
            let stream = match open_mic(sink) {
                Ok((stream, rate)) => {
                    let _ = ready_tx.send(Ok(rate));
                    stream
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            let _ = stop_rx.recv();
            drop(stream);
        })
        .map_err(|e| CaptureError::Other(e.to_string()))?;
    let rate = ready_rx.recv().map_err(|_| CaptureError::Other("mic thread ended".into()))??;
    Ok(Box::new(ThreadCapture { rate, stop: Some(stop_tx), thread: Some(thread) }))
}

fn open_mic(mut sink: Sink) -> Result<(cpal::Stream, u32), CaptureError> {
    let host = cpal::default_host();
    let device = host.default_input_device().ok_or(CaptureError::NoDevice)?;
    let config = device.default_input_config().map_err(|e| CaptureError::Other(e.to_string()))?;
    let rate = config.sample_rate();
    let channels = usize::from(config.channels()).max(1);
    let err = |e: cpal::Error| log::warn!("microphone stream: {e}");
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            config.clone().into(),
            move |data: &[f32], _| push_mono(&mut sink, data, channels, |s| s),
            err,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            config.clone().into(),
            move |data: &[i16], _| push_mono(&mut sink, data, channels, |s| f32::from(s) / 32768.0),
            err,
            None,
        ),
        cpal::SampleFormat::I32 => device.build_input_stream(
            config.clone().into(),
            move |data: &[i32], _| push_mono(&mut sink, data, channels, |s| s as f32 / 2_147_483_648.0),
            err,
            None,
        ),
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

struct ThreadCapture {
    rate: u32,
    stop: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl Capture for ThreadCapture {
    fn rate(&self) -> u32 {
        self.rate
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
}
