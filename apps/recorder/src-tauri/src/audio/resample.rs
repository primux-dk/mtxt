//! A streaming windowed-sinc resampler for mono f32. Good enough for speech
//! at any pair of rates: a low-pass at 90 % of the lower Nyquist, 16 taps
//! each side, a Blackman window. Equal rates pass through untouched.

use std::collections::VecDeque;
use std::f64::consts::PI;

const HALF_TAPS: usize = 16;

pub struct Resampler {
    ratio: f64, // input samples per output sample
    cutoff: f64,
    /// Input history; `pos` is the next output's position in it.
    buf: VecDeque<f32>,
    pos: f64,
    passthrough: bool,
}

impl Resampler {
    pub fn new(from_rate: u32, to_rate: u32) -> Resampler {
        let ratio = f64::from(from_rate) / f64::from(to_rate);
        let cutoff = 0.9 * (1.0f64).min(1.0 / ratio);
        let mut buf = VecDeque::with_capacity(4096);
        // Start with silence so the first output has its left-hand taps.
        buf.extend(std::iter::repeat_n(0.0, HALF_TAPS));
        Resampler { ratio, cutoff, buf, pos: HALF_TAPS as f64, passthrough: from_rate == to_rate }
    }

    /// Feed input, append the output it makes to `out`.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if self.passthrough {
            out.extend_from_slice(input);
            return;
        }
        self.buf.extend(input.iter().copied());
        while self.pos + (HALF_TAPS as f64) < self.buf.len() as f64 {
            out.push(self.sample_at(self.pos));
            self.pos += self.ratio;
        }
        // Drop what no future output needs.
        let keep_from = (self.pos.floor() as usize).saturating_sub(HALF_TAPS);
        if keep_from > 0 {
            self.buf.drain(..keep_from);
            self.pos -= keep_from as f64;
        }
    }

    fn sample_at(&self, pos: f64) -> f32 {
        let centre = pos.floor() as isize;
        let frac = pos - centre as f64;
        let mut acc = 0.0f64;
        for k in -(HALF_TAPS as isize) + 1..=(HALF_TAPS as isize) {
            let idx = centre + k;
            if idx < 0 || idx as usize >= self.buf.len() {
                continue;
            }
            let t = k as f64 - frac;
            acc += f64::from(self.buf[idx as usize]) * self.kernel(t);
        }
        acc as f32
    }

    fn kernel(&self, t: f64) -> f64 {
        let x = t * self.cutoff;
        let sinc = if x.abs() < 1e-9 { 1.0 } else { (PI * x).sin() / (PI * x) };
        let n = t / HALF_TAPS as f64; // -1..1
        if n.abs() >= 1.0 {
            return 0.0;
        }
        let w = 0.42 + 0.5 * (PI * n).cos() + 0.08 * (2.0 * PI * n).cos();
        self.cutoff * sinc * w
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(rate: u32, freq: f64, secs: f64) -> Vec<f32> {
        (0..(f64::from(rate) * secs) as usize)
            .map(|i| (2.0 * PI * freq * i as f64 / f64::from(rate)).sin() as f32 * 0.5)
            .collect()
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| f64::from(*v).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
    }

    #[test]
    fn output_length_follows_the_ratio_across_blocks() {
        let mut r = Resampler::new(48_000, 16_000);
        let input = sine(48_000, 440.0, 1.0);
        let mut out = Vec::new();
        for block in input.chunks(480) {
            r.process(block, &mut out);
        }
        assert!((out.len() as i64 - 16_000).abs() < 20, "{}", out.len());
        let mut up = Resampler::new(44_100, 48_000);
        let mut out = Vec::new();
        up.process(&sine(44_100, 440.0, 1.0), &mut out);
        assert!((out.len() as i64 - 48_000).abs() < 30, "{}", out.len());
    }

    #[test]
    fn speech_band_passes_and_alias_band_is_cut() {
        let mut r = Resampler::new(48_000, 16_000);
        let mut out = Vec::new();
        r.process(&sine(48_000, 1_000.0, 1.0), &mut out);
        let kept = rms(&out[1000..]);
        assert!((kept - 0.5 / 2f64.sqrt()).abs() < 0.02, "{kept}");
        // 12 kHz is above the 8 kHz Nyquist of 16 kHz: it must not fold back.
        let mut r = Resampler::new(48_000, 16_000);
        let mut out = Vec::new();
        r.process(&sine(48_000, 12_000.0, 1.0), &mut out);
        assert!(rms(&out[1000..]) < 0.01);
    }

    #[test]
    fn equal_rates_pass_through() {
        let mut r = Resampler::new(48_000, 48_000);
        let mut out = Vec::new();
        r.process(&[0.1, 0.2, 0.3], &mut out);
        assert_eq!(out, vec![0.1, 0.2, 0.3]);
    }
}
