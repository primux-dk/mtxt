//! System audio on macOS 14.2 and later: a Core Audio process tap on every
//! process but this one, read through a private aggregate device.
//!
//! Written from Apple's documentation for `AudioHardwareCreateProcessTap`,
//! `CATapDescription` and aggregate devices ("Capturing system audio with
//! Core Audio taps"). The tap is stereo and global; the IO proc averages it to
//! mono into the ring. Without the user's permission the tap delivers
//! silence, so `permissions::system_audio()` is asked first.

use super::capture::{push_mono, Capture, CaptureError, SharedSink, Sink, SourceShared, SourceState, ThreadCapture, WATCH_EVERY};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::AnyThread;
use objc2_core_audio::*;
use objc2_core_audio_types::{kAudioFormatFlagIsNonInterleaved, AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp};
use objc2_core_foundation::{CFDictionary, CFRetained, CFString};
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString};
use std::ffi::c_void;
use std::ptr::NonNull;

struct Context {
    sink: SharedSink,
    channels: usize,
    interleaved: bool,
    /// Counts IO callbacks, so the supervisor sees a tap that stopped delivering.
    calls: Arc<AtomicU64>,
}

struct Tap {
    output: AudioObjectID,
    tap: AudioObjectID,
    aggregate: AudioObjectID,
    proc_id: AudioDeviceIOProcID,
    rate: u32,
    context: *mut Context,
    stopped: bool,
}

// The raw pointers are owned by this struct and touched only on stop.
unsafe impl Send for Tap {}

fn check(status: i32, what: &str) -> Result<(), CaptureError> {
    if status == 0 {
        Ok(())
    } else {
        Err(CaptureError::Other(format!("{what}: OSStatus {status}")))
    }
}

fn address(selector: u32) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    }
}

unsafe fn get<T: Copy>(object: AudioObjectID, selector: u32, qualifier: Option<&u32>) -> Result<T, CaptureError> {
    let addr = address(selector);
    let mut value = std::mem::MaybeUninit::<T>::zeroed();
    let mut size = std::mem::size_of::<T>() as u32;
    let (qsize, qptr) = match qualifier {
        Some(q) => (std::mem::size_of::<u32>() as u32, q as *const u32 as *const c_void),
        None => (0, std::ptr::null()),
    };
    let status = AudioObjectGetPropertyData(
        object,
        NonNull::from(&addr),
        qsize,
        qptr,
        NonNull::from(&mut size),
        NonNull::new_unchecked(value.as_mut_ptr() as *mut c_void),
    );
    check(status, "AudioObjectGetPropertyData")?;
    Ok(value.assume_init())
}

/// A CFString property (UIDs). The returned reference is owned (+1).
unsafe fn get_string(object: AudioObjectID, selector: u32) -> Result<CFRetained<CFString>, CaptureError> {
    let raw: *const CFString = get(object, selector, None)?;
    NonNull::new(raw as *mut CFString)
        .map(|p| CFRetained::from_raw(p))
        .ok_or_else(|| CaptureError::Other("empty UID".into()))
}

fn cfstr_to_ns(s: &CFString) -> Retained<NSString> {
    // Toll-free bridged.
    let ptr = s as *const CFString as *mut NSString;
    unsafe { Retained::retain(ptr).expect("non-null") }
}

/// Open the tap, then watch it: a new default output device, or an IO proc
/// that stopped being called, rebuilds the tap; while that fails the source
/// is Lost and the mixer writes silence.
pub fn start(sink: Sink) -> Result<Box<dyn Capture>, CaptureError> {
    if !super::super::permissions::macos_supports_taps() {
        return Err(CaptureError::Unsupported);
    }
    let sink: SharedSink = Arc::new(Mutex::new(sink));
    let calls = Arc::new(AtomicU64::new(0));
    let first = unsafe { start_tap(sink.clone(), calls.clone()) }?;
    let shared = SourceShared::new(first.rate);
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let shared2 = shared.clone();
    let thread = std::thread::Builder::new()
        .name("system-audio".into())
        .spawn(move || {
            let mut tap = Some(first);
            let mut last_calls = calls.load(Ordering::Relaxed);
            let mut stalled = 0;
            while let Err(mpsc::RecvTimeoutError::Timeout) = stop_rx.recv_timeout(WATCH_EVERY) {
                let now_calls = calls.load(Ordering::Relaxed);
                stalled = if now_calls == last_calls { stalled + 1 } else { 0 };
                last_calls = now_calls;
                let output = default_output();
                let moved = tap.as_ref().is_some_and(|t| output.is_some_and(|o| o != t.output));
                if tap.is_some() && !moved && stalled < 3 {
                    continue;
                }
                if let Some(mut t) = tap.take() {
                    t.stop();
                }
                match unsafe { start_tap(sink.clone(), calls.clone()) } {
                    Ok(t) => {
                        log::info!("system audio: tap rebuilt at {} Hz", t.rate);
                        shared2.set_rate(t.rate);
                        shared2.set_state(SourceState::On);
                        stalled = 0;
                        tap = Some(t);
                    }
                    Err(e) => {
                        if shared2.state() == SourceState::On {
                            log::warn!("system audio lost: {e}");
                        }
                        shared2.set_state(SourceState::Lost);
                    }
                }
            }
            if let Some(mut t) = tap {
                t.stop();
            }
        })
        .map_err(|e| CaptureError::Other(e.to_string()))?;
    Ok(Box::new(ThreadCapture { shared, stop: Some(stop_tx), thread: Some(thread) }))
}

