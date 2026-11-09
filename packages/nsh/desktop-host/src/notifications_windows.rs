//! WinRT toast + native COM activator, no powershell/process/balloon/Alert fallback.
//! Requires the installer's exact AUMID + ToastActivatorCLSID shortcut/LocalServer32 registration.
//! All objects except agile COM callbacks stay on the dedicated MTA worker.
use crate::notifications::{
    Activation, Driver,
    policy::{self, INVALID, Result, UNAVAILABLE},
};
use serde_json::Value;
use std::{
    collections::HashMap,
    ffi::c_void,
    ptr,
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    },
};

#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Guid {
    pub data1: u32,
    pub data2: u16,
    pub data3: u16,
    pub data4: [u8; 8],
}
impl Guid {
    pub const fn from_u128(v: u128) -> Self {
        Self {
            data1: (v >> 96) as u32,
            data2: (v >> 80) as u16,
            data3: (v >> 64) as u16,
            data4: (v as u64).to_be_bytes(),
        }
    }
}
const UNKNOWN: Guid = Guid::from_u128(0x00000000_0000_0000_c000_000000000046);
const CLASS_FACTORY: Guid = Guid::from_u128(0x00000001_0000_0000_c000_000000000046);
const AGILE: Guid = Guid::from_u128(0x94ea2b94_e9cc_49e0_c0ff_ee64ca8f5b90);
const ACTIVATION: Guid = Guid::from_u128(0x53e31837_6600_4a81_9395_75cffe746f94);
const MANAGER: Guid = Guid::from_u128(0x50ac103f_d235_4598_bbef_98fe4d1a3ad4);
const MANAGER2: Guid = Guid::from_u128(0x7ab93c52_0e48_4750_ba9d_1a4113981847);
const TOAST_FACTORY: Guid = Guid::from_u128(0x04124b20_82c6_4229_b109_fd9ed4662b53);
const TOAST2: Guid = Guid::from_u128(0x9dfb9fd1_143a_490e_90bf_b9fba7132de7);
const HISTORY2: Guid = Guid::from_u128(0x3bc3d253_2f31_4092_9129_8ad5abf067da);
const XML_IO: Guid = Guid::from_u128(0x6cd0e74e_ee65_4489_9ebf_ca43e87ba637);
const E_NOINTERFACE: i32 = 0x80004002u32 as i32;
const E_INVALIDARG: i32 = 0x80070057u32 as i32;
const E_FAIL: i32 = 0x80004005u32 as i32;
type P = *mut c_void;
type QI = unsafe extern "system" fn(P, *const Guid, *mut P) -> i32;
type RefFn = unsafe extern "system" fn(P) -> u32;
type Get = unsafe extern "system" fn(P, *mut P) -> i32;
type Put = unsafe extern "system" fn(P, P) -> i32;
type GetWith = unsafe extern "system" fn(P, P, *mut P) -> i32;
#[cfg_attr(target_os = "windows", link(name = "combase"))]
unsafe extern "system" {
    fn RoInitialize(kind: u32) -> i32;
    fn RoUninitialize();
    fn RoGetActivationFactory(name: P, iid: *const Guid, out: *mut P) -> i32;
    fn RoActivateInstance(name: P, out: *mut P) -> i32;
    fn WindowsCreateString(value: *const u16, length: u32, out: *mut P) -> i32;
    fn WindowsDeleteString(value: P) -> i32;
    fn WindowsGetStringRawBuffer(value: P, length: *mut u32) -> *const u16;
}
#[cfg_attr(target_os = "windows", link(name = "ole32"))]
unsafe extern "system" {
    fn CoRegisterClassObject(
        clsid: *const Guid,
        factory: P,
        context: u32,
        flags: u32,
        cookie: *mut u32,
    ) -> i32;
    fn CoRevokeClassObject(cookie: u32) -> i32;
    fn CoTaskMemFree(value: P);
}
#[cfg_attr(target_os = "windows", link(name = "shell32"))]
unsafe extern "system" {
    fn GetCurrentProcessExplicitAppUserModelID(out: *mut *mut u16) -> i32;
    fn ShellExecuteW(
        owner: P,
        verb: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show: i32,
    ) -> isize;
}
fn check(hr: i32) -> Result<()> {
    if hr >= 0 {
        Ok(())
    } else {
        Err(UNAVAILABLE.into())
    }
}
// Exact IUnknown/IInspectable slots audited against Windows metadata; no Rust trait object casts.
unsafe fn slot<T: Copy>(object: P, index: usize) -> T {
    unsafe {
        let table = *(object as *const *const P);
        std::mem::transmute_copy(&*table.add(index))
    }
}
struct Com(P);
impl Com {
    fn query(&self, iid: &Guid) -> Result<Self> {
        let mut out = ptr::null_mut();
        unsafe {
            check(slot::<QI>(self.0, 0)(self.0, iid, &mut out))?;
        }
        if out.is_null() {
            Err(UNAVAILABLE.into())
        } else {
            Ok(Self(out))
        }
    }
    fn get(&self, index: usize) -> Result<Self> {
        let mut out = ptr::null_mut();
        unsafe {
            check(slot::<Get>(self.0, index)(self.0, &mut out))?;
        }
        if out.is_null() {
            Err(UNAVAILABLE.into())
        } else {
            Ok(Self(out))
        }
    }
    fn with(&self, index: usize, input: P) -> Result<Self> {
        let mut out = ptr::null_mut();
        unsafe {
            check(slot::<GetWith>(self.0, index)(self.0, input, &mut out))?;
        }
        if out.is_null() {
            Err(UNAVAILABLE.into())
        } else {
            Ok(Self(out))
        }
    }
    fn put(&self, index: usize, input: P) -> Result<()> {
        unsafe { check(slot::<Put>(self.0, index)(self.0, input)) }
    }
    fn text(&self, index: usize) -> Result<String> {
        let mut out = ptr::null_mut();
        unsafe {
            check(slot::<Get>(self.0, index)(self.0, &mut out))?;
        }
        HString(out).text()
    }
}
impl Drop for Com {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                slot::<RefFn>(self.0, 2)(self.0);
            }
        }
    }
}
struct HString(P);
impl HString {
    fn new(value: &str) -> Result<Self> {
        let units: Vec<u16> = value.encode_utf16().collect();
        let mut out = ptr::null_mut();
        unsafe {
            check(WindowsCreateString(
                units.as_ptr(),
                units.len() as u32,
                &mut out,
            ))?;
        }
        Ok(Self(out))
    }
    fn text(&self) -> Result<String> {
        let mut count = 0;
        let raw = unsafe { WindowsGetStringRawBuffer(self.0, &mut count) };
        if count > 8192 {
            return Err(INVALID.into());
        }
        if count == 0 {
            return Ok(String::new());
        }
        if raw.is_null() {
            return Err(INVALID.into());
        }
        String::from_utf16(unsafe { std::slice::from_raw_parts(raw, count as usize) })
            .map_err(|_| INVALID.into())
    }
}
impl Drop for HString {
    fn drop(&mut self) {
        unsafe {
            WindowsDeleteString(self.0);
        }
    }
}
fn factory(name: &str, iid: &Guid) -> Result<Com> {
    let name = HString::new(name)?;
    let mut out = ptr::null_mut();
    unsafe {
        check(RoGetActivationFactory(name.0, iid, &mut out))?;
    }
    if out.is_null() {
        Err(UNAVAILABLE.into())
    } else {
        Ok(Com(out))
    }
}
unsafe fn wide(value: *const u16, limit: usize) -> Option<String> {
    if value.is_null() {
        return None;
    }
    let mut n = 0;
    while n <= limit {
        if unsafe { *value.add(n) } == 0 {
            return String::from_utf16(unsafe { std::slice::from_raw_parts(value, n) }).ok();
        }
        n += 1;
    }
    None
}
fn nullterm(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
#[derive(Clone)]
pub struct InstalledIdentity {
    pub aumid: String,
    pub activator_clsid: Guid,
}
fn verify_local_server(identity: &InstalledIdentity) -> Result<()> {
    #[cfg_attr(target_os = "windows", link(name = "advapi32"))]
    unsafe extern "system" {
        fn RegGetValueW(
            key: P,
            subkey: *const u16,
            value: *const u16,
            flags: u32,
            kind: *mut u32,
            data: P,
            bytes: *mut u32,
        ) -> i32;
    }
    let g = identity.activator_clsid;
    let tail: String = g.data4[2..].iter().map(|b| format!("{b:02X}")).collect();
    let clsid = format!(
        "{{{:08X}-{:04X}-{:04X}-{:02X}{:02X}-{tail}}}",
        g.data1, g.data2, g.data3, g.data4[0], g.data4[1]
    );
    let subkey = nullterm(&format!("Software\\Classes\\CLSID\\{clsid}\\LocalServer32"));
    let mut buffer = [0u16; 32768];
    let mut bytes = (buffer.len() * 2) as u32;
    let mut kind = 0;
    let result = unsafe {
        RegGetValueW(
            0x80000001u32 as i32 as isize as P,
            subkey.as_ptr(),
            ptr::null(),
            2 | 0x10000000 | 0x20000000,
            &mut kind,
            buffer.as_mut_ptr().cast(),
            &mut bytes,
        )
    };
    if result != 0
        || kind != 1
        || bytes < 2
        || !bytes.is_multiple_of(2)
        || bytes as usize > buffer.len() * 2
    {
        return Err("notification_unsupported_identity".into());
    }
    let command = String::from_utf16(&buffer[..bytes as usize / 2 - 1]).map_err(|_| INVALID)?;
    let executable = std::env::current_exe().map_err(|_| UNAVAILABLE)?;
    let executable = executable.to_str().ok_or(INVALID)?;
    // The runner must recognize this explicit installer-owned cold activation mode. No registry
    // writes, SDK installation, process launch or command supplied by JS occurs in this slice.
    let expected = format!("\"{executable}\" --notification-activation");
    if command.to_lowercase() != expected.to_lowercase() {
        return Err("notification_unsupported_identity".into());
    }
    Ok(())
}
struct Context {
    activation: Activation,
    aumid: String,
}
#[repr(C)]
struct FactoryVtable {
    query: QI,
    add_ref: RefFn,
    release: RefFn,
    create: unsafe extern "system" fn(P, P, *const Guid, *mut P) -> i32,
    lock: unsafe extern "system" fn(P, i32) -> i32,
}
#[repr(C)]
struct CallbackVtable {
    query: QI,
    add_ref: RefFn,
    release: RefFn,
    activate: unsafe extern "system" fn(P, *const u16, *const u16, *const UserInput, u32) -> i32,
}
#[repr(C)]
struct UserInput {
    key: *const u16,
    value: *const u16,
}
#[repr(C)]
struct FactoryObject {
    vtable: &'static FactoryVtable,
    refs: AtomicU32,
    context: Arc<Context>,
}
#[repr(C)]
struct CallbackObject {
    vtable: &'static CallbackVtable,
    refs: AtomicU32,
    context: Arc<Context>,
}
const _: () = {
    assert!(std::mem::size_of::<Guid>() == 16);
    assert!(std::mem::align_of::<Guid>() == 4);
    assert!(std::mem::offset_of!(FactoryObject, vtable) == 0);
    assert!(std::mem::offset_of!(CallbackObject, vtable) == 0);
    assert!(std::mem::offset_of!(FactoryVtable, create) == 3 * std::mem::size_of::<P>());
    assert!(std::mem::offset_of!(CallbackVtable, activate) == 3 * std::mem::size_of::<P>());
    assert!(std::mem::size_of::<FactoryVtable>() == 5 * std::mem::size_of::<P>());
    assert!(std::mem::size_of::<CallbackVtable>() == 4 * std::mem::size_of::<P>());
    assert!(std::mem::size_of::<UserInput>() == 2 * std::mem::size_of::<P>());
};
unsafe extern "system" fn factory_query(this: P, iid: *const Guid, out: *mut P) -> i32 {
    if iid.is_null() || out.is_null() {
        return E_INVALIDARG;
    }
    unsafe {
        *out = ptr::null_mut();
        if *iid == UNKNOWN || *iid == CLASS_FACTORY || *iid == AGILE {
            *out = this;
            factory_add(this);
            0
        } else {
            E_NOINTERFACE
        }
    }
}
unsafe extern "system" fn factory_add(this: P) -> u32 {
    unsafe {
        (*(this as *mut FactoryObject))
            .refs
            .fetch_add(1, Ordering::Relaxed)
            + 1
    }
}
unsafe extern "system" fn factory_release(this: P) -> u32 {
    let n = unsafe {
        (*(this as *mut FactoryObject))
            .refs
            .fetch_sub(1, Ordering::AcqRel)
            - 1
    };
    if n == 0 {
        unsafe {
            drop(Box::from_raw(this as *mut FactoryObject));
        }
    }
    n
}
unsafe extern "system" fn callback_query(this: P, iid: *const Guid, out: *mut P) -> i32 {
    if iid.is_null() || out.is_null() {
        return E_INVALIDARG;
    }
    unsafe {
        *out = ptr::null_mut();
        if *iid == UNKNOWN || *iid == ACTIVATION || *iid == AGILE {
            *out = this;
            callback_add(this);
            0
        } else {
            E_NOINTERFACE
        }
    }
}
unsafe extern "system" fn callback_add(this: P) -> u32 {
    unsafe {
        (*(this as *mut CallbackObject))
            .refs
            .fetch_add(1, Ordering::Relaxed)
            + 1
    }
}
unsafe extern "system" fn callback_release(this: P) -> u32 {
    let n = unsafe {
        (*(this as *mut CallbackObject))
            .refs
            .fetch_sub(1, Ordering::AcqRel)
            - 1
    };
    if n == 0 {
        unsafe {
            drop(Box::from_raw(this as *mut CallbackObject));
        }
    }
    n
}
unsafe extern "system" fn create(this: P, outer: P, iid: *const Guid, out: *mut P) -> i32 {
    if !outer.is_null() {
        return 0x80040110u32 as i32;
    }
    if iid.is_null() || out.is_null() {
        return E_INVALIDARG;
    }
    let callback = Box::into_raw(Box::new(CallbackObject {
        vtable: &CALLBACK_VTABLE,
        refs: AtomicU32::new(1),
        context: unsafe { (*(this as *mut FactoryObject)).context.clone() },
    }));
    unsafe {
        let result = callback_query(callback.cast(), iid, out);
        callback_release(callback.cast());
        result
    }
}
unsafe extern "system" fn server_lock(_: P, _: i32) -> i32 {
    0
}
unsafe extern "system" fn activate(
    this: P,
    aumid: *const u16,
    args: *const u16,
    _data: *const UserInput,
    count: u32,
) -> i32 {
    // Input fields/commands are not supported: the only action is default body activation.
    if count != 0 {
        return E_INVALIDARG;
    }
    let context = unsafe { &(*(this as *mut CallbackObject)).context };
    if unsafe { wide(aumid, 128) }.as_deref() != Some(&context.aumid) {
        return E_INVALIDARG;
    }
    let Some(args) = (unsafe { wide(args, 64) }) else {
        return E_INVALIDARG;
    };
    let Some(receipt) = args
        .strip_prefix("yuri.nsh.local.")
        .filter(|s| policy::uuid(s))
    else {
        return E_INVALIDARG;
    };
    match context.activation.receive(receipt) {
        Ok(true) => 0,
        Ok(false) => E_INVALIDARG,
        Err(_) => E_FAIL,
    }
}
static FACTORY_VTABLE: FactoryVtable = FactoryVtable {
    query: factory_query,
    add_ref: factory_add,
    release: factory_release,
    create,
    lock: server_lock,
};
static CALLBACK_VTABLE: CallbackVtable = CallbackVtable {
    query: callback_query,
    add_ref: callback_add,
    release: callback_release,
    activate,
};
pub struct Native {
    aumid: String,
    cookie: u32,
    notifier: Com,
    live: HashMap<String, Com>,
    activation: Activation,
}
impl Native {
    pub fn new(identity: InstalledIdentity, activation: Activation) -> Result<Self> {
        if identity.aumid.is_empty()
            || identity.aumid.len() > 128
            || !identity
                .aumid
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        {
            return Err(INVALID.into());
        }
        verify_local_server(&identity)?;
        unsafe {
            check(RoInitialize(1))?;
        }
        // Balance every successful RoInitialize, including partial startup failure.
        let result = (|| -> Result<Self> {
            let mut actual = ptr::null_mut();
            unsafe {
                check(GetCurrentProcessExplicitAppUserModelID(&mut actual))?;
            }
            let matches = unsafe { wide(actual, 128) }.as_deref() == Some(&identity.aumid);
            unsafe {
                CoTaskMemFree(actual.cast());
            }
            if !matches {
                return Err("notification_unsupported_identity".into());
            }
            let manager = factory(
                "Windows.UI.Notifications.ToastNotificationManager",
                &MANAGER,
            )?;
            let notifier = manager.with(7, HString::new(&identity.aumid)?.0)?;
            let object = Box::into_raw(Box::new(FactoryObject {
                vtable: &FACTORY_VTABLE,
                refs: AtomicU32::new(1),
                context: Arc::new(Context {
                    activation: activation.clone(),
                    aumid: identity.aumid.clone(),
                }),
            }));
            let mut cookie = 0;
            let registered = unsafe {
                CoRegisterClassObject(&identity.activator_clsid, object.cast(), 4, 1, &mut cookie)
            };
            unsafe {
                factory_release(object.cast());
            }
            check(registered)?;
            Ok(Self {
                aumid: identity.aumid,
                cookie,
                notifier,
                live: HashMap::new(),
                activation,
            })
        })();
        if result.is_err() {
            unsafe {
                RoUninitialize();
            }
        }
        result
    }
    fn history(&self) -> Result<Com> {
        factory(
            "Windows.UI.Notifications.ToastNotificationManager",
            &MANAGER2,
        )?
        .get(6)
    }
}
fn tag_group(receipt: &str) -> Result<(String, String)> {
    if !policy::uuid(receipt) {
        return Err(INVALID.into());
    }
    let hex = receipt.replace('-', "");
    Ok((hex[..16].into(), hex[16..].into()))
}
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
impl Driver for Native {
    fn status(&mut self) -> Result<Value> {
        let mut setting = 0;
        unsafe {
            let get: unsafe extern "system" fn(P, *mut i32) -> i32 = slot(self.notifier.0, 8);
            check(get(self.notifier.0, &mut setting))?;
        }
        // Windows has no per-app requestAuthorization prompt and no authoritative sound/badge getter.
        Ok(match setting {
            0 => policy::status("authorized", "enabled", "unknown", "unsupported"),
            1..=4 => policy::status("denied", "disabled", "unknown", "unsupported"),
            _ => policy::status("unknown", "unknown", "unknown", "unsupported"),
        })
    }
    fn request(&mut self, current: &dyn Fn() -> bool) -> Result<Value> {
        if !current() {
            return Err(policy::STALE.into());
        }
        self.status()
    }
    fn add(&mut self, receipt: &str, title: &str, body: &str) -> Result<()> {
        if !self.activation.may_present(receipt) {
            return Err(policy::STALE.into());
        }
        if self.live.len() >= 256 {
            return Err(UNAVAILABLE.into());
        }
        let xml = format!(
            "<toast launch=\"yuri.nsh.local.{}\" activationType=\"foreground\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
            receipt,
            xml_escape(title),
            xml_escape(body)
        );
        let mut document = ptr::null_mut();
        let name = HString::new("Windows.Data.Xml.Dom.XmlDocument")?;
        unsafe {
            check(RoActivateInstance(name.0, &mut document))?;
        }
        if document.is_null() {
            return Err(UNAVAILABLE.into());
        }
        let document = Com(document);
        document.query(&XML_IO)?.put(6, HString::new(&xml)?.0)?;
        let toast = factory("Windows.UI.Notifications.ToastNotification", &TOAST_FACTORY)?
            .with(6, document.0)?;
        let (tag, group) = tag_group(receipt)?;
        let toast2 = toast.query(&TOAST2)?;
        toast2.put(6, HString::new(&tag)?.0)?;
        toast2.put(8, HString::new(&group)?.0)?;
        // Hold the object before Show, including an unknown HRESULT outcome. No automatic resend.
        self.live.insert(receipt.into(), toast);
        self.notifier.put(6, self.live[receipt].0)
    }
    fn remove(&mut self, receipts: &[String]) -> Result<()> {
        let history = self.history()?;
        let app = HString::new(&self.aumid)?;
        for receipt in receipts {
            if let Some(toast) = self.live.get(receipt) {
                self.notifier.put(7, toast.0)?;
            }
            let (tag, group) = tag_group(receipt)?;
            let tag = HString::new(&tag)?;
            let group = HString::new(&group)?;
            unsafe {
                let remove: unsafe extern "system" fn(P, P, P, P) -> i32 = slot(history.0, 8);
                check(remove(history.0, tag.0, group.0, app.0))?;
            }
        }
        let items = history.query(&HISTORY2)?.with(7, app.0)?;
        let mut count = 0;
        unsafe {
            let size: unsafe extern "system" fn(P, *mut u32) -> i32 = slot(items.0, 7);
            check(size(items.0, &mut count))?;
        }
        if count > 4096 {
            return Err(UNAVAILABLE.into());
        }
        let pairs: Vec<_> = receipts
            .iter()
            .map(|r| tag_group(r))
            .collect::<Result<_>>()?;
        for i in 0..count {
            let mut toast = ptr::null_mut();
            unsafe {
                let get: unsafe extern "system" fn(P, u32, *mut P) -> i32 = slot(items.0, 6);
                check(get(items.0, i, &mut toast))?;
            }
            if toast.is_null() {
                return Err(UNAVAILABLE.into());
            }
            let toast = Com(toast).query(&TOAST2)?;
            let pair = (toast.text(7)?, toast.text(9)?);
            if pairs.contains(&pair) {
                return Err(UNAVAILABLE.into());
            }
        }
        for receipt in receipts {
            self.live.remove(receipt);
        }
        Ok(())
    }
}
impl Drop for Native {
    fn drop(&mut self) {
        unsafe {
            CoRevokeClassObject(self.cookie);
        }
        self.live.clear(); /* release COM interfaces before apartment */
        unsafe {
            slot::<RefFn>(self.notifier.0, 2)(self.notifier.0);
        }
        self.notifier.0 = ptr::null_mut();
        unsafe {
            RoUninitialize();
        }
    }
}
pub fn open_settings() -> Result<()> {
    let verb = nullterm("open");
    let uri = nullterm("ms-settings:notifications");
    if unsafe {
        ShellExecuteW(
            ptr::null_mut(),
            verb.as_ptr(),
            uri.as_ptr(),
            ptr::null(),
            ptr::null(),
            1,
        )
    } > 32
    {
        Ok(())
    } else {
        Err(UNAVAILABLE.into())
    }
}
pub unsafe fn focus_window(window: P) -> Result<()> {
    #[cfg_attr(target_os = "windows", link(name = "user32"))]
    unsafe extern "system" {
        fn ShowWindow(window: P, command: i32) -> i32;
        fn SetForegroundWindow(window: P) -> i32;
        fn IsWindow(window: P) -> i32;
        fn IsIconic(window: P) -> i32;
    }
    if window.is_null() || unsafe { IsWindow(window) } == 0 {
        return Err(UNAVAILABLE.into());
    }
    unsafe {
        ShowWindow(window, if IsIconic(window) != 0 { 9 } else { 5 });
        if SetForegroundWindow(window) != 0 {
            Ok(())
        } else {
            Err(UNAVAILABLE.into())
        }
    }
}
#[cfg(test)]
mod abi_tests {
    use super::*;
    #[test]
    fn com_layout_and_uuid_split_are_exact() {
        assert_eq!(std::mem::size_of::<Guid>(), 16);
        assert_eq!(std::mem::align_of::<Guid>(), 4);
        assert_eq!(
            std::mem::size_of::<FactoryVtable>(),
            5 * std::mem::size_of::<P>()
        );
        assert_eq!(
            std::mem::size_of::<CallbackVtable>(),
            4 * std::mem::size_of::<P>()
        );
        assert_eq!(std::mem::offset_of!(FactoryObject, vtable), 0);
        assert_eq!(std::mem::offset_of!(CallbackObject, vtable), 0);
        let (tag, group) = tag_group("01234567-89ab-cdef-0123-456789abcdef").unwrap();
        assert_eq!(tag, "0123456789abcdef");
        assert_eq!(group, "0123456789abcdef");
        assert_eq!(
            ACTIVATION.data4,
            [0x93, 0x95, 0x75, 0xcf, 0xfe, 0x74, 0x6f, 0x94]
        );
        assert_eq!(xml_escape("<&\"'"), "&lt;&amp;&quot;&apos;");
    }
}
