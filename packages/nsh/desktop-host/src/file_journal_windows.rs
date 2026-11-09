//! Windows deliberately uses NO rename / ReplaceFileW. One fixed file is opened
//! FILE_FLAG_WRITE_THROUGH with exclusive sharing, then FlushFileBuffers after
//! every phase. The documented write-through contract flushes file metadata too:
//! https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-createfilew
//! No directory entries change during later commits. Pinned parent handles deny
//! FILE_SHARE_DELETE; protected DACL permits only the current user. Not a claim of
//! Windows runtime acceptance from a non-Windows build.
use super::{File, Path, Result};
use std::{
    ffi::c_void,
    os::windows::{
        ffi::OsStrExt,
        fs::MetadataExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::PathBuf,
};
type Handle = *mut c_void;
#[repr(C)]
struct SecurityAttributes {
    size: u32,
    descriptor: Handle,
    inherit: i32,
}
#[repr(C)]
struct FileInfo {
    attrs: u32,
    created: [u32; 2],
    accessed: [u32; 2],
    written: [u32; 2],
    volume: u32,
    high: u32,
    low: u32,
    links: u32,
    index_high: u32,
    index_low: u32,
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcess() -> Handle;
    fn CloseHandle(h: Handle) -> i32;
    fn LocalFree(p: Handle) -> Handle;
    fn GetLastError() -> u32;
    fn CreateDirectoryW(path: *const u16, security: *const SecurityAttributes) -> i32;
    fn CreateFileW(
        path: *const u16,
        access: u32,
        share: u32,
        security: *const SecurityAttributes,
        creation: u32,
        flags: u32,
        template: Handle,
    ) -> Handle;
    fn GetFileInformationByHandle(file: Handle, info: *mut FileInfo) -> i32;
    fn GetVolumeInformationByHandleW(
        file: Handle,
        name: *mut u16,
        name_size: u32,
        serial: *mut u32,
        component: *mut u32,
        flags: *mut u32,
        filesystem: *mut u16,
        filesystem_size: u32,
    ) -> i32;
}
#[link(name = "advapi32")]
unsafe extern "system" {
    fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> i32;
    fn GetTokenInformation(
        token: Handle,
        class: u32,
        buffer: Handle,
        len: u32,
        needed: *mut u32,
    ) -> i32;
    fn ConvertSidToStringSidW(sid: Handle, value: *mut *mut u16) -> i32;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        value: *const u16,
        revision: u32,
        descriptor: *mut Handle,
        size: *mut u32,
    ) -> i32;
    fn GetSecurityInfo(
        handle: Handle,
        kind: u32,
        fields: u32,
        owner: *mut Handle,
        group: *mut Handle,
        dacl: *mut Handle,
        sacl: *mut Handle,
        descriptor: *mut Handle,
    ) -> u32;
    fn GetSecurityDescriptorControl(
        descriptor: Handle,
        control: *mut u16,
        revision: *mut u32,
    ) -> i32;
    fn EqualSid(a: Handle, b: Handle) -> i32;
    fn GetAce(acl: Handle, index: u32, ace: *mut Handle) -> i32;
}
struct Local(Handle);
impl Drop for Local {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}
struct Security {
    _user: Vec<u8>,
    sid: Handle,
    descriptor: Local,
}
impl Security {
    fn new() -> Result<Self> {
        let mut token = std::ptr::null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), 8, &mut token) } == 0 {
            return Err("file_journal_security");
        }
        let mut needed = 0;
        unsafe {
            GetTokenInformation(token, 1, std::ptr::null_mut(), 0, &mut needed);
        }
        if needed == 0 || needed > 65536 {
            unsafe {
                CloseHandle(token);
            }
            return Err("file_journal_security");
        }
        let mut user = vec![0u8; needed as usize];
        let ok =
            unsafe { GetTokenInformation(token, 1, user.as_mut_ptr().cast(), needed, &mut needed) };
        unsafe {
            CloseHandle(token);
        }
        if ok == 0 || user.len() < std::mem::size_of::<Handle>() {
            return Err("file_journal_security");
        }
        let sid = unsafe { std::ptr::read_unaligned(user.as_ptr().cast::<Handle>()) };
        let mut value = std::ptr::null_mut();
        if unsafe { ConvertSidToStringSidW(sid, &mut value) } == 0 {
            return Err("file_journal_security");
        }
        let owned = Local(value.cast());
        let mut len = 0usize;
        while len < 256 && unsafe { *value.add(len) } != 0 {
            len += 1;
        }
        if len == 256 {
            return Err("file_journal_security");
        }
        let sid_text = String::from_utf16(unsafe { std::slice::from_raw_parts(value, len) })
            .map_err(|_| "file_journal_security")?;
        drop(owned);
        let sddl = wide(std::ffi::OsStr::new(&format!(
            "O:{sid_text}D:P(A;OICI;FA;;;{sid_text})"
        )));
        let mut descriptor = std::ptr::null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err("file_journal_security");
        }
        Ok(Self {
            _user: user,
            sid,
            descriptor: Local(descriptor),
        })
    }
    fn attributes(&self) -> SecurityAttributes {
        SecurityAttributes {
            size: std::mem::size_of::<SecurityAttributes>() as u32,
            descriptor: self.descriptor.0,
            inherit: 0,
        }
    }
    fn verify(&self, file: &File, protected: bool) -> Result<()> {
        let mut owner = std::ptr::null_mut();
        let mut dacl = std::ptr::null_mut();
        let mut descriptor = std::ptr::null_mut();
        let status = unsafe {
            GetSecurityInfo(
                file.as_raw_handle(),
                1,
                1 | 4,
                &mut owner,
                std::ptr::null_mut(),
                &mut dacl,
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        if status != 0 {
            return Err("file_journal_security");
        }
        let _descriptor = Local(descriptor);
        if owner.is_null() || unsafe { EqualSid(owner, self.sid) } == 0 {
            return Err("file_journal_security");
        }
        if !protected {
            return Ok(());
        }
        let mut control = 0u16;
        let mut revision = 0u32;
        if dacl.is_null()
            || unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0
            || control & 0x1004 != 0x1004
        {
            return Err("file_journal_security");
        }
        // ACL header: revision:u8, reserved:u8, size:u16, count:u16, reserved:u16.
        let count = unsafe { std::ptr::read_unaligned(dacl.cast::<u8>().add(4).cast::<u16>()) };
        if count != 1 {
            return Err("file_journal_security");
        }
        let mut ace = std::ptr::null_mut();
        if unsafe { GetAce(dacl, 0, &mut ace) } == 0 || ace.is_null() {
            return Err("file_journal_security");
        }
        let bytes = ace.cast::<u8>();
        let mask = unsafe { std::ptr::read_unaligned(bytes.add(4).cast::<u32>()) };
        if unsafe { *bytes } != 0
            || mask & 0x1f01ff != 0x1f01ff
            || unsafe { EqualSid(bytes.add(8).cast_mut().cast(), self.sid) } == 0
        {
            return Err("file_journal_security");
        }
        Ok(())
    }
}
fn handle(
    path: &Path,
    access: u32,
    share: u32,
    security: Option<&Security>,
    create: u32,
    flags: u32,
) -> std::io::Result<File> {
    let name = wide(path.as_os_str());
    let attrs = security.map(Security::attributes);
    let raw = unsafe {
        CreateFileW(
            name.as_ptr(),
            access,
            share,
            attrs.as_ref().map_or(std::ptr::null(), |a| a),
            create,
            flags,
            std::ptr::null_mut(),
        )
    };
    if raw as isize == -1 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_handle(raw) })
    }
}
pub(crate) struct Directory {
    parents: Vec<File>,
    path: PathBuf,
}
impl Directory {
    pub(crate) fn open(data: &Path, namespace: &str) -> Result<Self> {
        let value = data.to_str().ok_or("file_journal_data_dir")?;
        if !data.is_absolute()
            || value.starts_with("\\\\")
            || value.get(2..).is_none_or(|v| v.contains(':'))
            || data.components().count() > 256
            || data.components().any(|c| {
                matches!(
                    c,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            })
        {
            return Err("file_journal_data_dir");
        }
        let security = Security::new()?;
        let mut parents = Vec::new();
        let mut path = PathBuf::new();
        for c in data.components() {
            path.push(c);
            if matches!(c, std::path::Component::Prefix(_)) {
                continue;
            }
            let file = match handle(&path, 0x80020000, 3, None, 3, 0x02000000 | 0x00200000) {
                Ok(file) => file,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    let name = wide(path.as_os_str());
                    let attrs = security.attributes();
                    if unsafe { CreateDirectoryW(name.as_ptr(), &attrs) } == 0
                        && unsafe { GetLastError() } != 183
                    {
                        return Err("file_journal_directory");
                    }
                    let file = handle(&path, 0x80020000, 3, None, 3, 0x02000000 | 0x00200000)
                        .map_err(|_| "file_journal_parent_link_or_unavailable")?;
                    security.verify(&file, true)?;
                    file
                }
                Err(_) => return Err("file_journal_parent_link_or_unavailable"),
            };
            let meta = file.metadata().map_err(|_| "file_journal_metadata")?;
            if !meta.is_dir() || meta.file_attributes() & 0x400 != 0 {
                return Err("file_journal_parent_link_or_unavailable");
            }
            parents.push(file);
        }
        security.verify(parents.last().ok_or("file_journal_data_dir")?, false)?;
        for name in ["file-journal-v1", namespace] {
            path.push(name);
            let w = wide(path.as_os_str());
            let attrs = security.attributes();
            if unsafe { CreateDirectoryW(w.as_ptr(), &attrs) } == 0
                && unsafe { GetLastError() } != 183
            {
                return Err("file_journal_directory");
            }
            let file = handle(&path, 0x80020000, 3, None, 3, 0x02000000 | 0x00200000)
                .map_err(|_| "file_journal_directory")?;
            let meta = file.metadata().map_err(|_| "file_journal_metadata")?;
            if !meta.is_dir() || meta.file_attributes() & 0x400 != 0 {
                return Err("file_journal_parent_link_or_unavailable");
            }
            security.verify(&file, true)?;
            parents.push(file);
        }
        Ok(Self { parents, path })
    }
    pub(crate) fn file(&self) -> Result<(File, bool)> {
        let security = Security::new()?;
        let path = self.path.join("snapshots.bin");
        let flags = 0x80000000 | 0x00200000; // WRITE_THROUGH | OPEN_REPARSE_POINT
        let (file, fresh) = match handle(&path, 0xc0020000, 0, Some(&security), 1, flags) {
            Ok(file) => (file, true),
            Err(e) if [Some(80), Some(183)].contains(&e.raw_os_error()) => (
                handle(&path, 0xc0020000, 0, None, 3, flags)
                    .map_err(|_| "file_journal_owner_conflict_or_open")?,
                false,
            ),
            Err(_) => return Err("file_journal_owner_conflict_or_open"),
        };
        regular(&file)?;
        security.verify(&file, true)?;
        let mut filesystem = [0u16; 32];
        let mut flags = 0u32;
        if unsafe {
            GetVolumeInformationByHandleW(
                file.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut flags,
                filesystem.as_mut_ptr(),
                filesystem.len() as u32,
            )
        } == 0
            || flags & 8 == 0
        {
            return Err("file_journal_filesystem");
        }
        let len = filesystem
            .iter()
            .position(|v| *v == 0)
            .ok_or("file_journal_filesystem")?;
        if String::from_utf16(&filesystem[..len]).map_err(|_| "file_journal_filesystem")? != "NTFS"
        {
            return Err("file_journal_filesystem");
        }
        Ok((file, fresh))
    }
    pub(crate) fn sync(&self) -> Result<()> {
        // FlushFileBuffers on the WRITE_THROUGH fixed file is the Windows data +
        // metadata barrier (not a fake successful fsync of a directory handle).
        // All ancestor names stay pinned; no namespace mutation occurs here.
        for file in &self.parents {
            let m = file.metadata().map_err(|_| "file_journal_metadata")?;
            if !m.is_dir() || m.file_attributes() & 0x400 != 0 {
                return Err("file_journal_parent_link_or_unavailable");
            }
        }
        Ok(())
    }
}
pub(crate) fn regular(file: &File) -> Result<()> {
    let mut info: FileInfo = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0
        || info.links != 1
        || info.attrs & (0x400 | 0x10) != 0
    {
        return Err("file_journal_permissions_or_link");
    }
    Security::new()?.verify(file, true)
}
pub(crate) fn flush(file: &File) -> Result<()> {
    file.sync_all().map_err(|_| "file_journal_file_sync")
}
