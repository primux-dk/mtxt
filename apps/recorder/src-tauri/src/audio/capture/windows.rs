//! System audio on Windows: WASAPI loopback on the default output device,
//! the "Console" role, which is what a meeting app plays through unless the
//! user picked another device in it.
//!
//! Written from Microsoft's documentation ("Loopback Recording",
//! `IAudioClient::Initialize`, `IAudioCaptureClient`), on the `windows` crate.
//! A shared-mode stream in the mix format with AUDCLNT_STREAMFLAGS_LOOPBACK,
//! read by polling every 10 ms on its own thread. The thread also watches the
//! default output device once a second and reopens on the new one when the
//! user switches (headset in, Bluetooth on), or when the device goes away
//! (AUDCLNT_E_DEVICE_INVALIDATED). While nothing opens, the source is Lost and
//! the mixer writes silence and notes the gap, as on macOS.
//!
//! Loopback has no permission and no prompt. It hears everything the device
//! plays, the recorder included; the recorder plays nothing, so unlike the
//! macOS tap it does not exclude its own process.

use super::loopback::{push_bytes, push_silence, SampleKind, SilenceFill};
use super::{Capture, CaptureError, Sink, SourceShared, SourceState, ThreadCapture, WATCH_EVERY};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_E_DEVICE_INVALIDATED, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
    WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
use windows::Win32::Media::KernelStreaming::WAVE_FORMAT_EXTENSIBLE;
use windows::Win32::Media::Multimedia::KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};

/// How often the thread drains the capture buffer.
const POLL: Duration = Duration::from_millis(10);
/// The capture buffer: 200 ms, so a late poll loses nothing.
const BUFFER_100NS: i64 = 2_000_000;

/// One open loopback stream.
struct Loopback {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    device_id: String,
    rate: u32,
    channels: usize,
    kind: SampleKind,
    block_align: usize,
    fill: SilenceFill,
    scratch: Vec<f32>,
}

/// COM for this thread, released when the thread ends.
struct ComThread(bool);

impl ComThread {
    fn init() -> ComThread {
        // S_OK or S_FALSE: ours to release. RPC_E_CHANGED_MODE: someone else's.
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        ComThread(hr.is_ok())
    }
}

impl Drop for ComThread {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

fn other(what: &str, e: windows::core::Error) -> CaptureError {
    CaptureError::Other(format!("{what}: {e}"))
}

fn enumerator() -> Result<IMMDeviceEnumerator, CaptureError> {
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.map_err(|e| other("MMDeviceEnumerator", e))
}

/// The default output device, or NoDevice when there is none.
fn default_output(en: &IMMDeviceEnumerator) -> Result<IMMDevice, CaptureError> {
    unsafe { en.GetDefaultAudioEndpoint(eRender, eConsole) }.map_err(|_| CaptureError::NoDevice)
}

fn device_id(device: &IMMDevice) -> Option<String> {
    unsafe {
        let raw = device.GetId().ok()?;
        let id = raw.to_string().ok();
        CoTaskMemFree(Some(raw.0 as *const _));
        id
    }
}

impl Loopback {
    fn open(en: &IMMDeviceEnumerator) -> Result<Loopback, CaptureError> {
        let device = default_output(en)?;
        let device_id = device_id(&device).unwrap_or_default();
        unsafe {
            let client: IAudioClient = device.Activate(CLSCTX_ALL, None).map_err(|e| other("IMMDevice::Activate", e))?;
            let format_ptr = client.GetMixFormat().map_err(|e| other("GetMixFormat", e))?;
            let result = (|| {
                let format: WAVEFORMATEX = std::ptr::read_unaligned(format_ptr);
                let tag = format.wFormatTag;
                let extensible_float = (u32::from(tag) == WAVE_FORMAT_EXTENSIBLE).then(|| {
                    let ext: WAVEFORMATEXTENSIBLE = std::ptr::read_unaligned(format_ptr as *const WAVEFORMATEXTENSIBLE);
                    let sub = ext.SubFormat;
                    sub == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
                });
                let bits = format.wBitsPerSample;
                let kind = SampleKind::from_format(tag, bits, extensible_float).ok_or_else(|| {
                    CaptureError::Other(format!("mix format tag {tag:#x}, {bits} bits per sample"))
                })?;
                client
                    .Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, BUFFER_100NS, 0, format_ptr, None)
                    .map_err(|e| other("IAudioClient::Initialize", e))?;
                let capture: IAudioCaptureClient = client.GetService().map_err(|e| other("GetService", e))?;
                client.Start().map_err(|e| other("IAudioClient::Start", e))?;
                let rate = format.nSamplesPerSec;
                let channels = usize::from(format.nChannels).max(1);
                let block_align = usize::from(format.nBlockAlign).max(kind.bytes() * channels);
                log::info!("system audio loopback: {rate} Hz, {channels} channels, {kind:?}");
                Ok(Loopback {
                    client,
                    capture,
                    device_id,
                    rate,
                    channels,
                    kind,
                    block_align,
                    fill: SilenceFill::new(rate, Instant::now()),
                    scratch: Vec::new(),
                })
            })();
            CoTaskMemFree(Some(format_ptr as *const _));
            result
        }
    }

