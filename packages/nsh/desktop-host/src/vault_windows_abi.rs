//! Win32 credential/security layouts, separately checkable without loading a Windows system DLL.
use std::ffi::c_void;
#[repr(C)]
pub(super) struct FileTime {
    pub low: u32,
    pub high: u32,
}
#[repr(C)]
pub(super) struct Credential {
    pub flags: u32,
    pub kind: u32,
    pub target: *mut u16,
    pub comment: *mut u16,
    pub modified: FileTime,
    pub blob_size: u32,
    pub blob: *mut u8,
    pub persist: u32,
    pub attr_count: u32,
    pub attrs: *mut c_void,
    pub alias: *mut u16,
    pub username: *mut u16,
}
#[repr(C)]
pub(super) struct SecurityAttributes {
    pub length: u32,
    pub descriptor: *mut c_void,
    pub inherit: i32,
}
#[repr(C)]
pub(super) struct TokenUser {
    pub sid: *mut c_void,
    pub attributes: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem::{offset_of, size_of};
    #[test]
    fn win32_secure_store_ffi_layouts_match_pointer_width_and_documented_offsets() {
        assert_eq!(size_of::<FileTime>(), 8);
        if size_of::<usize>() == 8 {
            assert_eq!(size_of::<Credential>(), 80);
            assert_eq!(offset_of!(Credential, modified), 24);
            assert_eq!(offset_of!(Credential, blob_size), 32);
            assert_eq!(offset_of!(Credential, blob), 40);
            assert_eq!(offset_of!(Credential, username), 72);
            assert_eq!(size_of::<SecurityAttributes>(), 24);
            assert_eq!(offset_of!(SecurityAttributes, descriptor), 8);
            assert_eq!(size_of::<TokenUser>(), 16);
            assert_eq!(offset_of!(TokenUser, attributes), 8);
        } else {
            assert_eq!(size_of::<Credential>(), 52);
            assert_eq!(offset_of!(Credential, blob), 28);
            assert_eq!(size_of::<SecurityAttributes>(), 12);
            assert_eq!(size_of::<TokenUser>(), 8);
        }
    }
}
