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

use super::loopback::{push_bytes, push_silence, SampleKind, Timeline, TICKS};
use super::{Capture, CaptureError, Sink, SourceShared, SourceState, ThreadCapture, WATCH_EVERY};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR, AUDCLNT_E_DEVICE_INVALIDATED, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
    WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
use windows::Win32::Media::KernelStreaming::WAVE_FORMAT_EXTENSIBLE;
use windows::Win32::Media::Multimedia::KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

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
    timeline: Timeline,
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

/// The performance counter now, in the 100 ns units WASAPI stamps packets with.
fn qpc_now() -> u64 {
    let (mut count, mut freq) = (0i64, 0i64);
    unsafe {
        let _ = QueryPerformanceCounter(&mut count);
        let _ = QueryPerformanceFrequency(&mut freq);
    }
    if freq <= 0 {
        return 0;
    }
    (count as u128 * u128::from(TICKS) / freq as u128) as u64
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
                    timeline: Timeline::new(rate, qpc_now()),
                    scratch: Vec::new(),
                })
            })();
            CoTaskMemFree(Some(format_ptr as *const _));
            result
        }
    }

    /// Everything the device has captured since the last poll, into the ring,
    /// placed on the timeline by each packet's QPC time; zeros for a stretch
    /// with no packets. Err when the device is gone and the stream must be
    /// reopened.
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
                let mut qpc = 0u64;
                self.capture.GetBuffer(&mut data, &mut frames, &mut flags, None, Some(&mut qpc))?;
                if frames > 0 {
                    let stamped = flags & (AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32) == 0 && qpc > 0;
                    let place = self.timeline.packet(stamped.then_some(qpc), u64::from(frames));
                    push_silence(sink, place.zeros as usize);
                    let skip = place.skip as usize;
                    let keep = frames as usize - skip;
                    if flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null() {
                        push_silence(sink, keep);
                    } else if keep > 0 {
                        let bytes = std::slice::from_raw_parts(data, frames as usize * self.block_align);
                        push_bytes(sink, &bytes[skip * self.block_align..], self.kind, self.channels, &mut self.scratch);
                    }
                    got = true;
                }
                self.capture.ReleaseBuffer(frames)?;
            }
        }
        if !got {
            push_silence(sink, self.timeline.silence(qpc_now()) as usize);
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
            // No output device yet, or one in a format we cannot read: the
            // source starts Lost and the watch below keeps trying, so a
            // headset plugged in later still brings system audio in.
            let (mut stream, shared) = match Loopback::open(&en) {
                Ok(l) => {
                    let shared = SourceShared::new(l.rate);
                    (Some(l), shared)
                }
                Err(e) => {
                    log::warn!("system audio: no loopback at the start ({e}); trying again every second");
                    let shared = SourceShared::new(48_000);
                    shared.set_state(SourceState::Lost);
                    (None, shared)
                }
            };
            let _ = ready_tx.send(Ok(shared.clone()));
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
