//! Credential-free private receipt store. The directory is chosen/secured by the native Host,
//! never by JS. Only one notification owner/process may use it at a time.
use super::policy::{INVALID, Result, UNAVAILABLE};
use serde_json::Value;
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};
pub trait Store: Send + 'static {
    fn load(&mut self) -> Result<Option<Value>>;
    /// Err must preserve prior bytes, or return notification_store_unknown. Never silently reset.
    fn commit(&mut self, next: &Value) -> Result<()>;
}
pub struct FileStore {
    file: PathBuf,
    strict: bool,
    _lock: std::fs::File,
}
impl FileStore {
    /// `directory` must be an existing app-private local directory with owner-only access
    /// (Windows protected user DACL), no junctions/symlinks. The runner owns that grant.
    pub fn in_private_directory(directory: &Path) -> Result<Self> {
        Self::named(directory, "desktop-notification-receipts")
    }
    /// Native fixed filename only. Callers retain the same private-directory grant.
    pub(crate) fn named(directory: &Path, name: &str) -> Result<Self> {
        if !["desktop-notification-receipts", "terminal-catalog"].contains(&name) {
            return Err(INVALID.into());
        }
        let metadata = std::fs::symlink_metadata(directory).map_err(|_| UNAVAILABLE)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(INVALID.into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(INVALID.into());
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(INVALID.into());
            }
        }
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(0x100);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0).custom_flags(0x00200000);
        }
        let lock = options
            .open(directory.join(format!("{name}.lock")))
            .map_err(|_| UNAVAILABLE)?;
        let lock_metadata = lock.metadata().map_err(|_| UNAVAILABLE)?;
        if !lock_metadata.is_file() {
            return Err(INVALID.into());
        }
        if name == "terminal-catalog" {
            Self::private_file(&lock)?;
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if lock_metadata.file_attributes() & 0x400 != 0 {
                return Err(INVALID.into());
            }
        }
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            unsafe extern "C" {
                fn flock(fd: i32, operation: i32) -> i32;
            }
            if unsafe { flock(lock.as_raw_fd(), 2 | 4) } != 0 {
                return Err(UNAVAILABLE.into());
            }
        }
        Ok(Self {
            file: directory.join(format!("{name}.json")),
            strict: name == "terminal-catalog",
            _lock: lock,
        })
    }
    fn private_file(file: &std::fs::File) -> Result<()> {
        let metadata = file.metadata().map_err(|_| UNAVAILABLE)?;
        if !metadata.is_file() {
            return Err(INVALID.into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            unsafe extern "C" {
                fn geteuid() -> u32;
            }
            if metadata.uid() != unsafe { geteuid() }
                || metadata.mode() & 0o7777 != 0o600
                || metadata.nlink() != 1
            {
                return Err(INVALID.into());
            }
        }
        Ok(())
    }
    fn bytes(&self) -> Result<Option<Vec<u8>>> {
        let metadata = match std::fs::symlink_metadata(&self.file) {
            Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(UNAVAILABLE.into()),
        };
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > 8 * 1024 * 1024
        {
            return Err(INVALID.into());
        }
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(0x100);
        } // Darwin O_NOFOLLOW.
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x00200000);
        }
        let mut bytes = Vec::new();
        let file = options.open(&self.file).map_err(|_| UNAVAILABLE)?;
        if self.strict {
            Self::private_file(&file)?;
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if file.metadata().map_err(|_| UNAVAILABLE)?.file_attributes() & 0x400 != 0 {
                return Err(INVALID.into());
            }
        }
        file.take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| UNAVAILABLE)?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err(INVALID.into());
        }
        Ok(Some(bytes))
    }
}
impl Store for FileStore {
    fn load(&mut self) -> Result<Option<Value>> {
        self.bytes()?
            .map(|b| serde_json::from_slice(&b).map_err(|_| INVALID.into()))
            .transpose()
    }
    fn commit(&mut self, next: &Value) -> Result<()> {
        let bytes = serde_json::to_vec(next).map_err(|_| INVALID)?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err(INVALID.into());
        }
        let prior = self.bytes()?;
        let temporary = self
            .file
            .with_extension(format!("{}.tmp", crate::vault::id()?));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let stage = (|| -> Result<()> {
            let mut file = options.open(&temporary).map_err(|_| UNAVAILABLE)?;
            file.write_all(&bytes).map_err(|_| UNAVAILABLE)?;
            file.sync_all().map_err(|_| UNAVAILABLE)?;
            Ok(())
        })();
        if stage.is_err() {
            let _ = std::fs::remove_file(&temporary);
            return stage;
        }
        #[cfg(not(windows))]
        let renamed = std::fs::rename(&temporary, &self.file).is_ok();
        #[cfg(windows)]
        let renamed = {
            use std::os::windows::ffi::OsStrExt;
            #[link(name = "kernel32")]
            unsafe extern "system" {
                fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
            }
            let from: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
            let to: Vec<u16> = self.file.as_os_str().encode_wide().chain(Some(0)).collect();
            unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 1 | 8) != 0 }
        };
        // An error after replacement is not evidence the prior file is still authoritative.
        let actual = self.bytes();
        if actual.as_ref().ok().and_then(|v| v.as_ref()) == Some(&bytes) {
            #[cfg(unix)]
            if std::fs::File::open(self.file.parent().ok_or(INVALID)?)
                .and_then(|f| f.sync_all())
                .is_err()
            {
                return Err("notification_store_unknown".into());
            }
            return Ok(());
        }
        if !renamed && actual.ok() == Some(prior) {
            let _ = std::fs::remove_file(&temporary);
            return Err(UNAVAILABLE.into());
        }
        Err("notification_store_unknown".into())
    }
}
#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn private_synthetic_file_roundtrip_and_corruption_fail_closed() {
        use std::os::unix::fs::DirBuilderExt;
        let path = std::env::temp_dir().join(format!(
            "nsh-notification-synthetic-{}",
            crate::vault::id().unwrap()
        ));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .unwrap();
        let mut store = FileStore::in_private_directory(&path).unwrap();
        assert!(FileStore::in_private_directory(&path).is_err());
        assert!(store.load().unwrap().is_none());
        let value = json!({"v":1,"rows":[],"retirements":[]});
        store.commit(&value).unwrap();
        assert_eq!(store.load().unwrap(), Some(value));
        std::fs::write(&store.file, b"{incomplete").unwrap();
        assert!(store.load().is_err());
        std::fs::remove_file(&store.file).unwrap();
        drop(store);
        std::fs::remove_file(path.join("desktop-notification-receipts.lock")).unwrap();
        std::fs::remove_dir(&path).unwrap();
    }
}
