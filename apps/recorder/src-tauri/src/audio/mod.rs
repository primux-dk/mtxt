//! Capture, mixing and encoding.

pub mod capture;
#[cfg(target_os = "macos")]
pub mod macos_tap;
pub mod ogg_opus;
pub mod recorder;
pub mod resample;
