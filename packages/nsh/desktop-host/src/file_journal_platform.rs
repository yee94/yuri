//! Pinned private native directories and a lifetime OS-exclusive file owner.
//! No JS path is ever passed to these functions. Only fixed local descendants.
use super::super::Result;
use std::{fs::File, path::Path};

#[cfg(target_os = "macos")]
mod os {
    use super::*;
    use std::{
        ffi::{CString, c_char, c_int},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{ffi::OsStrExt, fs::MetadataExt},
        },
    };
    unsafe extern "C" {
        fn openat(fd: c_int, path: *const c_char, flags: c_int, ...) -> c_int;
        fn mkdirat(fd: c_int, path: *const c_char, mode: u32) -> c_int;
        fn flock(fd: c_int, operation: c_int) -> c_int;
        fn geteuid() -> u32;
        fn fcntl(fd: c_int, cmd: c_int, ...) -> c_int;
    }
    fn open(dir: &File, name: &std::ffi::OsStr, flags: i32) -> std::io::Result<File> {
        let name =
            CString::new(name.as_bytes()).map_err(|_| std::io::Error::from_raw_os_error(22))?;
        let fd = unsafe {
            openat(
                dir.as_raw_fd(),
                name.as_ptr(),
                flags | 0x100 | 0x1000000 | 0x4,
                0o600u32,
            )
        };
        if fd < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(unsafe { File::from_raw_fd(fd) })
        }
    }
    fn private(file: &File, directory: bool) -> Result<()> {
        let meta = file.metadata().map_err(|_| "file_journal_metadata")?;
        if meta.uid() != unsafe { geteuid() }
            || meta.mode() & 0o7777 != (if directory { 0o700 } else { 0o600 })
            || (if directory {
                !meta.is_dir()
            } else {
                !meta.is_file() || meta.nlink() != 1
            })
        {
            return Err("file_journal_permissions_or_link");
        }
        Ok(())
    }
    pub(crate) struct Directory {
        dir: File,
    }
    impl Directory {
        pub(crate) fn open(path: &Path, namespace: &str) -> Result<Self> {
            if !path.is_absolute()
                || path.components().count() > 256
                || path.components().any(|p| {
                    matches!(
                        p,
                        std::path::Component::ParentDir | std::path::Component::CurDir
                    )
                })
            {
                return Err("file_journal_data_dir");
            }
            let mut dir = File::open("/").map_err(|_| "file_journal_directory")?;
            let components: Vec<_> = path.components().collect();
            for (index, part) in components.iter().enumerate() {
                if let std::path::Component::Normal(name) = part {
                    let child = match open(&dir, name, 0x100000) {
                        Ok(child) => child,
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                            let c = CString::new(name.as_bytes())
                                .map_err(|_| "file_journal_data_dir")?;
                            if unsafe { mkdirat(dir.as_raw_fd(), c.as_ptr(), 0o700) } != 0
                                && std::io::Error::last_os_error().kind()
                                    != std::io::ErrorKind::AlreadyExists
                            {
                                return Err("file_journal_directory");
                            }
                            let child = open(&dir, name, 0x100000)
                                .map_err(|_| "file_journal_parent_link_or_unavailable")?;
                            private(&child, true)?;
                            dir.sync_all().map_err(|_| "file_journal_directory_sync")?;
                            child
                        }
                        Err(_) => return Err("file_journal_parent_link_or_unavailable"),
                    };
                    if index + 1 == components.len() {
                        dir.sync_all().map_err(|_| "file_journal_directory_sync")?;
                    }
                    dir = child;
                }
            }
            let metadata = dir.metadata().map_err(|_| "file_journal_directory")?;
            if metadata.uid() != unsafe { geteuid() } || metadata.mode() & 0o022 != 0 {
                return Err("file_journal_permissions_or_link");
            }
            for name in ["file-journal-v1", namespace] {
                let c = CString::new(name).map_err(|_| "file_journal_namespace")?;
                if unsafe { mkdirat(dir.as_raw_fd(), c.as_ptr(), 0o700) } != 0
                    && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
                {
                    return Err("file_journal_directory");
                }
                let child = open(&dir, std::ffi::OsStr::new(name), 0x100000)
                    .map_err(|_| "file_journal_parent_link_or_unavailable")?;
                private(&child, true)?;
                dir.sync_all().map_err(|_| "file_journal_directory_sync")?;
                dir = child;
            }
            Ok(Self { dir })
        }
        pub(crate) fn file(&self) -> Result<(File, bool)> {
            let name = std::ffi::OsStr::new("snapshots.bin");
            let (file, fresh) = match open(&self.dir, name, 0x2 | 0x200 | 0x800) {
                Ok(file) => (file, true),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (
                    open(&self.dir, name, 0x2).map_err(|_| "file_journal_open")?,
                    false,
                ),
                Err(_) => return Err("file_journal_open"),
            };
            private(&file, false)?;
            if unsafe { flock(file.as_raw_fd(), 2 | 4) } != 0 {
                return Err("file_journal_owner_conflict");
            }
            Ok((file, fresh))
        }
        pub(crate) fn sync(&self) -> Result<()> {
            self.dir
                .sync_all()
                .map_err(|_| "file_journal_directory_sync")
        }
    }
    pub(crate) fn regular(file: &File) -> Result<()> {
        private(file, false)
    }
    pub(crate) fn flush(file: &File) -> Result<()> {
        file.sync_all().map_err(|_| "file_journal_file_sync")?;
        if unsafe { fcntl(file.as_raw_fd(), 51) } != 0 {
            return Err("file_journal_file_sync");
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
#[path = "file_journal_windows.rs"]
mod os;
pub(super) use os::{Directory, flush, regular};
