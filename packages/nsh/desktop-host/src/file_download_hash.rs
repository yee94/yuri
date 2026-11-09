//! Incremental SHA-256 using the same OS providers as attachments_native.rs.
//! Only a successfully appended native chunk advances the retained prefix.
use crate::policy::Result;
#[cfg(target_os = "macos")]
pub struct Hash([u32; 26]);
#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn CC_SHA256_Init(context: *mut u32) -> i32;
    fn CC_SHA256_Update(context: *mut u32, bytes: *const std::ffi::c_void, length: u32) -> i32;
    fn CC_SHA256_Final(bytes: *mut u8, context: *mut u32) -> i32;
}
#[cfg(target_os = "macos")]
impl Hash {
    pub fn new() -> Result<Self> {
        let mut h = Self([0; 26]);
        if unsafe { CC_SHA256_Init(h.0.as_mut_ptr()) } != 1 {
            return Err("download_digest_failed".into());
        }
        Ok(h)
    }
    pub fn update(&mut self, bytes: &[u8]) -> Result<()> {
        let length = u32::try_from(bytes.len()).map_err(|_| "download_digest_failed")?;
        if unsafe { CC_SHA256_Update(self.0.as_mut_ptr(), bytes.as_ptr().cast(), length) } != 1 {
            return Err("download_digest_failed".into());
        }
        Ok(())
    }
    pub fn finish(&self) -> Result<String> {
        let mut context = self.0;
        let mut out = [0; 32];
        if unsafe { CC_SHA256_Final(out.as_mut_ptr(), context.as_mut_ptr()) } != 1 {
            return Err("download_digest_failed".into());
        }
        Ok(hex(&out))
    }
}
#[cfg(target_os = "windows")]
mod windows {
    use super::*;
    use std::{ffi::c_void, ptr};
    #[link(name = "bcrypt")]
    unsafe extern "system" {
        fn BCryptOpenAlgorithmProvider(
            out: *mut *mut c_void,
            name: *const u16,
            implementation: *const u16,
            flags: u32,
        ) -> i32;
        fn BCryptCreateHash(
            algorithm: *mut c_void,
            out: *mut *mut c_void,
            object: *mut u8,
            length: u32,
            secret: *const u8,
            secret_length: u32,
            flags: u32,
        ) -> i32;
        fn BCryptHashData(hash: *mut c_void, bytes: *const u8, length: u32, flags: u32) -> i32;
        fn BCryptDuplicateHash(
            hash: *mut c_void,
            out: *mut *mut c_void,
            object: *mut u8,
            length: u32,
            flags: u32,
        ) -> i32;
        fn BCryptFinishHash(hash: *mut c_void, out: *mut u8, length: u32, flags: u32) -> i32;
        fn BCryptDestroyHash(hash: *mut c_void) -> i32;
        fn BCryptCloseAlgorithmProvider(algorithm: *mut c_void, flags: u32) -> i32;
    }
    pub struct Hash {
        algorithm: *mut c_void,
        hash: *mut c_void,
    }
    // Handles are exclusively owned, moved between workers, never concurrently used.
    unsafe impl Send for Hash {}
    impl Hash {
        pub fn new() -> Result<Self> {
            let mut h = Self {
                algorithm: ptr::null_mut(),
                hash: ptr::null_mut(),
            };
            let name: Vec<u16> = "SHA256\0".encode_utf16().collect();
            if unsafe {
                BCryptOpenAlgorithmProvider(&mut h.algorithm, name.as_ptr(), ptr::null(), 0)
            } < 0
                || unsafe {
                    BCryptCreateHash(
                        h.algorithm,
                        &mut h.hash,
                        ptr::null_mut(),
                        0,
                        ptr::null(),
                        0,
                        0,
                    )
                } < 0
            {
                return Err("download_digest_failed".into());
            }
            Ok(h)
        }
        pub fn update(&mut self, bytes: &[u8]) -> Result<()> {
            let length = u32::try_from(bytes.len()).map_err(|_| "download_digest_failed")?;
            if unsafe { BCryptHashData(self.hash, bytes.as_ptr(), length, 0) } < 0 {
                return Err("download_digest_failed".into());
            }
            Ok(())
        }
        pub fn finish(&self) -> Result<String> {
            let mut duplicate = ptr::null_mut();
            if unsafe { BCryptDuplicateHash(self.hash, &mut duplicate, ptr::null_mut(), 0, 0) } < 0
            {
                return Err("download_digest_failed".into());
            }
            let mut out = [0; 32];
            let result = unsafe { BCryptFinishHash(duplicate, out.as_mut_ptr(), 32, 0) };
            unsafe {
                BCryptDestroyHash(duplicate);
            }
            if result < 0 {
                return Err("download_digest_failed".into());
            }
            Ok(hex(&out))
        }
    }
    impl Drop for Hash {
        fn drop(&mut self) {
            unsafe {
                if !self.hash.is_null() {
                    BCryptDestroyHash(self.hash);
                }
                if !self.algorithm.is_null() {
                    BCryptCloseAlgorithmProvider(self.algorithm, 0);
                }
            }
        }
    }
}
#[cfg(target_os = "windows")]
pub use windows::Hash;
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
#[path = "file_journal_hash.rs"]
mod reference;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incremental_matches_private_sha_source_at_block_and_chunk_boundaries() {
        let mut known = Hash::new().unwrap();
        known.update(b"a").unwrap();
        known.update(b"bc").unwrap();
        assert_eq!(
            known.finish().unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        for size in [0, 1, 55, 56, 63, 64, 65, 65_536, 131_073] {
            let bytes: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
            let mut h = Hash::new().unwrap();
            for chunk in bytes.chunks(17) {
                h.update(chunk).unwrap();
            }
            assert_eq!(h.finish().unwrap(), hex(&reference::sha256(&bytes)));
            assert_eq!(h.finish().unwrap(), hex(&reference::sha256(&bytes)));
        }
    }
}
