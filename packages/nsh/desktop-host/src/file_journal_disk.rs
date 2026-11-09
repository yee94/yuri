//! A fixed-size two-slot file; never rename/ReplaceFileW an existing journal.
//! The previous committed slot survives an interrupted write. A staging marker is
//! synced BEFORE touching its payload; commit magic is written LAST, then synced.
//! Corrupt committed slots fail closed, never silently fall back to old history.
use super::{Disk, Result, Snapshot, WIRE, hash::sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};
#[path = "file_journal_platform.rs"]
mod platform;

const HEADER: usize = 64;
const SLOT: usize = WIRE + HEADER;
const SIZE: u64 = (2 * SLOT) as u64;
const COMMITTED: &[u8; 8] = b"YFJNL001";
const STAGING: &[u8; 8] = b"YFSTG001";
pub(super) struct Files {
    file: File,
    directory: platform::Directory,
}
impl Files {
    pub(super) fn open(data_dir: &Path, namespace: &str) -> Result<Self> {
        if namespace.is_empty()
            || namespace.len() > 64
            || !namespace
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        {
            return Err("file_journal_namespace");
        }
        let directory = platform::Directory::open(data_dir, namespace)?;
        let (file, fresh) = directory.file()?;
        let mut files = Self { file, directory };
        if fresh {
            files
                .file
                .set_len(SIZE)
                .map_err(|_| "file_journal_initialize")?;
            files.write(&Snapshot::empty())?;
            files.sync()?;
        }
        Ok(files)
    }
    fn slot(&mut self, index: usize) -> Result<Option<Snapshot>> {
        self.file
            .seek(SeekFrom::Start((index * SLOT) as u64))
            .map_err(|_| "file_journal_read")?;
        let mut header = [0u8; HEADER];
        self.file
            .read_exact(&mut header)
            .map_err(|_| "file_journal_read")?;
        if header[..8] == STAGING[..] || header.iter().all(|v| *v == 0) {
            return Ok(None);
        }
        if header[..8] != COMMITTED[..] || header[48..].iter().any(|b| *b != 0) {
            return Err("file_journal_corrupt");
        }
        let len = u64::from_le_bytes(header[8..16].try_into().unwrap());
        if len == 0 || len > WIRE as u64 {
            return Err("file_journal_corrupt");
        }
        let mut bytes = vec![0; len as usize];
        self.file
            .read_exact(&mut bytes)
            .map_err(|_| "file_journal_read")?;
        if sha256(&bytes) != header[16..48] {
            return Err("file_journal_corrupt");
        }
        let snapshot =
            Snapshot::parse(&serde_json::from_slice(&bytes).map_err(|_| "file_journal_corrupt")?)?;
        if snapshot.version % 2 != index as u64 {
            return Err("file_journal_corrupt");
        }
        Ok(Some(snapshot))
    }
}
impl Disk for Files {
    fn read(&mut self) -> Result<Snapshot> {
        platform::regular(&self.file)?;
        if self.file.metadata().map_err(|_| "file_journal_read")?.len() != SIZE {
            return Err("file_journal_corrupt");
        }
        let a = self.slot(0)?;
        let b = self.slot(1)?;
        match (a, b) {
            (Some(a), Some(b)) => {
                if a.version.abs_diff(b.version) != 1 {
                    return Err("file_journal_corrupt");
                }
                Ok(if a.version > b.version { a } else { b })
            }
            (Some(a), None) | (None, Some(a)) => Ok(a),
            _ => Err("file_journal_corrupt"),
        }
    }
    fn write(&mut self, snapshot: &Snapshot) -> Result<()> {
        platform::regular(&self.file)?;
        let bytes = serde_json::to_vec(&snapshot.value()).map_err(|_| "file_journal_schema")?;
        if bytes.len() > WIRE {
            return Err("file_journal_capacity");
        }
        let offset = (snapshot.version % 2) * SLOT as u64;
        self.file
            .seek(SeekFrom::Start(offset))
            .map_err(|_| "file_journal_write")?;
        self.file
            .write_all(STAGING)
            .map_err(|_| "file_journal_write")?;
        self.sync()?;
        self.file
            .seek(SeekFrom::Start(offset + HEADER as u64))
            .map_err(|_| "file_journal_write")?;
        self.file
            .write_all(&bytes)
            .map_err(|_| "file_journal_write")?;
        let mut header = [0u8; HEADER];
        header[8..16].copy_from_slice(&(bytes.len() as u64).to_le_bytes());
        header[16..48].copy_from_slice(&sha256(&bytes));
        self.file
            .seek(SeekFrom::Start(offset + 8))
            .map_err(|_| "file_journal_write")?;
        self.file
            .write_all(&header[8..])
            .map_err(|_| "file_journal_write")?;
        // Complete payload + digest must reach persistent media before publication.
        self.sync()?;
        self.file
            .seek(SeekFrom::Start(offset))
            .map_err(|_| "file_journal_write")?;
        self.file
            .write_all(COMMITTED)
            .map_err(|_| "file_journal_write")?;
        self.sync()
    }
    fn sync(&mut self) -> Result<()> {
        platform::flush(&self.file)?;
        self.directory.sync()
    }
}
