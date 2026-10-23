//! The two local models, where they live, and their download from Hugging
//! Face on first use: resumable, checked against each file's SHA-256.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

pub struct ModelFile {
    pub name: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

pub struct ModelSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub repo: &'static str,
    /// The Hugging Face commit the files are fetched from: a fixed revision,
    /// so the checksums below always describe what is downloaded.
    pub revision: &'static str,
    pub files: &'static [ModelFile],
}

impl ModelSpec {
    pub fn total_size(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }
}

/// Parakeet TDT 0.6B v3 (NVIDIA, CC-BY-4.0), int8 ONNX export. The default: it speaks Danish.
pub const PARAKEET: ModelSpec = ModelSpec {
    id: "parakeet",
    label: "Parakeet",
    repo: "istupakov/parakeet-tdt-0.6b-v3-onnx",
    revision: "8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce",
    files: &[
        ModelFile {
            name: "config.json",
            size: 97,
            sha256: "666903c76b9798caf2c210afd4f6cd60b08a8dbf9800ec8d7a3bc0d2148ac466",
        },
        ModelFile {
            name: "vocab.txt",
            size: 93_939,
            sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
        },
        ModelFile {
            name: "nemo128.onnx",
            size: 139_764,
            sha256: "a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f",
        },
        ModelFile {
            name: "decoder_joint-model.int8.onnx",
            size: 18_202_004,
            sha256: "eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70",
        },
        ModelFile {
            name: "encoder-model.int8.onnx",
            size: 652_183_999,
            sha256: "6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09",
        },
    ],
};

/// Whisper large-v3-turbo (OpenAI, MIT), whisper.cpp q5_0. The fallback.
pub const WHISPER: ModelSpec = ModelSpec {
    id: "whisper",
    label: "Whisper",
    repo: "ggerganov/whisper.cpp",
    revision: "5359861c739e955e79d9a303bcbc70fb988958b1",
    files: &[ModelFile {
        name: "ggml-large-v3-turbo-q5_0.bin",
        size: 574_041_195,
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    }],
};

pub const ALL: [&ModelSpec; 2] = [&PARAKEET, &WHISPER];

/// The models this build can run: Parakeet needs ONNX Runtime, which is in
/// the Apple silicon build only.
pub fn available() -> Vec<&'static ModelSpec> {
    ALL.into_iter()
        .filter(|s| match s.id {
            "parakeet" => cfg!(all(feature = "parakeet", any(target_arch = "aarch64", target_os = "windows"))),
            "whisper" => cfg!(feature = "whisper"),
            _ => false,
        })
        .collect()
}

/// The model to use: the chosen one if this build has it, else the first it has.
pub fn usable(chosen: &str) -> &'static str {
    let have = available();
    have.iter().find(|s| s.id == chosen).or(have.first()).map(|s| s.id).unwrap_or("parakeet")
}

pub fn url(spec: &ModelSpec, file: &ModelFile) -> String {
    format!("https://huggingface.co/{}/resolve/{}/{}", spec.repo, spec.revision, file.name)
}

pub fn spec(id: &str) -> Option<&'static ModelSpec> {
    ALL.into_iter().find(|s| s.id == id)
}

pub fn dir(models_dir: &Path, spec: &ModelSpec) -> PathBuf {
    models_dir.join(spec.id)
}

