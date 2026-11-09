//! Only an OS-selected path enters here. No JS path, current-dir/profile discovery or logging.
//! Stage fully + fsync before the final same-directory rename; a precommit failure preserves prior.
//! This is not filesystem CAS: another process can race a final name replacement. The rename
//! replaces the name, never follows its final symlink, and never resolves a new parent directory.
use super::Result;
#[cfg(target_os = "windows")]
use std::path::PathBuf;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};

pub(super) struct Grant {
    #[cfg(target_os = "macos")]
    dir: File,
    #[cfg(target_os = "windows")]
    parents: Vec<File>,
    #[cfg(target_os = "windows")]
    path: PathBuf,
    name: std::ffi::OsString,
    before: Option<Identity>,
}
#[derive(Clone, PartialEq, Eq)]
struct Identity {
    len: u64,
    modified: Option<std::time::SystemTime>,
    #[cfg(target_os = "macos")]
    dev: u64,
    #[cfg(target_os = "macos")]
    inode: u64,
    #[cfg(target_os = "windows")]
    file_id: (u32, u32, u32),
}
fn identity(file: &File) -> Result<Identity> {
    let metadata = file.metadata().map_err(|_| "documents_stat_failed")?;
    if !metadata.is_file() {
        return Err("documents_not_regular".into());
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err("documents_link_rejected".into());
        }
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("documents_link_rejected".into());
        }
    }
    #[cfg(target_os = "windows")]
    let file_id = {
        use super::windows_abi::FileInfo;
        use std::os::windows::io::AsRawHandle;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetFileInformationByHandle(file: *mut std::ffi::c_void, info: *mut FileInfo) -> i32;
        }
        let mut info: FileInfo = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err("documents_stat_failed".into());
        }
        if info.links != 1 {
            return Err("documents_link_rejected".into());
        }
        (info.volume, info.index_high, info.index_low)
    };
    Ok(Identity {
        len: metadata.len(),
        modified: metadata.modified().ok(),
        #[cfg(target_os = "macos")]
        dev: {
            use std::os::unix::fs::MetadataExt;
            metadata.dev()
        },
        #[cfg(target_os = "macos")]
        inode: {
            use std::os::unix::fs::MetadataExt;
            metadata.ino()
        },
        #[cfg(target_os = "windows")]
        file_id,
    })
}
pub(super) struct Stage {
    file: File,
    #[cfg(target_os = "macos")]
    dir: File,
    name: std::ffi::OsString,
    #[cfg(target_os = "windows")]
    path: PathBuf,
    committed: bool,
    written: u64,
    sealed: Option<Identity>,
    attempted: bool,
}
#[path = "documents_files_io.rs"]
mod io;
#[cfg(target_os = "macos")]
mod unix {
    use super::*;
    use std::{
        ffi::{CString, c_char, c_int},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::ffi::OsStrExt,
        },
    };
    unsafe extern "C" {
        fn openat(fd: c_int, path: *const c_char, flags: c_int, ...) -> c_int;
        fn renameat(from_fd: c_int, from: *const c_char, to_fd: c_int, to: *const c_char) -> c_int;
        fn renameatx_np(
            from_fd: c_int,
            from: *const c_char,
            to_fd: c_int,
            to: *const c_char,
            flags: u32,
        ) -> c_int;
        fn unlinkat(fd: c_int, path: *const c_char, flags: c_int) -> c_int;
    }
    pub(super) fn c(name: &std::ffi::OsStr) -> Result<CString> {
        CString::new(name.as_bytes()).map_err(|_| "documents_invalid_path".into())
    }
    pub(super) fn open(dir: &File, name: &std::ffi::OsStr, flags: i32) -> std::io::Result<File> {
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
    pub(super) fn rename(
        dir: &File,
        from: &std::ffi::OsStr,
        to: &std::ffi::OsStr,
        replace: bool,
    ) -> Result<()> {
        let from = c(from)?;
        let to = c(to)?;
        let status = unsafe {
            if replace {
                renameat(dir.as_raw_fd(), from.as_ptr(), dir.as_raw_fd(), to.as_ptr())
            } else {
                renameatx_np(
                    dir.as_raw_fd(),
                    from.as_ptr(),
                    dir.as_raw_fd(),
                    to.as_ptr(),
                    0x4,
                )
            }
        };
        if status == 0 {
            Ok(())
        } else {
            Err("documents_write_unknown".into())
        }
    }
    pub(super) fn unlink(dir: &File, name: &std::ffi::OsStr) {
        if let Ok(name) = c(name) {
            unsafe {
                unlinkat(dir.as_raw_fd(), name.as_ptr(), 0);
            }
        }
    }
}
impl Grant {
    pub(super) fn selected(path: &Path) -> Result<Self> {
        if !path.is_absolute()
            || path.components().count() > 256
            || path.components().any(|c| {
                matches!(
                    c,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            })
        {
            return Err("documents_invalid_path".into());
        }
        let parent = path.parent().ok_or("documents_invalid_path")?;
        let name = path
            .file_name()
            .ok_or("documents_invalid_path")?
            .to_os_string();
        #[cfg(target_os = "macos")]
        let mut grant = {
            let mut dir = File::open("/").map_err(|_| "documents_parent_unavailable")?;
            for component in parent.components() {
                if let std::path::Component::Normal(name) = component {
                    dir = unix::open(&dir, name, 0x100000)
                        .map_err(|_| "documents_parent_link_or_unavailable")?;
                }
            }
            Self {
                dir,
                name,
                before: None,
            }
        };
        #[cfg(target_os = "windows")]
        let mut grant = {
            use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
            // Pin every ancestor without FILE_SHARE_DELETE: no parent rename/junction swap
            // while the selected grant exists. Do not accept UNC/device paths or ADS.
            let value = path.to_str().ok_or("documents_invalid_path")?;
            if value.starts_with("\\\\") || value.get(2..).is_none_or(|v| v.contains(':')) {
                return Err("documents_invalid_path".into());
            }
            let mut current = PathBuf::new();
            let mut parents = Vec::new();
            for component in parent.components() {
                current.push(component);
                if matches!(component, std::path::Component::Prefix(_)) {
                    continue;
                }
                let file = std::fs::OpenOptions::new()
                    .read(true)
                    .custom_flags(0x02000000 | 0x00200000)
                    .share_mode(3)
                    .open(&current)
                    .map_err(|_| "documents_parent_unavailable")?;
                let metadata = file
                    .metadata()
                    .map_err(|_| "documents_parent_unavailable")?;
                if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0 {
                    return Err("documents_parent_link_or_unavailable".into());
                }
                parents.push(file);
            }
            Self {
                parents,
                path: path.into(),
                name,
                before: None,
            }
        };
        grant.before = grant.observed()?;
        Ok(grant)
    }
    fn open(&self) -> std::io::Result<File> {
        #[cfg(target_os = "macos")]
        {
            unix::open(&self.dir, &self.name, 0)
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(0x00200000)
                .share_mode(3)
                .open(&self.path)
        }
    }
    fn observed(&self) -> Result<Option<Identity>> {
        match self.open() {
            Ok(file) => Ok(Some(identity(&file)?)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("documents_link_or_open_failed".into()),
        }
    }
    pub(super) fn begin(&self) -> Result<Stage> {
        let name = std::ffi::OsString::from(format!(".yuri-export-{}.tmp", crate::vault::id()?));
        #[cfg(target_os = "macos")]
        let stage = {
            let dir = self.dir.try_clone().map_err(|_| "documents_stage_failed")?;
            Stage {
                file: unix::open(&self.dir, &name, 0x2 | 0x200 | 0x800)
                    .map_err(|_| "documents_stage_failed")?,
                dir,
                name,
                committed: false,
                written: 0,
                sealed: None,
                attempted: false,
            }
        };
        #[cfg(target_os = "windows")]
        let stage = {
            let path = self
                .path
                .parent()
                .ok_or("documents_invalid_path")?
                .join(&name);
            let file = io::private_stage(&path)?;
            Stage {
                file,
                name,
                path,
                committed: false,
                written: 0,
                sealed: None,
                attempted: false,
            }
        };
        // Both slice and streaming consumers get the same exclusive Stage and
        // existing pinned Grant. No caller receives a temporary name or handle.
        identity(&stage.file)?;
        Ok(stage)
    }
    pub(super) fn stage(&self, bytes: &[u8], current: impl Fn() -> bool) -> Result<Stage> {
        let mut stage = self.begin()?;
        for chunk in bytes.chunks(65536) {
            if !current() {
                return Err("documents_cancelled".into());
            }
            stage.append(chunk)?;
        }
        stage.seal()?;
        Ok(stage)
    }
    pub(super) fn commit(&self, stage: &mut Stage) -> Result<()> {
        if stage.attempted || stage.sealed.is_none() {
            return Err("documents_stage_state".into());
        }
        if stage.sealed.as_ref() != Some(&identity(&stage.file)?) {
            return Err("documents_stage_changed".into());
        }
        #[cfg(target_os = "macos")]
        if unix::open(&self.dir, &stage.name, 0)
            .ok()
            .and_then(|file| identity(&file).ok())
            .as_ref()
            != stage.sealed.as_ref()
        {
            return Err("documents_stage_changed".into());
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::fs::OpenOptionsExt;
            if self.path.parent() != stage.path.parent()
                || std::fs::OpenOptions::new()
                    .read(true)
                    .custom_flags(0x00200000)
                    .open(&stage.path)
                    .ok()
                    .and_then(|file| identity(&file).ok())
                    .as_ref()
                    != stage.sealed.as_ref()
            {
                return Err("documents_stage_changed".into());
            }
        }
        if self.observed()? != self.before {
            return Err("documents_target_changed".into());
        }
        stage.attempted = true;
        #[cfg(target_os = "macos")]
        unix::rename(&self.dir, &stage.name, &self.name, self.before.is_some())?;
        #[cfg(target_os = "windows")]
        {
            // Win32 MoveFileExW(REPLACE_EXISTING|WRITE_THROUGH) only after system confirmation.
            use std::os::windows::ffi::OsStrExt;
            #[link(name = "kernel32")]
            unsafe extern "system" {
                fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
            }
            let from: Vec<u16> = stage
                .path
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect();
            let to: Vec<u16> = self.path.as_os_str().encode_wide().chain(Some(0)).collect();
            if unsafe {
                MoveFileExW(
                    from.as_ptr(),
                    to.as_ptr(),
                    0x8 | if self.before.is_some() { 1 } else { 0 },
                )
            } == 0
            {
                return Err("documents_write_unknown".into());
            }
        }
        stage.committed = true;
        #[cfg(target_os = "macos")]
        self.dir.sync_all().map_err(|_| "documents_write_unknown")?;
        Ok(())
    }
    /// Exact original staged file identity, not equal cached bytes at a new
    /// destination. A later successful file+directory barrier is a NEW durable
    /// acknowledgement, never a replay of an uncertain rename.
    #[allow(dead_code)] // Download-only port; documents/diagnostics include this module independently.
    pub(super) fn confirm_stage(
        &self,
        stage: &mut Stage,
        current: impl Fn() -> bool,
    ) -> Result<bool> {
        let Some(expected) = stage.sealed.as_ref() else {
            return Ok(false);
        };
        if !stage.attempted
            || !current()
            || identity(&stage.file).ok().as_ref() != Some(expected)
            || self.observed()?.as_ref() != Some(expected)
        {
            return Ok(false);
        }
        io::sync_stage(&stage.file)?;
        #[cfg(target_os = "macos")]
        self.dir.sync_all().map_err(|_| "documents_write_unknown")?;
        #[cfg(target_os = "windows")]
        self.parents
            .last()
            .ok_or("documents_write_unknown")?
            .sync_all()
            .map_err(|_| "documents_write_unknown")?;
        if !current()
            || identity(&stage.file).ok().as_ref() != Some(expected)
            || self.observed()?.as_ref() != Some(expected)
        {
            return Ok(false);
        }
        stage.committed = true;
        Ok(true)
    }
    #[allow(dead_code)] // Download-only port; slice exports retain their original verification API.
    pub(super) fn observes_stage(&self, stage: &Stage) -> Result<bool> {
        Ok(stage.attempted
            && stage.sealed.as_ref().is_some_and(|expected| {
                identity(&stage.file).ok().as_ref() == Some(expected)
                    && self.observed().ok().flatten().as_ref() == Some(expected)
            }))
    }
    pub(super) fn verify(&self, bytes: &[u8]) -> Result<bool> {
        let mut file = self.open().map_err(|_| "documents_verify_failed")?;
        let metadata = identity(&file)?;
        if metadata.len != bytes.len() as u64 {
            return Ok(false);
        }
        let mut buffer = [0u8; 65536];
        let mut offset = 0;
        loop {
            let count = file
                .read(&mut buffer)
                .map_err(|_| "documents_verify_failed")?;
            if count == 0 {
                return Ok(offset == bytes.len()
                    && identity(&file)? == metadata
                    && self.observed()?.as_ref() == Some(&metadata));
            }
            if count > bytes.len() - offset || buffer[..count] != bytes[offset..offset + count] {
                return Ok(false);
            }
            offset += count;
        }
    }
}
impl Stage {
    pub(super) fn append(&mut self, bytes: &[u8]) -> Result<()> {
        if self.attempted || self.sealed.is_some() || bytes.len() > 65536 {
            return Err("documents_stage_state".into());
        }
        let metadata = identity(&self.file)?;
        if metadata.len != self.written {
            return Err("documents_stage_changed".into());
        }
        self.file
            .write_all(bytes)
            .map_err(|_| "documents_write_failed")?;
        self.written = self
            .written
            .checked_add(bytes.len() as u64)
            .ok_or("documents_stage_limit")?;
        Ok(())
    }
    /// Never expands a partial or rewinds a stage whose final rename was tried.
    #[allow(dead_code)] // Slice exports never resume; download uses this bounded Stage port.
    pub(super) fn rewind(&mut self, received: u64) -> Result<()> {
        if self.attempted || received > self.written || identity(&self.file)?.len < received {
            return Err("documents_stage_state".into());
        }
        self.sealed = None;
        self.file
            .set_len(received)
            .map_err(|_| "documents_write_failed")?;
        self.file
            .seek(SeekFrom::Start(received))
            .map_err(|_| "documents_write_failed")?;
        self.written = received;
        io::sync_stage(&self.file)
    }
    pub(super) fn seal(&mut self) -> Result<()> {
        if self.attempted || identity(&self.file)?.len != self.written {
            return Err("documents_stage_state".into());
        }
        io::sync_stage(&self.file)?;
        self.sealed = Some(identity(&self.file)?);
        Ok(())
    }
}
impl Drop for Stage {
    fn drop(&mut self) {
        if !self.committed {
            #[cfg(target_os = "macos")]
            if let Ok(current) = unix::open(&self.dir, &self.name, 0)
                && identity(&current)
                    .ok()
                    .is_some_and(|current| identity(&self.file).ok().as_ref() == Some(&current))
            {
                unix::unlink(&self.dir, &self.name);
            }
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::fs::OpenOptionsExt;
                if let Ok(current) = std::fs::OpenOptions::new()
                    .read(true)
                    .custom_flags(0x00200000)
                    .open(&self.path)
                    && identity(&current)
                        .ok()
                        .is_some_and(|current| identity(&self.file).ok().as_ref() == Some(&current))
                {
                    let _ = std::fs::remove_file(&self.path);
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "documents_files_tests.rs"]
mod tests;
