//! Chunk arithmetic and the file hash. Chunk n (1-based) holds bytes
//! (n-1) × chunk_size onwards; every chunk but the last is exactly chunk_size.

use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

/// 8 MiB, the v0.1 server's `chunk_size_bytes`. The create response decides; this is the fallback.
pub const CHUNK_SIZE: u64 = 8 * 1024 * 1024;

pub fn chunk_count(size: u64, chunk_size: u64) -> u64 {
    if size == 0 || chunk_size == 0 {
        return 0;
    }
    size.div_ceil(chunk_size)
}

/// Byte offset and length of chunk `n`, or None past the end.
pub fn chunk_range(n: u64, size: u64, chunk_size: u64) -> Option<(u64, u64)> {
    if n == 0 || n > chunk_count(size, chunk_size) {
        return None;
    }
    let start = (n - 1) * chunk_size;
    Some((start, chunk_size.min(size - start)))
}

/// The chunks the server lacks, ascending: the resume list.
pub fn missing(count: u64, received: &[u64]) -> Vec<u64> {
    (1..=count).filter(|n| received.binary_search(n).is_err()).collect()
}

/// Lowercase hex SHA-256 and size of a file, read in 1 MiB blocks.
pub fn hash_file(path: &Path) -> std::io::Result<(String, u64)> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    let mut size = 0u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        size += n as u64;
    }
    Ok((hex::encode(hasher.finalize()), size))
}

/// Read chunk `n` of the file.
pub fn read_chunk(path: &Path, n: u64, size: u64, chunk_size: u64) -> std::io::Result<Vec<u8>> {
    use std::io::{Seek, SeekFrom};
    let (start, len) = chunk_range(n, size, chunk_size)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "chunk past the end"))?;
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut buf = vec![0u8; len as usize];
    file.read_exact(&mut buf)?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn counts_and_ranges() {
        assert_eq!(chunk_count(0, CHUNK_SIZE), 0);
        assert_eq!(chunk_count(1, CHUNK_SIZE), 1);
        assert_eq!(chunk_count(CHUNK_SIZE, CHUNK_SIZE), 1);
        assert_eq!(chunk_count(CHUNK_SIZE + 1, CHUNK_SIZE), 2);
        // A 4-hour meeting of 200 MB: 24 chunks, the last one short.
        let size = 200_000_000;
        assert_eq!(chunk_count(size, CHUNK_SIZE), 24);
        assert_eq!(chunk_range(1, size, CHUNK_SIZE), Some((0, CHUNK_SIZE)));
        assert_eq!(chunk_range(24, size, CHUNK_SIZE), Some((23 * CHUNK_SIZE, size - 23 * CHUNK_SIZE)));
        assert_eq!(chunk_range(25, size, CHUNK_SIZE), None);
        assert_eq!(chunk_range(0, size, CHUNK_SIZE), None);
    }

    #[test]
    fn missing_is_the_resume_list() {
        assert_eq!(missing(5, &[]), vec![1, 2, 3, 4, 5]);
        assert_eq!(missing(5, &[1, 2, 4]), vec![3, 5]);
        assert_eq!(missing(3, &[1, 2, 3]), Vec::<u64>::new());
    }

    #[test]
    fn hash_and_chunks_read_the_file() {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        let data: Vec<u8> = (0..2_500_000u32).map(|i| (i % 251) as u8).collect();
        f.write_all(&data).unwrap();
        let (hash, size) = hash_file(f.path()).unwrap();
        assert_eq!(size, data.len() as u64);
        assert_eq!(hash, hex::encode(Sha256::digest(&data)));
        let chunk = 1_000_000;
        let mut joined = Vec::new();
        for n in 1..=chunk_count(size, chunk) {
            joined.extend(read_chunk(f.path(), n, size, chunk).unwrap());
        }
        assert_eq!(joined, data);
        assert_eq!(read_chunk(f.path(), 3, size, chunk).unwrap().len(), 500_000);
        assert!(read_chunk(f.path(), 4, size, chunk).is_err());
    }

    #[test]
    fn empty_file_hash() {
        let f = tempfile::NamedTempFile::new().unwrap();
        assert_eq!(
            hash_file(f.path()).unwrap(),
            ("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".into(), 0)
        );
    }
}
