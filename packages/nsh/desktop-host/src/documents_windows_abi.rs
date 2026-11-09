//! Actual OPENFILENAMEW layout used by the Windows save adapter, also checked on 64-bit Mac.
use std::ffi::c_void;
pub(super) const SAVE_FLAGS: u32 = 0x2 | 0x800 | 0x8 | 0x80000 | 0x8000 | 0x02000000;
#[repr(C)]
pub(super) struct OpenFileName {
    pub size: u32,
    pub owner: *mut c_void,
    pub instance: *mut c_void,
    pub filter: *const u16,
    pub custom_filter: *mut u16,
    pub max_custom_filter: u32,
    pub filter_index: u32,
    pub file: *mut u16,
    pub max_file: u32,
    pub file_title: *mut u16,
    pub max_file_title: u32,
    pub initial_directory: *const u16,
    pub title: *const u16,
    pub flags: u32,
    pub file_offset: u16,
    pub file_extension: u16,
    pub default_extension: *const u16,
    pub data: isize,
    pub hook: *mut c_void,
    pub template: *const u16,
    pub reserved: *mut c_void,
    pub reserved_size: u32,
    pub flags_ex: u32,
}
#[repr(C)]
pub(super) struct FileInfo {
    pub attributes: u32,
    pub created: [u32; 2],
    pub accessed: [u32; 2],
    pub written: [u32; 2],
    pub volume: u32,
    pub size_high: u32,
    pub size_low: u32,
    pub links: u32,
    pub index_high: u32,
    pub index_low: u32,
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn openfilenamew_64_bit_layout() {
        assert_eq!(std::mem::size_of::<OpenFileName>(), 152);
        assert_eq!(std::mem::offset_of!(OpenFileName, owner), 8);
        assert_eq!(std::mem::offset_of!(OpenFileName, file), 48);
        assert_eq!(std::mem::offset_of!(OpenFileName, flags), 96);
        assert_eq!(std::mem::offset_of!(OpenFileName, flags_ex), 148);
        assert_eq!(std::mem::size_of::<FileInfo>(), 52);
        assert_eq!(std::mem::offset_of!(FileInfo, links), 40);
        assert_eq!(std::mem::offset_of!(FileInfo, index_high), 44);
        assert_ne!(SAVE_FLAGS & 0x2, 0); // OFN_OVERWRITEPROMPT is required, never auto-confirmed.
    }
}
