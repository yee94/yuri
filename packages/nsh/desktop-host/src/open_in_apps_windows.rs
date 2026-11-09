//! Read only HKCU/HKLM App Paths (both registry views) and the OS Explorer executable.
//! No PATH search, shell, PowerShell, recursive scan, or package-directory guessing.
use super::*;
use std::{ffi::c_void, ptr};
pub const NAME: &str = "windows";
pub const SOURCE: &str = "app-paths";
type HKey = *mut c_void;
#[link(name = "advapi32")]
unsafe extern "system" {
    fn RegOpenKeyExW(
        key: HKey,
        subkey: *const u16,
        options: u32,
        access: u32,
        result: *mut HKey,
    ) -> i32;
    fn RegQueryValueExW(
        key: HKey,
        name: *const u16,
        reserved: *mut u32,
        kind: *mut u32,
        data: *mut u8,
        size: *mut u32,
    ) -> i32;
    fn RegCloseKey(key: HKey) -> i32;
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetWindowsDirectoryW(buffer: *mut u16, size: u32) -> u32;
}
struct Key(HKey);
impl Drop for Key {
    fn drop(&mut self) {
        unsafe {
            RegCloseKey(self.0);
        }
    }
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn registered(exe: &str) -> Result<Option<String>> {
    let subkey = wide(&format!(
        "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{exe}"
    ));
    for root in [0x80000001u32, 0x80000002u32] {
        for view in [0x0100u32, 0x0200u32] {
            let mut key = ptr::null_mut();
            let status = unsafe {
                RegOpenKeyExW(
                    (root as i32 as isize) as HKey,
                    subkey.as_ptr(),
                    0,
                    0x20019 | view,
                    &mut key,
                )
            };
            if status == 2 {
                continue;
            }
            if status != 0 {
                return Err("open_in_apps_registry_failed".into());
            }
            let key = Key(key);
            let mut data = vec![0u16; 32768];
            let mut size = (data.len() * 2) as u32;
            let mut kind = 0;
            let status = unsafe {
                RegQueryValueExW(
                    key.0,
                    ptr::null(),
                    ptr::null_mut(),
                    &mut kind,
                    data.as_mut_ptr().cast(),
                    &mut size,
                )
            };
            if status != 0
                || kind != 1
                || size < 4
                || size % 2 != 0
                || size as usize > data.len() * 2
            {
                return Err("open_in_apps_registry_failed".into());
            }
            let units = &data[..size as usize / 2];
            if units.last() != Some(&0) || units[..units.len() - 1].contains(&0) {
                return Err("open_in_apps_registry_failed".into());
            }
            let path = String::from_utf16(&units[..units.len() - 1])
                .map_err(|_| "open_in_apps_registry_failed")?;
            validate_directory(&path)?;
            if !path.to_ascii_lowercase().ends_with(".exe") {
                return Err("open_in_apps_registry_failed".into());
            }
            let metadata =
                std::fs::metadata(&path).map_err(|_| "open_in_apps_registered_file_unavailable")?;
            if !metadata.is_file() {
                return Err("open_in_apps_registered_file_unavailable".into());
            }
            return Ok(Some(path));
        }
    }
    Ok(None)
}
pub fn discover() -> Result<Vec<App>> {
    let mut apps = Vec::new();
    for (id, label, _) in CANDIDATES {
        if *id == "finder" {
            let mut directory = vec![0u16; 32768];
            let count =
                unsafe { GetWindowsDirectoryW(directory.as_mut_ptr(), directory.len() as u32) }
                    as usize;
            if count == 0 || count >= directory.len() {
                return Err("open_in_apps_system_directory_failed".into());
            }
            let directory = String::from_utf16(&directory[..count])
                .map_err(|_| "open_in_apps_system_directory_failed")?;
            let path = format!("{directory}\\explorer.exe");
            if !std::fs::metadata(path)
                .map_err(|_| "open_in_apps_explorer_unavailable")?
                .is_file()
            {
                return Err("open_in_apps_explorer_unavailable".into());
            }
            apps.push(app(id, "Explorer", None));
            continue;
        }
        let exes: &[&str] = match *id {
            "terminal" => &["wt.exe"],
            "vscode" => &["Code.exe"],
            "vscode-insiders" => &["Code - Insiders.exe"],
            "cursor" => &["Cursor.exe"],
            "visual-studio" => &["devenv.exe"],
            "android-studio" => &["studio64.exe"],
            "intellij" => &["idea64.exe"],
            "pycharm" => &["pycharm64.exe"],
            "webstorm" => &["webstorm64.exe"],
            "rider" => &["rider64.exe"],
            "phpstorm" => &["phpstorm64.exe"],
            "rustrover" => &["rustrover64.exe"],
            "sublime-text" => &["sublime_text.exe", "subl.exe"],
            "zed" => &["zed.exe"],
            "wu" => &["wu.exe"],
            "eclipse" => &["eclipse.exe"],
            "windsurf" => &["Windsurf.exe"],
            "vscodium" => &["VSCodium.exe"],
            "kiro" => &["Kiro.exe"],
            "antigravity" => &["Antigravity.exe"],
            "trae" => &["Trae.exe"],
            _ => &[],
        };
        for exe in exes {
            if registered(exe)?.is_some() {
                apps.push(app(id, label, None));
                break;
            }
        }
    }
    Ok(apps)
}