fn default_output() -> Option<AudioObjectID> {
    unsafe { get(kAudioObjectSystemObject as AudioObjectID, kAudioHardwarePropertyDefaultSystemOutputDevice, None).ok() }
}

unsafe fn start_tap(sink: SharedSink, calls: Arc<AtomicU64>) -> Result<Tap, CaptureError> {
    // Leave this process out of the tap.
    let pid = std::process::id() as i32;
    let own: AudioObjectID = get::<AudioObjectID>(
        kAudioObjectSystemObject as AudioObjectID,
        kAudioHardwarePropertyTranslatePIDToProcessObject,
        Some(&(pid as u32)),
    )
    .unwrap_or(0);
    let exclude: Retained<NSArray<NSNumber>> = if own != 0 {
        NSArray::from_retained_slice(&[NSNumber::new_u32(own)])
    } else {
        NSArray::new()
    };
    let description = CATapDescription::initStereoGlobalTapButExcludeProcesses(CATapDescription::alloc(), &exclude);
    description.setName(&NSString::from_str("mtxt recorder"));
    description.setPrivate(true);
    description.setMuteBehavior(CATapMuteBehavior::Unmuted);

    let mut tap: AudioObjectID = 0;
    check(AudioHardwareCreateProcessTap(Some(&description), &mut tap), "AudioHardwareCreateProcessTap")?;

    let result = (|| -> Result<Tap, CaptureError> {
        let tap_uid = get_string(tap, kAudioTapPropertyUID)?;
        let format: AudioStreamBasicDescription = get(tap, kAudioTapPropertyFormat, None)?;
        let output: AudioObjectID =
            get(kAudioObjectSystemObject as AudioObjectID, kAudioHardwarePropertyDefaultSystemOutputDevice, None)?;
        let output_uid = get_string(output, kAudioDevicePropertyDeviceUID)?;

        let key = |k: &std::ffi::CStr| NSString::from_str(k.to_str().unwrap());
        let sub_device: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::from_retained_objects(
            &[&*key(kAudioSubDeviceUIDKey)],
            &[Retained::into_super(Retained::into_super(cfstr_to_ns(&output_uid)))],
        );
        let sub_tap: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::from_retained_objects(
            &[&*key(kAudioSubTapDriftCompensationKey), &*key(kAudioSubTapUIDKey)],
            &[
                Retained::into_super(Retained::into_super(Retained::into_super(NSNumber::new_bool(true)))),
                Retained::into_super(Retained::into_super(cfstr_to_ns(&tap_uid))),
            ],
        );
        let uid = NSString::from_str(&format!("co.mtxt.recorder.tap.{}", uuid::Uuid::new_v4()));
        let sub_devices = NSArray::from_retained_slice(&[sub_device]);
        let sub_taps = NSArray::from_retained_slice(&[sub_tap]);
        let as_obj = |n: Retained<NSNumber>| Retained::into_super(Retained::into_super(Retained::into_super(n)));
        let keys = [
            key(kAudioAggregateDeviceNameKey),
            key(kAudioAggregateDeviceUIDKey),
            key(kAudioAggregateDeviceMainSubDeviceKey),
            key(kAudioAggregateDeviceIsPrivateKey),
            key(kAudioAggregateDeviceIsStackedKey),
            key(kAudioAggregateDeviceTapAutoStartKey),
            key(kAudioAggregateDeviceSubDeviceListKey),
            key(kAudioAggregateDeviceTapListKey),
        ];
        let values: [Retained<AnyObject>; 8] = [
            Retained::into_super(Retained::into_super(NSString::from_str("mtxt recorder tap"))),
            Retained::into_super(Retained::into_super(uid)),
            Retained::into_super(Retained::into_super(cfstr_to_ns(&output_uid))),
            as_obj(NSNumber::new_bool(true)),
            as_obj(NSNumber::new_bool(false)),
            as_obj(NSNumber::new_bool(true)),
            Retained::into_super(Retained::into_super(sub_devices)),
            Retained::into_super(Retained::into_super(sub_taps)),
        ];
        let key_refs: Vec<&NSString> = keys.iter().map(|k| &**k).collect();
        let dict: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::from_retained_objects(&key_refs, &values);
        let cf_dict = &*(Retained::as_ptr(&dict) as *const CFDictionary);

        let mut aggregate: AudioObjectID = 0;
        check(
            AudioHardwareCreateAggregateDevice(cf_dict, NonNull::from(&mut aggregate)),
            "AudioHardwareCreateAggregateDevice",
        )?;

        let context = Box::into_raw(Box::new(Context {
            sink,
            channels: (format.mChannelsPerFrame as usize).max(1),
            interleaved: format.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0,
            calls,
        }));
        let mut proc_id: AudioDeviceIOProcID = None;
        let status = AudioDeviceCreateIOProcID(aggregate, Some(io_proc), context as *mut c_void, NonNull::from(&mut proc_id));
        if status != 0 {
            drop(Box::from_raw(context));
            AudioHardwareDestroyAggregateDevice(aggregate);
            return Err(CaptureError::Other(format!("AudioDeviceCreateIOProcID: {status}")));
        }
        let status = AudioDeviceStart(aggregate, proc_id);
        if status != 0 {
            AudioDeviceDestroyIOProcID(aggregate, proc_id);
            drop(Box::from_raw(context));
            AudioHardwareDestroyAggregateDevice(aggregate);
            return Err(CaptureError::Other(format!("AudioDeviceStart: {status}")));
        }
        log::info!(
            "system audio tap: {} Hz, {} channels, interleaved {}",
            format.mSampleRate,
            format.mChannelsPerFrame,
            (*context).interleaved
        );
        Ok(Tap { output, tap, aggregate, proc_id, rate: format.mSampleRate as u32, context, stopped: false })
    })();
    if result.is_err() {
        AudioHardwareDestroyProcessTap(tap);
    }
    result
}

