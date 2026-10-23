//! Retry delays while a recording is Pending: 2 s, doubling, at most 5 minutes,
//! with ±20 % jitter so a room full of recorders does not retry in step.

use std::time::Duration;

pub const BASE: Duration = Duration::from_secs(2);
pub const CAP: Duration = Duration::from_secs(300);

/// The delay before attempt `attempt + 1`, after `attempt` failures (1 or more).
/// `jitter` is a number in [0, 1) from the caller, so tests can fix it.
pub fn delay(attempt: u32, jitter: f64) -> Duration {
    let exp = attempt.saturating_sub(1).min(16);
    let raw = BASE.as_secs_f64() * f64::from(1u32 << exp);
    let capped = raw.min(CAP.as_secs_f64());
    let factor = 0.8 + 0.4 * jitter.clamp(0.0, 1.0);
    Duration::from_secs_f64((capped * factor).min(CAP.as_secs_f64()))
}

/// A jitter value from the OS random source.
pub fn random_jitter() -> f64 {
    let mut b = [0u8; 4];
    let _ = getrandom::fill(&mut b);
    f64::from(u32::from_le_bytes(b)) / (f64::from(u32::MAX) + 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doubles_from_two_seconds_up_to_five_minutes() {
        let mid = |a| delay(a, 0.5).as_secs_f64();
        assert_eq!(mid(1), 2.0);
        assert_eq!(mid(2), 4.0);
        assert_eq!(mid(3), 8.0);
        assert_eq!(mid(8), 256.0);
        assert_eq!(mid(9), 300.0);
        assert_eq!(mid(40), 300.0);
        assert_eq!(mid(u32::MAX), 300.0);
    }

    #[test]
    fn jitter_stays_within_twenty_percent_and_under_the_cap() {
        assert!((delay(3, 0.0).as_secs_f64() - 6.4).abs() < 1e-9);
        assert!((delay(3, 0.999_999).as_secs_f64() - 9.6).abs() < 1e-4);
        assert!(delay(20, 0.999).as_secs_f64() <= 300.0);
        for _ in 0..100 {
            let j = random_jitter();
            assert!((0.0..1.0).contains(&j));
        }
    }
}
