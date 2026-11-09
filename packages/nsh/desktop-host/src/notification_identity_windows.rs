//! Installer-produced identity + real shortcut/LocalServer32 readback, never registration.
//! This module is also compiled by the metadata example; no OS call runs in its pure tests.
#[cfg(target_os = "windows")]
use crate::notifications::windows as windows_source;
use crate::policy::Result;
#[cfg(not(target_os = "windows"))]
use crate::windows_source;
use std::{ffi::c_void, ptr};
use windows_source::{Guid, InstalledIdentity};
type P = *mut c_void;
const ERROR: &str = "notification_unsupported_identity";
const APP_ID: &str = "com.yee94.yuri.nsh";
#[repr(C)]
struct Key {
    format: Guid,
    id: u32,
}
#[repr(C)]
struct Variant {
    kind: u16,
    reserved: [u16; 3],
    data: [usize; 2],
}
#[cfg_attr(target_os = "windows", link(name = "shell32"))]
unsafe extern "system" {
    fn SetCurrentProcessExplicitAppUserModelID(id: *const u16) -> i32;
    fn SHGetKnownFolderPath(id: *const Guid, flags: u32, token: P, path: *mut *mut u16) -> i32;
}
#[cfg_attr(target_os = "windows", link(name = "ole32"))]
unsafe extern "system" {
    fn CoCreateInstance(
        class: *const Guid,
        outer: P,
        context: u32,
        iid: *const Guid,
        out: *mut P,
    ) -> i32;
    fn CoTaskMemFree(value: P);
    fn PropVariantClear(value: *mut Variant) -> i32;
}
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
pub fn prepare() -> Result<()> {
    if unsafe { SetCurrentProcessExplicitAppUserModelID(wide(APP_ID).as_ptr()) } < 0 {
        Err(ERROR.into())
    } else {
        Ok(())
    }
}
fn parse(value: &serde_json::Value) -> Result<InstalledIdentity> {
    let object = value.as_object().ok_or(ERROR)?;
    if object.len() != 3 || value["v"] != 1 || value["aumid"] != APP_ID {
        return Err(ERROR.into());
    }
    let text = value["activatorCLSID"].as_str().ok_or(ERROR)?;
    if text.len() != 36
        || [8, 13, 18, 23].iter().any(|&i| text.as_bytes()[i] != b'-')
        || !text
            .bytes()
            .enumerate()
            .all(|(i, b)| [8, 13, 18, 23].contains(&i) || b.is_ascii_hexdigit())
    {
        return Err(ERROR.into());
    }
    let digits = text.replace('-', "");
    let id = u128::from_str_radix(&digits, 16).map_err(|_| ERROR)?;
    if id == 0 {
        return Err(ERROR.into());
    }
    Ok(InstalledIdentity {
        aumid: APP_ID.into(),
        activator_clsid: Guid::from_u128(id),
    })
}
unsafe fn text(pointer: *const u16) -> Result<String> {
    if pointer.is_null() {
        return Err(ERROR.into());
    }
    for n in 0..32768 {
        if unsafe { *pointer.add(n) } == 0 {
            return String::from_utf16(unsafe { std::slice::from_raw_parts(pointer, n) })
                .map_err(|_| ERROR.into());
        }
    }
    Err(ERROR.into())
}
unsafe fn slot<T: Copy>(object: P, index: usize) -> T {
    unsafe {
        let table = *(object as *const *const P);
        std::mem::transmute_copy(&*table.add(index))
    }
}
struct Com(P);
impl Com {
    fn query(&self, id: &Guid) -> Result<Self> {
        let mut out = ptr::null_mut();
        let result = unsafe {
            slot::<unsafe extern "system" fn(P, *const Guid, *mut P) -> i32>(self.0, 0)(
                self.0, id, &mut out,
            )
        };
        if result < 0 || out.is_null() {
            Err(ERROR.into())
        } else {
            Ok(Self(out))
        }
    }
}
impl Drop for Com {
    fn drop(&mut self) {
        unsafe {
            slot::<unsafe extern "system" fn(P) -> u32>(self.0, 2)(self.0);
        }
    }
}
pub fn installed() -> Result<InstalledIdentity> {
    let exe = std::env::current_exe().map_err(|_| ERROR)?;
    let manifest = exe
        .parent()
        .ok_or(ERROR)?
        .join("native-notification-identity.json");
    let meta = std::fs::symlink_metadata(&manifest).map_err(|_| ERROR)?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 2048 {
        return Err(ERROR.into());
    }
    let identity = parse(
        &serde_json::from_slice(&std::fs::read(manifest).map_err(|_| ERROR)?).map_err(|_| ERROR)?,
    )?;
    verify_shortcut(&identity, &exe)?;
    Ok(identity)
}
fn verify_shortcut(identity: &InstalledIdentity, exe: &std::path::Path) -> Result<()> {
    // This runs inside the notification worker's MTA factory, before Native's own
    // RoInitialize. Pair this local COM initialization on every path.
    #[cfg_attr(target_os = "windows", link(name = "ole32"))]
    unsafe extern "system" {
        fn CoInitializeEx(reserved: P, kind: u32) -> i32;
        fn CoUninitialize();
    }
    if unsafe { CoInitializeEx(ptr::null_mut(), 0) } < 0 {
        return Err(ERROR.into());
    }
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    let _apartment = Apartment;
    unsafe {
        let programs = Guid::from_u128(0xa77f5d77_2e2b_44c3_a6a2_aba601054a51);
        let mut path = ptr::null_mut();
        if SHGetKnownFolderPath(&programs, 0, ptr::null_mut(), &mut path) < 0 {
            return Err(ERROR.into());
        }
        let directory = text(path);
        CoTaskMemFree(path.cast());
        let shortcut = std::path::PathBuf::from(directory?).join("Yuri Native.lnk");
        let class = Guid::from_u128(0x00021401_0000_0000_c000_000000000046);
        let iid = Guid::from_u128(0x000214f9_0000_0000_c000_000000000046);
        let mut link = ptr::null_mut();
        if CoCreateInstance(&class, ptr::null_mut(), 1, &iid, &mut link) < 0 || link.is_null() {
            return Err(ERROR.into());
        }
        let link = Com(link);
        let persist = link.query(&Guid::from_u128(0x0000010b_0000_0000_c000_000000000046))?;
        if slot::<unsafe extern "system" fn(P, *const u16, u32) -> i32>(persist.0, 5)(
            persist.0,
            wide(shortcut.to_str().ok_or(ERROR)?).as_ptr(),
            0,
        ) < 0
        {
            return Err(ERROR.into());
        }
        let mut target = vec![0u16; 32768];
        if slot::<unsafe extern "system" fn(P, *mut u16, i32, P, u32) -> i32>(link.0, 3)(
            link.0,
            target.as_mut_ptr(),
            32768,
            ptr::null_mut(),
            4,
        ) < 0
            || text(target.as_ptr())?.to_lowercase() != exe.to_str().ok_or(ERROR)?.to_lowercase()
        {
            return Err(ERROR.into());
        }
        let mut arguments = vec![0u16; 32768];
        if slot::<unsafe extern "system" fn(P, *mut u16, i32) -> i32>(link.0, 10)(
            link.0,
            arguments.as_mut_ptr(),
            32768,
        ) < 0
            || !text(arguments.as_ptr())?.is_empty()
        {
            return Err(ERROR.into());
        }
        let properties = link.query(&Guid::from_u128(0x886d8eeb_8cf2_4446_8d02_cdba1dbdcf99))?;
        for id in [5, 26] {
            let key = Key {
                format: Guid::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
                id,
            };
            let mut value: Variant = std::mem::zeroed();
            let hr = slot::<unsafe extern "system" fn(P, *const Key, *mut Variant) -> i32>(
                properties.0,
                5,
            )(properties.0, &key, &mut value);
            let valid = if hr < 0 {
                false
            } else if id == 5 {
                value.kind == 31
                    && text(value.data[0] as *const u16).is_ok_and(|s| s == identity.aumid)
            } else {
                value.kind == 72
                    && value.data[0] != 0
                    && *(value.data[0] as *const Guid) == identity.activator_clsid
            };
            PropVariantClear(&mut value);
            if !valid {
                return Err(ERROR.into());
            }
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_installer_manifest_and_property_abi() {
        let good = serde_json::json!({"v":1,"aumid":APP_ID,"activatorCLSID":"a49e99f5-09dc-564b-b846-45f29eb07d39"});
        assert!(parse(&good).is_ok());
        for bad in [
            serde_json::json!({"v":1,"aumid":"candidate","activatorCLSID":good["activatorCLSID"]}),
            serde_json::json!({"v":1,"aumid":APP_ID,"activatorCLSID":"../bad"}),
        ] {
            assert!(parse(&bad).is_err());
        }
        assert_eq!(std::mem::offset_of!(Variant, data), 8);
        assert_eq!(
            std::mem::size_of::<Variant>(),
            8 + 2 * std::mem::size_of::<usize>()
        );
    }
}
