//! Application-specific native secure transactions; never NSH Storage or a plaintext fallback.
use crate::policy::Result;

pub trait Vault: Send {
    fn read(&self) -> Result<Option<Vec<u8>>>;
    fn write(&self, bytes: &[u8]) -> Result<()>;
}
pub const COMMIT_UNKNOWN: &str = "secure_store_commit_unknown";
pub const CONFLICT: &str = "secure_store_conflict";
pub fn invalidates_authority(error: &str) -> bool {
    error == COMMIT_UNKNOWN || error == CONFLICT
}
#[cfg(any(target_os = "windows", test))]
#[path = "vault_windows_abi.rs"]
mod abi;
#[cfg(any(target_os = "windows", test))]
#[path = "vault_records.rs"]
mod records;
#[derive(Default)]
pub struct NativeVault {
    #[cfg(target_os = "windows")]
    store: native::Store,
}
impl Vault for NativeVault {
    fn read(&self) -> Result<Option<Vec<u8>>> {
        #[cfg(target_os = "macos")]
        {
            native::read()
        }
        #[cfg(target_os = "windows")]
        {
            self.store.read()
        }
    }
    fn write(&self, bytes: &[u8]) -> Result<()> {
        #[cfg(target_os = "macos")]
        {
            native::write(bytes)
        }
        #[cfg(target_os = "windows")]
        {
            self.store.write(bytes)
        }
    }
}
pub fn id() -> Result<String> {
    let mut bytes = [0u8; 16];
    native::random(&mut bytes)?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let h: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    ))
}

#[cfg(target_os = "macos")]
mod native {
    use super::Result;
    use std::{ffi::c_void, ptr};
    const SERVICE: &[u8] = b"com.yee94.yuri.nsh.desktop.connections";
    const ACCOUNT: &[u8] = b"connections-v1";
    const NOT_FOUND: i32 = -25300;
    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecRandomCopyBytes(random: *const c_void, count: usize, bytes: *mut u8) -> i32;
        fn SecKeychainFindGenericPassword(
            keychains: *const c_void,
            service_len: u32,
            service: *const u8,
            account_len: u32,
            account: *const u8,
            length: *mut u32,
            password: *mut *mut c_void,
            item: *mut *mut c_void,
        ) -> i32;
        fn SecKeychainAddGenericPassword(
            keychain: *const c_void,
            service_len: u32,
            service: *const u8,
            account_len: u32,
            account: *const u8,
            length: u32,
            password: *const c_void,
            item: *mut *mut c_void,
        ) -> i32;
        fn SecKeychainItemModifyAttributesAndData(
            item: *mut c_void,
            attrs: *const c_void,
            length: u32,
            data: *const c_void,
        ) -> i32;
        fn SecKeychainItemFreeContent(attrs: *mut c_void, data: *mut c_void) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(value: *const c_void);
    }
    pub fn random(bytes: &mut [u8]) -> Result<()> {
        // kSecRandomDefault is NULL; the system RNG supplies both ids and process-local leases.
        if unsafe { SecRandomCopyBytes(ptr::null(), bytes.len(), bytes.as_mut_ptr()) } != 0 {
            return Err("secure_random_failed".into());
        }
        Ok(())
    }
    pub fn read() -> Result<Option<Vec<u8>>> {
        let mut length = 0;
        let mut data = ptr::null_mut();
        let status = unsafe {
            SecKeychainFindGenericPassword(
                ptr::null(),
                SERVICE.len() as u32,
                SERVICE.as_ptr(),
                ACCOUNT.len() as u32,
                ACCOUNT.as_ptr(),
                &mut length,
                &mut data,
                ptr::null_mut(),
            )
        };
        if status == NOT_FOUND {
            return Ok(None);
        }
        if status != 0 {
            return Err("secure_store_read_failed".into());
        }
        let result = if length > 64 * 1024 || (length > 0 && data.is_null()) {
            Err("secure_store_invalid".into())
        } else if length == 0 {
            Ok(Some(Vec::new()))
        } else {
            Ok(Some(
                unsafe { std::slice::from_raw_parts(data.cast::<u8>(), length as usize) }.to_vec(),
            ))
        };
        unsafe {
            SecKeychainItemFreeContent(ptr::null_mut(), data);
        }
        result
    }
    pub fn write(bytes: &[u8]) -> Result<()> {
        if bytes.len() > 64 * 1024 {
            return Err("secure_store_capacity".into());
        }
        let mut item = ptr::null_mut();
        let status = unsafe {
            SecKeychainFindGenericPassword(
                ptr::null(),
                SERVICE.len() as u32,
                SERVICE.as_ptr(),
                ACCOUNT.len() as u32,
                ACCOUNT.as_ptr(),
                ptr::null_mut(),
                ptr::null_mut(),
                &mut item,
            )
        };
        let result = if status == NOT_FOUND {
            unsafe {
                SecKeychainAddGenericPassword(
                    ptr::null(),
                    SERVICE.len() as u32,
                    SERVICE.as_ptr(),
                    ACCOUNT.len() as u32,
                    ACCOUNT.as_ptr(),
                    bytes.len() as u32,
                    bytes.as_ptr().cast(),
                    ptr::null_mut(),
                )
            }
        } else if status == 0 && item.is_null() {
            return Err("secure_store_write_failed".into());
        } else if status == 0 {
            let status = unsafe {
                SecKeychainItemModifyAttributesAndData(
                    item,
                    ptr::null(),
                    bytes.len() as u32,
                    bytes.as_ptr().cast(),
                )
            };
            unsafe {
                CFRelease(item);
            }
            status
        } else {
            status
        };
        if result != 0 {
            return Err("secure_store_write_failed".into());
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
#[path = "vault_windows.rs"]
mod native;