    /// Everything the device has captured since the last poll, into the ring.
    /// Err when the device is gone and the stream must be reopened.
    fn drain(&mut self, sink: &mut Sink) -> Result<(), windows::core::Error> {
        let mut got = false;
        unsafe {
            loop {
                let next = self.capture.GetNextPacketSize()?;
                if next == 0 {
                    break;
                }
                let mut data: *mut u8 = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                self.capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
                if frames > 0 {
                    if flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null() {
                        push_silence(sink, frames as usize);
                    } else {
                        let bytes = std::slice::from_raw_parts(data, frames as usize * self.block_align);
                        push_bytes(sink, bytes, self.kind, self.channels, &mut self.scratch);
                    }
                    self.fill.packet(u64::from(frames), Instant::now());
                    got = true;
                }
                self.capture.ReleaseBuffer(frames)?;
            }
        }
        if !got {
            let owed = self.fill.owed(Instant::now());
            if owed > 0 {
                push_silence(sink, owed as usize);
            }
        }
        Ok(())
    }
}

impl Drop for Loopback {
    fn drop(&mut self) {
        unsafe {
            let _ = self.client.Stop();
        }
    }
}

/// Open the loopback on its own thread and keep it on the default output.
pub fn start(sink: Sink) -> Result<Box<dyn Capture>, CaptureError> {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<std::sync::Arc<SourceShared>, CaptureError>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let thread = std::thread::Builder::new()
        .name("system-audio".into())
        .spawn(move || {
            let _com = ComThread::init();
            let mut sink = sink;
            let en = match enumerator() {
                Ok(en) => en,
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            let stream = match Loopback::open(&en) {
                Ok(l) => l,
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            let shared = SourceShared::new(stream.rate);
            let _ = ready_tx.send(Ok(shared.clone()));
            let mut stream = Some(stream);
            let mut last_watch = Instant::now();
            let mut watch_now = false;
            while let Err(mpsc::RecvTimeoutError::Timeout) = stop_rx.recv_timeout(POLL) {
                if let Some(s) = stream.as_mut() {
                    if let Err(e) = s.drain(&mut sink) {
                        if e.code() == AUDCLNT_E_DEVICE_INVALIDATED {
                            log::info!("system audio: the output device went away");
                        } else {
                            log::warn!("system audio loopback: {e}");
                        }
                        stream = None;
                        watch_now = true;
                    }
                }
                if !watch_now && last_watch.elapsed() < WATCH_EVERY {
                    continue;
                }
                watch_now = false;
                last_watch = Instant::now();
                let default_id = default_output(&en).ok().and_then(|d| device_id(&d));
                let moved = stream.as_ref().is_some_and(|s| default_id.as_ref().is_some_and(|id| *id != s.device_id));
                if stream.is_some() && !moved {
                    continue;
                }
                drop(stream.take());
                match Loopback::open(&en) {
                    Ok(s) => {
                        log::info!("system audio: now on {:?} at {} Hz", s.device_id, s.rate);
                        shared.set_rate(s.rate);
                        shared.set_state(SourceState::On);
                        stream = Some(s);
                    }
                    Err(e) => {
                        if shared.state() == SourceState::On {
                            log::warn!("system audio lost: {e}");
                        }
                        shared.set_state(SourceState::Lost);
                    }
                }
            }
            drop(stream);
        })
        .map_err(|e| CaptureError::Other(e.to_string()))?;
    let shared = ready_rx.recv().map_err(|_| CaptureError::Other("system audio thread ended".into()))??;
    Ok(Box::new(ThreadCapture { shared, stop: Some(stop_tx), thread: Some(thread) }))
}