/// The real-time callback: average the tap's channels into the ring.
unsafe extern "C-unwind" fn io_proc(
    _device: AudioObjectID,
    _now: NonNull<AudioTimeStamp>,
    input: NonNull<AudioBufferList>,
    _input_time: NonNull<AudioTimeStamp>,
    _output: NonNull<AudioBufferList>,
    _output_time: NonNull<AudioTimeStamp>,
    client: *mut c_void,
) -> i32 {
    let ctx = &mut *(client as *mut Context);
    ctx.calls.fetch_add(1, Ordering::Relaxed);
    // Uncontended: one tap at a time writes.
    let Ok(mut sink) = ctx.sink.try_lock() else { return 0 };
    let list = input.as_ref();
    let count = list.mNumberBuffers as usize;
    if count == 0 {
        return 0;
    }
    let buffers = std::slice::from_raw_parts(list.mBuffers.as_ptr(), count);
    if ctx.interleaved || count == 1 {
        let b = &buffers[0];
        if b.mData.is_null() {
            return 0;
        }
        let ch = (b.mNumberChannels as usize).max(1);
        let samples = std::slice::from_raw_parts(b.mData as *const f32, b.mDataByteSize as usize / 4);
        push_mono(&mut sink, samples, ch, |s| s);
    } else {
        // Planar: one buffer per channel. Average into a small stack block.
        let frames = buffers[0].mDataByteSize as usize / 4;
        let mut block = [0f32; 1024];
        let mut done = 0;
        while done < frames {
            let n = (frames - done).min(block.len());
            for (c, b) in buffers.iter().enumerate().take(ctx.channels) {
                if b.mData.is_null() {
                    continue;
                }
                let plane = std::slice::from_raw_parts(b.mData as *const f32, frames);
                for i in 0..n {
                    if c == 0 {
                        block[i] = 0.0;
                    }
                    block[i] += plane[done + i] / ctx.channels as f32;
                }
            }
            push_mono(&mut sink, &block[..n], 1, |s| s);
            done += n;
        }
    }
    0
}

impl Tap {
    fn stop(&mut self) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        unsafe {
            AudioDeviceStop(self.aggregate, self.proc_id);
            AudioDeviceDestroyIOProcID(self.aggregate, self.proc_id);
            AudioHardwareDestroyAggregateDevice(self.aggregate);
            AudioHardwareDestroyProcessTap(self.tap);
            drop(Box::from_raw(self.context));
        }
    }
}

impl Drop for Tap {
    fn drop(&mut self) {
        self.stop();
    }
}
