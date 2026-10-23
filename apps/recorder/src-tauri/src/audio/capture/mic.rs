//! The microphone on both platforms: the default input device through cpal
//! (Core Audio on macOS, WASAPI on Windows), followed across device changes.

use super::{Capture, CaptureError, SharedSink, Sink, SourceShared, SourceState, ThreadCapture, WATCH_EVERY, push_mono};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

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