/// Every file is there at its full size. The hash was checked when it landed.
pub fn is_downloaded(models_dir: &Path, spec: &ModelSpec) -> bool {
    let d = dir(models_dir, spec);
    spec.files.iter().all(|f| std::fs::metadata(d.join(f.name)).map(|m| m.len() == f.size).unwrap_or(false))
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Progress {
    pub done: u64,
    pub total: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum DownloadError {
    #[error("cancelled")]
    Cancelled,
    #[error("network: {0}")]
    Network(String),
    #[error("{0} does not match its checksum")]
    Checksum(String),
    #[error("disk: {0}")]
    Disk(#[from] std::io::Error),
}

/// Download every missing file. Blocking; run it on its own thread.
pub fn download(
    models_dir: &Path,
    spec: &ModelSpec,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(Progress),
) -> Result<(), DownloadError> {
    let d = dir(models_dir, spec);
    std::fs::create_dir_all(&d)?;
    let total = spec.total_size();
    let mut done_before = 0u64;
    let client = reqwest::blocking::Client::builder()
        .user_agent(crate::api::USER_AGENT)
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(None)
        .build()
        .map_err(|e| DownloadError::Network(e.to_string()))?;
    for f in spec.files {
        let target = d.join(f.name);
        if std::fs::metadata(&target).map(|m| m.len() == f.size).unwrap_or(false) {
            done_before += f.size;
            progress(Progress { done: done_before, total });
            continue;
        }
        let part = d.join(format!("{}.part", f.name));
        // Resume: hash what is already there, then ask for the rest.
        let (mut hasher, mut have) = hash_partial(&part)?;
        if have > f.size {
            std::fs::remove_file(&part)?;
            hasher = Sha256::new();
            have = 0;
        }
        // A partial as large as the file (a crash before the rename): check
        // it and install it, without asking the server for an empty range.
        if have == f.size {
            finish_file(&part, &target, hasher, f)?;
            done_before += f.size;
            progress(Progress { done: done_before, total });
            continue;
        }
        let url = url(spec, f);
        let mut req = client.get(&url);
        if have > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
        }
        let mut res = req.send().map_err(|e| DownloadError::Network(e.without_url().to_string()))?;
        let status = res.status();
        if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            // The server says the partial already holds everything it has:
            // start this file again rather than trust it.
            std::fs::remove_file(&part)?;
            return Err(DownloadError::Network("HTTP 416; the file starts again on the next try".into()));
        }
        if have > 0 && status == reqwest::StatusCode::OK {
            // The server ignored the range: start the file again.
            hasher = Sha256::new();
            have = 0;
        } else if !status.is_success() {
            return Err(DownloadError::Network(format!("HTTP {status}")));
        }
        let mut out = std::fs::OpenOptions::new().create(true).append(have > 0).write(true).truncate(have == 0).open(&part)?;
        let mut buf = vec![0u8; 1 << 16];
        let mut last_report = 0u64;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(DownloadError::Cancelled);
            }
            let n = res.read(&mut buf).map_err(|e| DownloadError::Network(e.to_string()))?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n])?;
            hasher.update(&buf[..n]);
            have += n as u64;
            if have - last_report >= 1 << 20 {
                last_report = have;
                progress(Progress { done: done_before + have, total });
            }
        }
        out.sync_all()?;
        drop(out);
        if have != f.size {
            return Err(DownloadError::Network(format!("{} ended at {have} of {} bytes", f.name, f.size)));
        }
        finish_file(&part, &target, hasher, f)?;
        done_before += f.size;
        progress(Progress { done: done_before, total });
    }
    Ok(())
}

fn hash_partial(part: &Path) -> Result<(Sha256, u64), DownloadError> {
    let mut hasher = Sha256::new();
    let mut have = 0u64;
    if let Ok(mut existing) = std::fs::File::open(part) {
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = existing.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            have += n as u64;
        }
    }
    Ok((hasher, have))
}

/// Check the finished partial against the pinned SHA-256 and move it into place.
fn finish_file(part: &Path, target: &Path, hasher: Sha256, f: &ModelFile) -> Result<(), DownloadError> {
    if hex::encode(hasher.finalize()) != f.sha256 {
        let _ = std::fs::remove_file(part);
        return Err(DownloadError::Checksum(f.name.into()));
    }
    std::fs::rename(part, target)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_complete_partial_is_installed_without_a_request() {
        // A model whose only file is already complete as a partial: the
        // download finishes offline (the URL would fail if it were asked).
        static TINY: ModelSpec = ModelSpec {
            id: "tiny",
            label: "Tiny",
            repo: "nobody/nothing",
            revision: "0000000000000000000000000000000000000000",
            files: &[ModelFile {
                name: "m.bin",
                size: 5,
                sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            }],
        };
        let tmp = tempfile::tempdir().unwrap();
        let d = dir(tmp.path(), &TINY);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("m.bin.part"), b"hello").unwrap();
        download(tmp.path(), &TINY, &AtomicBool::new(false), &mut |_| {}).unwrap();
        assert_eq!(std::fs::read(d.join("m.bin")).unwrap(), b"hello");
        assert!(!d.join("m.bin.part").exists());
        // A complete partial with the wrong content is removed, not installed.
        std::fs::remove_file(d.join("m.bin")).unwrap();
        std::fs::write(d.join("m.bin.part"), b"jello").unwrap();
        assert!(matches!(download(tmp.path(), &TINY, &AtomicBool::new(false), &mut |_| {}), Err(DownloadError::Checksum(_))));
        assert!(!d.join("m.bin.part").exists() && !d.join("m.bin").exists());
    }

    #[test]
    fn urls_are_pinned_to_a_revision() {
        for spec in ALL {
            for f in spec.files {
                let u = url(spec, f);
                assert!(u.contains(&format!("/resolve/{}/", spec.revision)), "{u}");
                assert_eq!(spec.revision.len(), 40);
                assert_eq!(f.sha256.len(), 64);
            }
        }
    }

    #[test]
    fn sizes_and_lookup() {
        assert_eq!(PARAKEET.total_size(), 670_619_803);
        assert_eq!(WHISPER.total_size(), 574_041_195);
        assert_eq!(spec("whisper").unwrap().label, "Whisper");
        assert!(spec("other").is_none());
    }

    #[test]
    fn a_model_is_downloaded_only_with_every_file_at_full_size() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!is_downloaded(tmp.path(), &WHISPER));
        let d = dir(tmp.path(), &WHISPER);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("ggml-large-v3-turbo-q5_0.bin"), b"short").unwrap();
        assert!(!is_downloaded(tmp.path(), &WHISPER));
    }
}
