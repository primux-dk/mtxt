//! Reading a recording file back after a crash, or a file found without its
//! state. Only a file positively established as empty may be forgotten: it
//! exists and has size 0, or a complete read found no audio packet. Any I/O
//! error is an error, and the caller keeps both files.

use chrono::{DateTime, Utc};
use std::path::Path;

#[derive(Debug, Clone, PartialEq)]
pub enum FileCheck {
    Empty,
    Readable { at: DateTime<Utc>, duration_s: u64, sha256: String, size_bytes: u64 },
    Error(String),
}

pub fn inspect_file(path: &Path) -> FileCheck {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) => return FileCheck::Error(e.to_string()),
    };
    if meta.is_file() && meta.len() == 0 {
        return FileCheck::Empty;
    }
    let seen = match crate::audio::ogg_opus::inspect(path) {
        Ok(s) => s,
        Err(e) => return FileCheck::Error(e.to_string()),
    };
    if seen.audio_packets == 0 {
        return FileCheck::Empty;
    }
    match super::chunks::hash_file(path) {
        Ok((sha256, size_bytes)) => FileCheck::Readable {
            at: meta.modified().map(DateTime::<Utc>::from).unwrap_or_else(|_| Utc::now()),
            duration_s: seen.duration_s.round() as u64,
            sha256,
            size_bytes,
        },
        Err(e) => FileCheck::Error(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::ogg_opus::{OggOpusWriter, FRAME};
    use std::os::unix::fs::PermissionsExt;

    fn recording(path: &Path, frames: usize) {
        let mut w = OggOpusWriter::create(path).unwrap();
        for _ in 0..frames {
            w.write_frame(&vec![0.1f32; FRAME * 2]).unwrap();
        }
        w.finish().unwrap();
    }

    #[test]
    fn a_permission_error_is_not_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("r.ogg");
        recording(&path, 100);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        let check = inspect_file(&path);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(matches!(check, FileCheck::Error(ref e) if e.contains("ermission")), "{check:?}");
        assert!(path.exists());
    }

    #[test]
    fn an_io_error_while_reading_is_not_empty() {
        // A read that fails after the open: a directory under the file's name
        // opens and then fails every read (EISDIR), as a failing disk does.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("r.ogg");
        std::fs::create_dir(&path).unwrap();
        assert!(matches!(inspect_file(&path), FileCheck::Error(_)));
        // A missing file is not empty either.
        assert!(matches!(inspect_file(&dir.path().join("gone.ogg")), FileCheck::Error(_)));
    }

    #[test]
    fn only_a_file_without_audio_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let zero = dir.path().join("zero.ogg");
        std::fs::write(&zero, b"").unwrap();
        assert_eq!(inspect_file(&zero), FileCheck::Empty);
        let headers = dir.path().join("headers.ogg");
        OggOpusWriter::create(&headers).unwrap().sync().unwrap();
        assert_eq!(inspect_file(&headers), FileCheck::Empty);
        let full = dir.path().join("full.ogg");
        recording(&full, 150);
        assert!(matches!(inspect_file(&full), FileCheck::Readable { duration_s: 3, .. }));
    }
}
