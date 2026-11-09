//! Shared Stage durability/private creation only; not another write/rename path.
use super::Result;
use std::fs::File;

pub(super) fn sync_stage(file: &File) -> Result<()> {
    file.sync_all().map_err(|_| "documents_flush_failed")?;
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        unsafe extern "C" {
            fn fcntl(fd: i32, command: i32, ...) -> i32;
        }
        if unsafe { fcntl(file.as_raw_fd(), 51) } != 0 {
            return Err("documents_flush_failed".into());
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub(super) fn private_stage(path: &std::path::Path) -> Result<File> {
    use std::{
        ffi::c_void,
        os::windows::{ffi::OsStrExt, io::FromRawHandle},
        ptr,
    };
    type Handle = *mut c_void;
    #[repr(C)]
    struct Attributes {
        size: u32,
        descriptor: *mut c_void,
        inherit: i32,
    }
    #[repr(C)]
    struct TokenUser {
        sid: *mut c_void,
        attributes: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> Handle;
        fn CloseHandle(handle: Handle) -> i32;
        fn LocalFree(value: *mut c_void) -> *mut c_void;
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *const Attributes,
            creation: u32,
            flags: u32,
            template: Handle,
        ) -> Handle;
    }
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> i32;
        fn GetTokenInformation(
            token: Handle,
            kind: u32,
            info: *mut c_void,
            size: u32,
            needed: *mut u32,
        ) -> i32;
        fn ConvertSidToStringSidW(sid: *const c_void, text: *mut *mut u16) -> i32;
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
            text: *const u16,
            revision: u32,
            descriptor: *mut *mut c_void,
            size: *mut u32,
        ) -> i32;
    }
    struct Token(Handle);
    impl Drop for Token {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    struct Local(*mut c_void);
    impl Drop for Local {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
    let mut token = ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), 8, &mut token) } == 0 {
        return Err("documents_stage_permissions".into());
    }
    let token = Token(token);
    let mut needed = 0;
    unsafe {
        GetTokenInformation(token.0, 1, ptr::null_mut(), 0, &mut needed);
    }
    if !(std::mem::size_of::<TokenUser>() as u32..=65536).contains(&needed) {
        return Err("documents_stage_permissions".into());
    }
    // usize storage gives TOKEN_USER's pointer its required alignment.
    let mut info = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
    if unsafe { GetTokenInformation(token.0, 1, info.as_mut_ptr().cast(), needed, &mut needed) }
        == 0
    {
        return Err("documents_stage_permissions".into());
    }
    let user = unsafe { &*info.as_ptr().cast::<TokenUser>() };
    let mut sid = ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(user.sid, &mut sid) } == 0 {
        return Err("documents_stage_permissions".into());
    }
    let sid_allocation = Local(sid.cast());
    let mut length = 0;
    while length < 256 && unsafe { *sid.add(length) } != 0 {
        length += 1;
    }
    if length == 256 {
        return Err("documents_stage_permissions".into());
    }
    let sid = String::from_utf16(unsafe { std::slice::from_raw_parts(sid, length) })
        .map_err(|_| "documents_stage_permissions")?;
    drop(sid_allocation);
    // Protected DACL, exactly the current user. Never inherit broader access
    // from a system-selected but publicly readable destination directory.
    let sddl: Vec<u16> = format!("O:{sid}D:P(A;;FA;;;{sid})")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut descriptor = ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err("documents_stage_permissions".into());
    }
    let descriptor = Local(descriptor);
    let attributes = Attributes {
        size: std::mem::size_of::<Attributes>() as u32,
        descriptor: descriptor.0,
        inherit: 0,
    };
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            0xc0000000,
            7,
            &attributes,
            1,
            0x00200000 | 0x80,
            ptr::null_mut(),
        )
    };
    if handle.is_null() || handle as isize == -1 {
        return Err("documents_stage_failed".into());
    }
    Ok(unsafe { File::from_raw_handle(handle) })
}
