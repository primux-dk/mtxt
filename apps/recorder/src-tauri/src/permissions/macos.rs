//! macOS: the microphone through AVFoundation's authorisation status, and
//! the audio capture permission (TCC `kTCCServiceAudioCapture`) a process tap
//! needs on macOS 14.2 and later.

use super::Permission;
use block2::RcBlock;
use objc2::runtime::Bool;
use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
use objc2_core_foundation::CFString;
use objc2_foundation::NSProcessInfo;
use std::ffi::{c_void, CStr};
use std::sync::mpsc;
use std::time::Duration;

/// Process taps exist from macOS 14.2.
pub fn supports_taps() -> bool {
    let v = NSProcessInfo::processInfo().operatingSystemVersion();
    (v.majorVersion, v.minorVersion) >= (14, 2)
}

pub fn microphone() -> Permission {
    let Some(audio) = (unsafe { AVMediaTypeAudio }) else { return Permission::Unsupported };
    match unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) } {
        AVAuthorizationStatus::Authorized => Permission::Granted,
        AVAuthorizationStatus::NotDetermined => Permission::NotDetermined,
        _ => Permission::Denied,
    }
}

/// Ask macOS, wait for the answer (the user clicks).
pub fn request_microphone() -> Permission {
    let Some(audio) = (unsafe { AVMediaTypeAudio }) else { return Permission::Unsupported };
    let (tx, rx) = mpsc::channel();
    let block = RcBlock::new(move |granted: Bool| {
        let _ = tx.send(granted.as_bool());
    });
    unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &block) };
    match rx.recv_timeout(Duration::from_secs(600)) {
        Ok(true) => Permission::Granted,
        Ok(false) => Permission::Denied,
        Err(_) => microphone(),
    }
}

// The audio capture permission has no public query. TCC's own preflight
// and request calls answer it; they are looked up at run time, and if
// they are missing the state is NotDetermined and the first tap asks.
type Preflight = unsafe extern "C" fn(service: *const CFString, options: *const c_void) -> i32;
type Request = unsafe extern "C" fn(service: *const CFString, options: *const c_void, callback: *const c_void);

const TCC: &CStr = c"/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC";

fn tcc_symbol(name: &CStr) -> Option<*mut c_void> {
    unsafe {
        let handle = libc::dlopen(TCC.as_ptr(), libc::RTLD_LAZY);
        if handle.is_null() {
            return None;
        }
        let sym = libc::dlsym(handle, name.as_ptr());
        (!sym.is_null()).then_some(sym)
    }
}

fn service() -> objc2_core_foundation::CFRetained<CFString> {
    CFString::from_static_str("kTCCServiceAudioCapture")
}

pub fn system_audio() -> Permission {
    if !supports_taps() {
        return Permission::Unsupported;
    }
    let Some(sym) = tcc_symbol(c"TCCAccessPreflight") else { return Permission::NotDetermined };
    let preflight: Preflight = unsafe { std::mem::transmute(sym) };
    let s = service();
    match unsafe { preflight(&*s, std::ptr::null()) } {
        0 => Permission::Granted,
        1 => Permission::Denied,
        _ => Permission::NotDetermined,
    }
}

pub fn request_system_audio() -> Permission {
    if !supports_taps() {
        return Permission::Unsupported;
    }
    let Some(sym) = tcc_symbol(c"TCCAccessRequest") else { return system_audio() };
    let request: Request = unsafe { std::mem::transmute(sym) };
    let (tx, rx) = mpsc::channel();
    let block = RcBlock::new(move |granted: Bool| {
        let _ = tx.send(granted.as_bool());
    });
    let s = service();
    unsafe { request(&*s, std::ptr::null(), RcBlock::as_ptr(&block) as *const c_void) };
    match rx.recv_timeout(Duration::from_secs(600)) {
        Ok(true) => Permission::Granted,
        Ok(false) => Permission::Denied,
        Err(_) => system_audio(),
    }
}
