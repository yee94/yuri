//! Native LocalAppData grant. Pins no-reparse ancestors without FILE_SHARE_DELETE;
//! creates protected current-user DACLs and verifies them from the opened handle.
//! No environment/JS paths, registry writes, permissions repair or plaintext fallback.
use crate::policy::Result;
use std::{ffi::c_void, path::PathBuf, ptr};
type Handle = *mut c_void;
#[repr(C)]
struct Guid(u32, u16, u16, [u8; 8]);
#[repr(C)]
struct Attributes {
    size: u32,
    descriptor: Handle,
    inherit: i32,
}
#[repr(C)]
struct FileInfo {
    attributes: u32,
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
#[cfg_attr(target_os = "windows", link(name = "shell32"))]
unsafe extern "system" {
    fn SHGetKnownFolderPath(id: *const Guid, flags: u32, token: Handle, path: *mut *mut u16)
    -> i32;
}
#[cfg_attr(target_os = "windows", link(name = "ole32"))]
unsafe extern "system" {
    fn CoTaskMemFree(value: Handle);
}
#[cfg_attr(target_os = "windows", link(name = "kernel32"))]
unsafe extern "system" {
    fn GetCurrentProcess() -> Handle;
    fn CloseHandle(handle: Handle) -> i32;
    fn LocalFree(value: Handle) -> Handle;
    fn GetLastError() -> u32;
    fn CreateDirectoryW(path: *const u16, attributes: *const Attributes) -> i32;
    fn CreateFileW(
        path: *const u16,
        access: u32,
        share: u32,
        security: *const Attributes,
        creation: u32,
        flags: u32,
        template: Handle,
    ) -> Handle;
    fn GetFileInformationByHandle(file: Handle, info: *mut FileInfo) -> i32;
    fn GetFileType(file: Handle) -> u32;
    fn GetDriveTypeW(root: *const u16) -> u32;
}
#[cfg_attr(target_os = "windows", link(name = "advapi32"))]
unsafe extern "system" {
    fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> i32;
    fn GetTokenInformation(
        token: Handle,
        class: u32,
        buffer: Handle,
        length: u32,
        needed: *mut u32,
    ) -> i32;
    fn ConvertSidToStringSidW(sid: Handle, text: *mut *mut u16) -> i32;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        text: *const u16,
        revision: u32,
        descriptor: *mut Handle,
        length: *mut u32,
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
    fn GetAce(acl: Handle, index: u32, ace: *mut Handle) -> i32;
    fn IsValidSid(sid: Handle) -> i32;
    fn GetLengthSid(sid: Handle) -> u32;
}
const ERROR: &str = "native_private_directory_unsafe";
fn allowed_ace(user: &str, sid: &str, mask: u32, flags: u8, private: bool) -> bool {
    if private {
        return sid == user && mask & 0x1f01ff == 0x1f01ff && flags & 3 == 3 && flags & 8 == 0;
    }
    sid == user
        || sid == "S-1-5-18"
        || sid == "S-1-5-32-544"
        || mask & (0x10000000 | 0x40000000 | 0x10000 | 0x40000 | 0x80000 | 0x40) == 0
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
unsafe fn text(value: *const u16, limit: usize) -> Result<String> {
    if value.is_null() {
        return Err(ERROR.into());
    }
    for n in 0..limit {
        if unsafe { *value.add(n) } == 0 {
            return String::from_utf16(unsafe { std::slice::from_raw_parts(value, n) })
                .map_err(|_| ERROR.into());
        }
    }
    Err(ERROR.into())
}
struct Local(Handle);
impl Drop for Local {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
struct Opened(Handle);
// Kernel file handles may move between threads. No thread-owned mutex/COM object is stored.
unsafe impl Send for Opened {}
impl Drop for Opened {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
fn sid_text(sid: Handle) -> Result<String> {
    if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
        return Err(ERROR.into());
    }
    let mut out = ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut out) } == 0 {
        return Err(ERROR.into());
    }
    let _owned = Local(out.cast());
    unsafe { text(out, 256) }
}
struct Security {
    _token: Vec<usize>,
    user: String,
    descriptor: Local,
}
impl Security {
    fn new() -> Result<Self> {
        let mut token = ptr::null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), 8, &mut token) } == 0 {
            return Err(ERROR.into());
        }
        let token = Opened(token);
        let mut needed = 0;
        unsafe {
            GetTokenInformation(token.0, 1, ptr::null_mut(), 0, &mut needed);
        }
        if !(16..=65536).contains(&needed) {
            return Err(ERROR.into());
        }
        let mut words = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
        if unsafe {
            GetTokenInformation(token.0, 1, words.as_mut_ptr().cast(), needed, &mut needed)
        } == 0
        {
            return Err(ERROR.into());
        }
        let sid = unsafe { *(words.as_ptr().cast::<Handle>()) };
        let user = sid_text(sid)?;
        let sddl = wide(&format!("O:{user}D:P(A;OICI;FA;;;{user})"));
        let mut descriptor = ptr::null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                ptr::null_mut(),
            )
        } == 0
            || descriptor.is_null()
        {
            return Err(ERROR.into());
        }
        Ok(Self {
            _token: words,
            user,
            descriptor: Local(descriptor),
        })
    }
    fn verify(&self, file: Handle, private: bool, root: bool) -> Result<()> {
        let (mut owner, mut acl, mut descriptor) =
            (ptr::null_mut(), ptr::null_mut(), ptr::null_mut());
        if unsafe {
            GetSecurityInfo(
                file,
                1,
                1 | 4,
                &mut owner,
                ptr::null_mut(),
                &mut acl,
                ptr::null_mut(),
                &mut descriptor,
            )
        } != 0
        {
            return Err(ERROR.into());
        }
        let _descriptor = Local(descriptor);
        let owner = sid_text(owner)?;
        let trusted = |sid: &str| sid == self.user || sid == "S-1-5-18" || sid == "S-1-5-32-544";
        if acl.is_null()
            || (private && owner != self.user)
            || (!private && !root && !trusted(&owner))
        {
            return Err(ERROR.into());
        }
        let (mut control, mut revision) = (0u16, 0u32);
        if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0
            || control & 4 == 0
            || (private && control & 0x1000 == 0)
        {
            return Err(ERROR.into());
        }
        let count = unsafe { ptr::read_unaligned(acl.cast::<u8>().add(4).cast::<u16>()) };
        if count > 256 || (private && count != 1) {
            return Err(ERROR.into());
        }
        for i in 0..count {
            let mut ace = ptr::null_mut();
            if unsafe { GetAce(acl, u32::from(i), &mut ace) } == 0 || ace.is_null() {
                return Err(ERROR.into());
            }
            let bytes = ace.cast::<u8>();
            let kind = unsafe { *bytes };
            let flags = unsafe { *bytes.add(1) };
            let size = unsafe { ptr::read_unaligned(bytes.add(2).cast::<u16>()) } as usize;
            if size < 16 || ![0, 1].contains(&kind) {
                return Err(ERROR.into());
            }
            if kind == 1 || flags & 8 != 0 {
                if private {
                    return Err(ERROR.into());
                }
                continue;
            }
            let sid = unsafe { bytes.add(8).cast() };
            let name = sid_text(sid)?;
            if unsafe { GetLengthSid(sid) } as usize + 8 > size {
                return Err(ERROR.into());
            }
            let mask = unsafe { ptr::read_unaligned(bytes.add(4).cast::<u32>()) };
            if !allowed_ace(&self.user, &name, mask, flags, private) {
                return Err(ERROR.into());
            }
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protected_acl_policy_never_accepts_inherited_or_untrusted_write_grants() {
        assert!(allowed_ace("user", "user", 0x1f01ff, 3, true));
        for (sid, mask, flags) in [
            ("other", 0x1f01ff, 3),
            ("user", 0x80000000, 3),
            ("user", 0x1f01ff, 0),
            ("user", 0x1f01ff, 11),
        ] {
            assert!(!allowed_ace("user", sid, mask, flags, true));
        }
        assert!(allowed_ace("user", "other", 0x120089, 0, false));
        for mask in [0x10000000, 0x40000000, 0x10000, 0x40000, 0x80000, 0x40] {
            assert!(!allowed_ace("user", "other", mask, 0, false));
        }
        assert_eq!(
            std::mem::size_of::<Attributes>(),
            if cfg!(target_pointer_width = "64") {
                24
            } else {
                12
            }
        );
        assert_eq!(std::mem::size_of::<FileInfo>(), 52);
    }
}
pub struct Grant {
    pub path: PathBuf,
    _parents: Vec<Opened>,
}
fn open(path: &str) -> Result<Opened> {
    let file = unsafe {
        CreateFileW(
            wide(path).as_ptr(),
            0x80020000,
            3,
            ptr::null(),
            3,
            0x02000000 | 0x00200000,
            ptr::null_mut(),
        )
    };
    if file as isize == -1 || file.is_null() {
        return Err(ERROR.into());
    }
    let file = Opened(file);
    let mut info: FileInfo = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.0, &mut info) } == 0
        || info.attributes & 0x410 != 0x10
        || unsafe { GetFileType(file.0) } != 1
    {
        return Err(ERROR.into());
    }
    Ok(file)
}
pub fn native(child: &str) -> Result<Grant> {
    if !crate::notification_store_grant::allowed_leaf(child) {
        return Err(ERROR.into());
    }
    let id = if child == "terminal-catalog-primary" {
        Guid(
            0x3eb685db,
            0x65f9,
            0x4cf6,
            [0xa0, 0x3a, 0xe3, 0xef, 0x65, 0x72, 0x9f, 0x3d],
        )
    } else {
        Guid(
            0xf1b32785,
            0x6fba,
            0x4fcf,
            [0x9d, 0x55, 0x7b, 0x8e, 0x7f, 0x15, 0x70, 0x91],
        )
    };
    let mut pointer = ptr::null_mut();
    if unsafe { SHGetKnownFolderPath(&id, 0, ptr::null_mut(), &mut pointer) } < 0 {
        return Err(ERROR.into());
    }
    let path = unsafe { text(pointer, 32768) };
    unsafe {
        CoTaskMemFree(pointer.cast());
    }
    let base = path?;
    let bytes = base.as_bytes();
    if bytes.len() < 3
        || !bytes[0].is_ascii_alphabetic()
        || &bytes[1..3] != b":\\"
        || base[2..].contains(':')
        || base.contains('/')
        || base.split('\\').any(|p| [".", "..", ""].contains(&p))
    {
        return Err(ERROR.into());
    }
    if unsafe { GetDriveTypeW(wide(&base[..3]).as_ptr()) } != 3 {
        return Err(ERROR.into());
    }
    let security = Security::new()?;
    let attrs = Attributes {
        size: std::mem::size_of::<Attributes>() as u32,
        descriptor: security.descriptor.0,
        inherit: 0,
    };
    let mut parents = Vec::new();
    let mut current = base[..3].to_owned();
    let root = open(&current)?;
    security.verify(root.0, false, true)?;
    parents.push(root);
    let mut components: Vec<_> = base[3..]
        .split('\\')
        .chain(["com.yee94.yuri.nsh"])
        .collect();
    let private_from = components.len() - 1;
    if child != "terminal-catalog-primary" {
        components.push(child);
    }
    for (index, name) in components.iter().enumerate() {
        if !current.ends_with('\\') {
            current.push('\\');
        }
        current.push_str(name);
        let private = index >= private_from;
        if private
            && unsafe { CreateDirectoryW(wide(&current).as_ptr(), &attrs) } == 0
            && unsafe { GetLastError() } != 183
        {
            return Err(ERROR.into());
        }
        let file = open(&current)?;
        security.verify(file.0, private, false)?;
        parents.push(file);
    }
    Ok(Grant {
        path: PathBuf::from(current),
        _parents: parents,
    })
}
