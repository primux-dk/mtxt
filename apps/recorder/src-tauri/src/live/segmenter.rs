//! Cuts the 16 kHz mono stream into what the model reads: a partial pass over
//! the utterance so far every 1.5 seconds, and a final pass when the speaker
//! pauses for 600 ms or the utterance reaches 12 seconds. Silence before
//! speech is not decoded at all, which keeps Whisper from inventing words.

pub const RATE: usize = 16_000;
const FRAME: usize = RATE * 30 / 1000; // 30 ms
const PRE_ROLL: usize = RATE * 3 / 10;
const MIN_PARTIAL: usize = RATE;
const PARTIAL_EVERY: usize = RATE * 3 / 2;
const PAUSE: usize = RATE * 6 / 10;
const MAX_UTTERANCE: usize = RATE * 12;
const MIN_SPEECH_RMS: f32 = 0.006;

#[derive(Debug, Clone, PartialEq)]
pub enum Cut {
    Partial(Vec<f32>),
    Final(Vec<f32>),
}

pub struct Segmenter {
    buf: Vec<f32>,
    pending: Vec<f32>,
    speech: bool,
    silence: usize,
    since_partial: usize,
    noise: f32,
}

impl Default for Segmenter {
    fn default() -> Self {
        Segmenter { buf: Vec::new(), pending: Vec::new(), speech: false, silence: 0, since_partial: 0, noise: 0.002 }
    }
}

impl Segmenter {
    pub fn push(&mut self, samples: &[f32]) -> Vec<Cut> {
        self.pending.extend_from_slice(samples);
        let mut cuts = Vec::new();
        let mut at = 0;
        while self.pending.len() - at >= FRAME {
            let frame: Vec<f32> = self.pending[at..at + FRAME].to_vec();
            at += FRAME;
            if let Some(cut) = self.frame(&frame) {
                cuts.push(cut);
            }
        }
        self.pending.drain(..at);
        // Only the newest partial matters.
        let last_partial = cuts.iter().rposition(|c| matches!(c, Cut::Partial(_)));
        let mut i = 0;
        cuts.retain(|c| {
            let keep = !matches!(c, Cut::Partial(_)) || Some(i) == last_partial;
            i += 1;
            keep
        });
        cuts
    }

    fn frame(&mut self, frame: &[f32]) -> Option<Cut> {
        let rms = (frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32).sqrt();
        let voiced = rms > MIN_SPEECH_RMS.max(self.noise * 3.0);
        if !voiced {
            // The floor follows quiet frames slowly upwards and loud ones never.
            self.noise = 0.95 * self.noise + 0.05 * rms;
        }
        self.buf.extend_from_slice(frame);
        if !self.speech {
            if voiced {
                self.speech = true;
                self.silence = 0;
                self.since_partial = 0;
            } else if self.buf.len() > PRE_ROLL {
                let excess = self.buf.len() - PRE_ROLL;
                self.buf.drain(..excess);
            }
            return None;
        }
        self.since_partial += frame.len();
        self.silence = if voiced { 0 } else { self.silence + frame.len() };
        if self.silence >= PAUSE || self.buf.len() >= MAX_UTTERANCE {
            return Some(Cut::Final(self.take()));
        }
        if self.buf.len() >= MIN_PARTIAL && self.since_partial >= PARTIAL_EVERY {
            self.since_partial = 0;
            return Some(Cut::Partial(self.buf.clone()));
        }
        None
    }

    fn take(&mut self) -> Vec<f32> {
        self.speech = false;
        self.silence = 0;
        self.since_partial = 0;
        std::mem::take(&mut self.buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(secs: f32) -> Vec<f32> {
        (0..(secs * RATE as f32) as usize).map(|i| (i as f32 * 0.07).sin() * 0.2).collect()
    }

    fn quiet(secs: f32) -> Vec<f32> {
        vec![0.0005; (secs * RATE as f32) as usize]
    }

    #[test]
    fn silence_alone_is_never_decoded() {
        let mut s = Segmenter::default();
        assert!(s.push(&quiet(30.0)).is_empty());
        assert!(s.buf.len() <= PRE_ROLL);
    }

    #[test]
    fn a_pause_ends_an_utterance() {
        let mut s = Segmenter::default();
        let mut cuts = s.push(&quiet(1.0));
        cuts.extend(s.push(&tone(3.0)));
        cuts.extend(s.push(&quiet(1.0)));
        let partials = cuts.iter().filter(|c| matches!(c, Cut::Partial(_))).count();
        let finals: Vec<usize> = cuts
            .iter()
            .filter_map(|c| if let Cut::Final(a) = c { Some(a.len()) } else { None })
            .collect();
        assert!(partials >= 1, "{cuts:?}");
        assert_eq!(finals.len(), 1);
        // Pre-roll + speech + the pause: about 3.9 s.
        let secs = finals[0] as f32 / RATE as f32;
        assert!((3.6..4.2).contains(&secs), "{secs}");
    }

    #[test]
    fn a_long_utterance_is_cut_at_twelve_seconds() {
        let mut s = Segmenter::default();
        let cuts = s.push(&tone(25.0));
        let finals = cuts.iter().filter(|c| matches!(c, Cut::Final(_))).count();
        assert_eq!(finals, 2);
        for c in &cuts {
            if let Cut::Final(a) = c {
                assert!(a.len() <= MAX_UTTERANCE);
            }
        }
    }

    #[test]
    fn small_blocks_give_the_same_cuts() {
        let audio: Vec<f32> = [quiet(0.5), tone(2.0), quiet(1.0)].concat();
        let mut s = Segmenter::default();
        let mut cuts = Vec::new();
        for block in audio.chunks(320) {
            cuts.extend(s.push(block));
        }
        assert_eq!(cuts.iter().filter(|c| matches!(c, Cut::Final(_))).count(), 1);
    }
}
