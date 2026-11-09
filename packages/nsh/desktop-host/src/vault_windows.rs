//! Windows secure records only: Credential Manager + CNG SHA-256 + SID-scoped native mutex.
use super::{
    Result,
    abi::{Credential, FileTime, SecurityAttributes, TokenUser},
    records::{self, Baseline, LIMIT, MANIFEST, RECORD_LIMIT, Records},
};
use std::{ffi::c_void, ptr, sync::Mutex};
const PREFIX: &str = "com.yee94.yuri.nsh.desktop/";
#[link(name = "Advapi32")]
unsafe extern "system" {
    fn CredReadW(target: *const u16, kind: u32, flags: u32, value: *mut *mut Credential) -> i32;
    fn CredWriteW(value: *const Credential, flags: u32) -> i32;
    fn CredDeleteW(target: *const u16, kind: u32, flags: u32) -> i32;
    fn CredEnumerateW(
        filter: *const u16,
        flags: u32,
        count: *mut u32,
        values: *mut *mut *mut Credential,
    ) -> i32;
    fn CredFree(value: *mut c_void);
    fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
    fn GetTokenInformation(
        token: *mut c_void,
        class: u32,
        buffer: *mut c_void,
        length: u32,
        needed: *mut u32,
    ) -> i32;
    fn ConvertSidToStringSidW(sid: *const c_void, text: *mut *mut u16) -> i32;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        text: *const u16,
        revision: u32,
        descriptor: *mut *mut c_void,
        length: *mut u32,
    ) -> i32;
}
#[link(name = "Kernel32")]
unsafe extern "system" {
    fn GetLastError() -> u32;
    fn GetCurrentProcess() -> *mut c_void;
    fn CloseHandle(handle: *mut c_void) -> i32;
    fn LocalFree(value: *mut c_void) -> *mut c_void;
    fn CreateMutexW(
        attributes: *const SecurityAttributes,
        owner: i32,
        name: *const u16,
    ) -> *mut c_void;
    fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
    fn ReleaseMutex(handle: *mut c_void) -> i32;
}
#[link(name = "Bcrypt")]
unsafe extern "system" {
    fn BCryptGenRandom(algorithm: *mut c_void, bytes: *mut u8, length: u32, flags: u32) -> i32;
    fn BCryptOpenAlgorithmProvider(
        algorithm: *mut *mut c_void,
        name: *const u16,
        implementation: *const u16,
        flags: u32,
    ) -> i32;
    fn BCryptHash(
        algorithm: *mut c_void,
        secret: *const u8,
        secret_len: u32,
        input: *const u8,
        input_len: u32,
        output: *mut u8,
        output_len: u32,
    ) -> i32;
    fn BCryptCloseAlgorithmProvider(algorithm: *mut c_void, flags: u32) -> i32;
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
unsafe fn text(pointer: *const u16) -> Result<String> {
    if pointer.is_null() {
        return Err("secure_store_invalid".into());
    }
    // All pointers come from OS-owned null-terminated strings. Bound the consumed name, not a
    // caller-controlled address; the OS allocation remains alive through the conversion.
    for length in 0..512 {
        if unsafe { *pointer.add(length) } == 0 {
            return String::from_utf16(unsafe { std::slice::from_raw_parts(pointer, length) })
                .map_err(|_| "secure_store_invalid".into());
        }
    }
    Err("secure_store_invalid".into())
}
pub fn random(bytes: &mut [u8]) -> Result<()> {
    if bytes.len() > u32::MAX as usize
        || unsafe { BCryptGenRandom(ptr::null_mut(), bytes.as_mut_ptr(), bytes.len() as u32, 2) }
            != 0
    {
        return Err("secure_random_failed".into());
    }
    Ok(())
}
struct NativeMutex(*mut c_void);
impl Drop for NativeMutex {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.0);
            CloseHandle(self.0);
        }
    }
}
fn user_sid() -> Result<String> {
    let mut token = ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), 8, &mut token) } == 0 {
        return Err("secure_store_identity_failed".into());
    }
    let result = (|| {
        let mut needed = 0;
        unsafe {
            GetTokenInformation(token, 1, ptr::null_mut(), 0, &mut needed);
        }
        if needed < std::mem::size_of::<TokenUser>() as u32 || needed > 65536 {
            return Err("secure_store_identity_failed".into());
        }
        // usize storage preserves TOKEN_USER's pointer alignment, unlike a Vec<u8> cast.
        let mut buffer = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
        if unsafe { GetTokenInformation(token, 1, buffer.as_mut_ptr().cast(), needed, &mut needed) }
            == 0
        {
            return Err("secure_store_identity_failed".into());
        }
        let user = unsafe { &*buffer.as_ptr().cast::<TokenUser>() };
        let mut sid = ptr::null_mut();
        if unsafe { ConvertSidToStringSidW(user.sid, &mut sid) } == 0 {
            return Err("secure_store_identity_failed".into());
        }
        let value = unsafe { text(sid) };
        unsafe {
            LocalFree(sid.cast());
        }
        let value = value?;
        if !value.starts_with("S-")
            || !value
                .bytes()
                .all(|b| b.is_ascii_digit() || b == b'-' || b == b'S')
        {
            return Err("secure_store_identity_failed".into());
        }
        Ok(value)
    })();
    unsafe {
        CloseHandle(token);
    }
    result
}
fn lock() -> Result<NativeMutex> {
    let sid = user_sid()?;
    let name = wide(&format!("Global\\YuriNSH.Vault.{sid}"));
    let sddl = wide(&format!("D:P(A;;GA;;;SY)(A;;GA;;;{sid})"));
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
        return Err("secure_store_lock_failed".into());
    }
    if descriptor.is_null() {
        return Err("secure_store_lock_failed".into());
    }
    let attributes = SecurityAttributes {
        length: std::mem::size_of::<SecurityAttributes>() as u32,
        descriptor,
        inherit: 0,
    };
    let handle = unsafe { CreateMutexW(&attributes, 0, name.as_ptr()) };
    unsafe {
        LocalFree(descriptor);
    }
    if handle.is_null() {
        return Err("secure_store_lock_failed".into());
    }
    // Per-operation acquisition/release on this actor thread; no thread-owned guard is moved.
    match unsafe { WaitForSingleObject(handle, 5000) } {
        0 | 128 => Ok(NativeMutex(handle)), // abandoned owner: load/verify manifest before any mutation.
        _ => {
            unsafe {
                CloseHandle(handle);
            }
            Err("secure_store_busy".into())
        }
    }
}
struct Backend;
impl Records for Backend {
    fn read(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let target = wide(&format!("{PREFIX}{key}"));
        let mut credential = ptr::null_mut();
        if unsafe { CredReadW(target.as_ptr(), 1, 0, &mut credential) } == 0 {
            return if unsafe { GetLastError() } == 1168 {
                Ok(None)
            } else {
                Err("secure_store_read_failed".into())
            };
        }
        if credential.is_null() {
            return Err("secure_store_invalid".into());
        }
        let value = unsafe { &*credential };
        let result = if value.kind != 1
            || value.blob_size > RECORD_LIMIT as u32
            || value.blob_size > 0 && value.blob.is_null()
        {
            Err("secure_store_invalid".into())
        } else if value.blob_size == 0 {
            Ok(Some(Vec::new()))
        } else {
            Ok(Some(
                unsafe { std::slice::from_raw_parts(value.blob, value.blob_size as usize) }
                    .to_vec(),
            ))
        };
        unsafe {
            CredFree(credential.cast());
        }
        result
    }
    fn write(&self, key: &str, bytes: &[u8]) -> Result<()> {
        if bytes.len() > RECORD_LIMIT {
            return Err("secure_store_capacity".into());
        }
        let mut target = wide(&format!("{PREFIX}{key}"));
        let value = Credential {
            flags: 0,
            kind: 1,
            target: target.as_mut_ptr(),
            comment: ptr::null_mut(),
            modified: FileTime { low: 0, high: 0 },
            blob_size: bytes.len() as u32,
            blob: bytes.as_ptr() as *mut u8,
            persist: 2,
            attr_count: 0,
            attrs: ptr::null_mut(),
            alias: ptr::null_mut(),
            username: ptr::null_mut(),
        };
        if unsafe { CredWriteW(&value, 0) } == 0 {
            return Err("secure_store_write_failed".into());
        }
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<()> {
        let target = wide(&format!("{PREFIX}{key}"));
        if unsafe { CredDeleteW(target.as_ptr(), 1, 0) } == 0 && unsafe { GetLastError() } != 1168 {
            return Err("secure_store_cleanup_failed".into());
        }
        Ok(())
    }
    fn digest(&self, bytes: &[u8]) -> Result<[u8; 32]> {
        if bytes.len() > LIMIT {
            return Err("secure_store_capacity".into());
        }
        let mut algorithm = ptr::null_mut();
        let name = wide("SHA256");
        if unsafe { BCryptOpenAlgorithmProvider(&mut algorithm, name.as_ptr(), ptr::null(), 0) }
            != 0
        {
            return Err("secure_store_digest_failed".into());
        }
        let mut output = [0; 32];
        let status = unsafe {
            BCryptHash(
                algorithm,
                ptr::null(),
                0,
                bytes.as_ptr(),
                bytes.len() as u32,
                output.as_mut_ptr(),
                32,
            )
        };
        unsafe {
            BCryptCloseAlgorithmProvider(algorithm, 0);
        }
        if status != 0 {
            return Err("secure_store_digest_failed".into());
        }
        Ok(output)
    }
    fn generation(&self) -> Result<String> {
        super::id()
    }
    fn prune(&self, keep: Option<&str>) -> Result<()> {
        let prefix = format!("{PREFIX}{MANIFEST}/chunk/");
        let filter = wide(&format!("{prefix}*"));
        let mut count = 0;
        let mut credentials = ptr::null_mut();
        if unsafe { CredEnumerateW(filter.as_ptr(), 0, &mut count, &mut credentials) } == 0 {
            return if unsafe { GetLastError() } == 1168 {
                Ok(())
            } else {
                Err("secure_store_cleanup_failed".into())
            };
        }
        let result = (|| {
            if count > 256 || count > 0 && credentials.is_null() {
                return Err("secure_store_namespace_capacity".into());
            }
            for index in 0..count as usize {
                let credential = unsafe { *credentials.add(index) };
                if credential.is_null() {
                    return Err("secure_store_invalid".into());
                }
                let target = unsafe { text((*credential).target) }?;
                let suffix = target.strip_prefix(&prefix).ok_or("secure_store_invalid")?;
                let (generation, part) = suffix.split_once('/').ok_or("secure_store_invalid")?;
                if !records::generation_valid(generation)
                    || part
                        .parse::<usize>()
                        .map_or(true, |part| part >= LIMIT.div_ceil(RECORD_LIMIT))
                {
                    return Err("secure_store_invalid".into());
                }
                if keep != Some(generation) {
                    self.delete(target.strip_prefix(PREFIX).ok_or("secure_store_invalid")?)?;
                }
            }
            Ok(())
        })();
        if !credentials.is_null() {
            unsafe {
                CredFree(credentials.cast());
            }
        }
        result
    }
}
#[derive(Default)]
struct State {
    expected: Option<Baseline>,
    quarantined: bool,
}
#[derive(Default)]
pub struct Store {
    state: Mutex<State>,
}
impl Store {
    pub fn read(&self) -> Result<Option<Vec<u8>>> {
        let mut state = self.state.lock().map_err(|_| "secure_store_lock_failed")?;
        if state.quarantined {
            return Err(records::UNKNOWN.into());
        }
        let _lock = lock()?;
        let (bytes, base) = records::load(&Backend)?;
        state.expected = Some(base);
        Ok(bytes)
    }
    pub fn write(&self, bytes: &[u8]) -> Result<()> {
        if bytes.len() > LIMIT {
            return Err("secure_store_capacity".into());
        }
        let mut state = self.state.lock().map_err(|_| "secure_store_lock_failed")?;
        if state.quarantined {
            return Err(records::UNKNOWN.into());
        }
        let expected = state
            .expected
            .as_ref()
            .ok_or("secure_store_read_required")?;
        let _lock = lock()?;
        match records::commit(&Backend, expected, bytes) {
            Ok(base) => {
                state.expected = Some(base);
                Ok(())
            }
            Err(error) => {
                if super::invalidates_authority(&error) {
                    state.quarantined = true;
                }
                Err(error)
            }
        }
    }
}
