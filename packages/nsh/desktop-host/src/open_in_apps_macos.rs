//! LaunchServices-backed NSWorkspace lookup, not filesystem/name/path guesses or mdfind.
use super::*;
use nsh_platform_macos::{
    objc2::{msg_send, rc::Retained, runtime::AnyObject},
    objc2_app_kit::NSWorkspace,
    objc2_foundation::{NSBundle, NSString},
};
pub const NAME: &str = "macos";
pub const SOURCE: &str = "workspace";
pub fn discover() -> Result<Vec<App>> {
    nsh_platform_macos::objc2::rc::autoreleasepool(|_| {
        let workspace = NSWorkspace::sharedWorkspace();
        let mut apps = Vec::new();
        for (id, label, lookup) in CANDIDATES {
            // Public NSWorkspace API (deprecated, still present in the NSH 0.4 SDK).
            // Nil is LaunchServices' absent result, never a fallback directory search.
            let path: Option<Retained<NSString>> = unsafe {
                msg_send![&*workspace, fullPathForApplication: &*NSString::from_str(lookup)]
            };
            let Some(path) = path else {
                continue;
            };
            let bundle = NSBundle::bundleWithPath(&path).ok_or("open_in_apps_bundle_invalid")?;
            if bundle.bundleIdentifier().is_none() {
                return Err("open_in_apps_bundle_invalid".into());
            }
            let key = NSString::from_str("CFBundleShortVersionString");
            let version: Option<Retained<AnyObject>> =
                unsafe { msg_send![&*bundle, objectForInfoDictionaryKey: &*key] };
            let version = match version {
                None => None,
                Some(value) => {
                    let is_string: bool = unsafe {
                        msg_send![&*value, isKindOfClass: nsh_platform_macos::objc2::class!(NSString)]
                    };
                    if !is_string {
                        return Err("open_in_apps_bundle_invalid".into());
                    }
                    let value: &NSString = unsafe { &*((&*value as *const AnyObject).cast()) };
                    Some(value.to_string())
                }
            };
            apps.push(app(id, label, version));
        }
        Ok(apps)
    })
}
