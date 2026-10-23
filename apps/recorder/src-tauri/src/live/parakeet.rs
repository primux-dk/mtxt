//! Parakeet TDT 0.6B v3 through ONNX Runtime: the int8 export in three
//! graphs. `nemo128.onnx` turns 16 kHz samples into 128 log-mel features,
//! the encoder turns those into one 1024-wide vector per 80 ms, and the
//! decoder-joint graph is stepped greedily over the encoder frames the way
//! token-and-duration transducers decode: each step picks a token and how
//! many frames to skip.

use super::Engine;
use ort::session::Session;
use ort::value::Tensor;
use std::path::Path;

/// Frames a step may skip, by the duration logit's index.
const DURATIONS: [usize; 5] = [0, 1, 2, 3, 4];
/// Tokens one frame may emit before the decoder must move on.
const MAX_SYMBOLS_PER_FRAME: usize = 10;
const STATE: usize = 640;

pub struct Parakeet {
    preprocessor: Session,
    encoder: Session,
    decoder: Session,
    vocab: Vec<String>,
    blank: usize,
}

type BoxError = Box<dyn std::error::Error + Send + Sync>;

impl Parakeet {
    pub fn load(dir: &Path) -> Result<Parakeet, BoxError> {
        let env = ort::init().with_name("mtxt-live").build()?;
        let threads = std::thread::available_parallelism().map(|n| n.get().clamp(1, 4)).unwrap_or(2);
        let open = |file: &str| -> Result<Session, BoxError> {
            let mut builder = Session::builder(&env)?.with_intra_threads(threads).map_err(|e| e.to_string())?;
            Ok(builder.commit_from_file(dir.join(file))?)
        };
        let vocab = parse_vocab(&std::fs::read_to_string(dir.join("vocab.txt"))?);
        let blank = vocab.iter().position(|t| t == "<blk>").unwrap_or(vocab.len().saturating_sub(1));
        Ok(Parakeet {
            preprocessor: open("nemo128.onnx")?,
            encoder: open("encoder-model.int8.onnx")?,
            decoder: open("decoder_joint-model.int8.onnx")?,
            vocab,
            blank,
        })
    }

    fn run(&mut self, audio: &[f32]) -> Result<String, BoxError> {
        if audio.len() < 1_600 {
            return Ok(String::new());
        }
        let n = audio.len();
        let out = self.preprocessor.run(ort::inputs![
            "waveforms" => Tensor::from_array(([1usize, n], audio.to_vec()))?,
            "waveforms_lens" => Tensor::from_array(([1usize], vec![n as i64]))?,
        ])?;
        let (shape, features) = out["features"].try_extract_tensor::<f32>()?;
        let dims: Vec<usize> = shape.iter().map(|d| *d as usize).collect();
        let (_, lens) = out["features_lens"].try_extract_tensor::<i64>()?;
        let features = Tensor::from_array((dims, features.to_vec()))?;
        let lens = Tensor::from_array(([1usize], lens.to_vec()))?;
        drop(out);

        let out = self.encoder.run(ort::inputs!["audio_signal" => features, "length" => lens])?;
        let (shape, encoded) = out["outputs"].try_extract_tensor::<f32>()?;
        let (width, frames) = (shape[1] as usize, shape[2] as usize);
        let (_, enc_lens) = out["encoded_lengths"].try_extract_tensor::<i64>()?;
        let valid = (enc_lens.first().copied().unwrap_or(frames as i64) as usize).min(frames);
        let encoded = encoded.to_vec();
        drop(out);

        let tokens = self.decode(&encoded, width, frames, valid)?;
        Ok(detokenize(&self.vocab, &tokens))
    }

    fn decode(&mut self, encoded: &[f32], width: usize, frames: usize, valid: usize) -> Result<Vec<usize>, BoxError> {
        let mut state1 = vec![0f32; 2 * STATE];
        let mut state2 = vec![0f32; 2 * STATE];
        let mut last = self.blank as i32;
        let mut tokens = Vec::new();
        let mut t = 0;
        let mut emitted = 0;
        let mut frame = vec![0f32; width];
        while t < valid {
            // Layout [1, width, frames]: element d of frame t is at d * frames + t.
            for (d, slot) in frame.iter_mut().enumerate() {
                *slot = encoded[d * frames + t];
            }
            let out = self.decoder.run(ort::inputs![
                "encoder_outputs" => Tensor::from_array(([1usize, width, 1], frame.clone()))?,
                "targets" => Tensor::from_array(([1usize, 1], vec![last]))?,
                "target_length" => Tensor::from_array(([1usize], vec![1i32]))?,
                "input_states_1" => Tensor::from_array(([2usize, 1, STATE], state1.clone()))?,
                "input_states_2" => Tensor::from_array(([2usize, 1, STATE], state2.clone()))?,
            ])?;
            let (_, logits) = out["outputs"].try_extract_tensor::<f32>()?;
            let vocab_size = logits.len() - DURATIONS.len();
            let token = argmax(&logits[..vocab_size]);
            let step = DURATIONS[argmax(&logits[vocab_size..])];
            if token != self.blank {
                tokens.push(token);
                last = token as i32;
                state1 = out["output_states_1"].try_extract_tensor::<f32>()?.1.to_vec();
                state2 = out["output_states_2"].try_extract_tensor::<f32>()?.1.to_vec();
                emitted += 1;
            }
            if step > 0 {
                t += step;
                emitted = 0;
            } else if token == self.blank || emitted >= MAX_SYMBOLS_PER_FRAME {
                t += 1;
                emitted = 0;
            }
        }
        Ok(tokens)
    }
}

impl Engine for Parakeet {
    fn transcribe(&mut self, audio: &[f32]) -> Result<String, String> {
        self.run(audio).map_err(|e| e.to_string())
    }
}

fn argmax(v: &[f32]) -> usize {
    let mut best = 0;
    for (i, x) in v.iter().enumerate() {
        if *x > v[best] {
            best = i;
        }
    }
    best
}

/// `vocab.txt`: one `token id` per line.
pub fn parse_vocab(text: &str) -> Vec<String> {
    let mut entries: Vec<(usize, String)> = text
        .lines()
        .filter_map(|line| {
            let (token, id) = line.rsplit_once(' ')?;
            Some((id.trim().parse().ok()?, token.to_string()))
        })
        .collect();
    entries.sort_by_key(|(id, _)| *id);
    let mut vocab = vec![String::new(); entries.last().map(|(id, _)| id + 1).unwrap_or(0)];
    for (id, token) in entries {
        vocab[id] = token;
    }
    vocab
}

/// SentencePiece pieces to text: `▁` starts a word; special tokens are dropped.
pub fn detokenize(vocab: &[String], tokens: &[usize]) -> String {
    let mut text = String::new();
    for &t in tokens {
        let Some(piece) = vocab.get(t) else { continue };
        if piece.starts_with('<') && piece.ends_with('>') {
            continue;
        }
        text.push_str(&piece.replace('\u{2581}', " "));
    }
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vocab_and_pieces() {
        let vocab = parse_vocab("<unk> 0\n\u{2581}Hej 1\n\u{2581}med 2\nd 3\ndig 4\n<blk> 5\n");
        assert_eq!(vocab.len(), 6);
        assert_eq!(vocab[5], "<blk>");
        assert_eq!(detokenize(&vocab, &[1, 2, 4, 5, 0]), "Hej meddig");
        assert_eq!(detokenize(&vocab, &[]), "");
        assert_eq!(argmax(&[0.1, 0.9, 0.3]), 1);
    }
}
