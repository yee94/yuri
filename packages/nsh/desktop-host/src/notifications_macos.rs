//! Public UserNotifications ABI; no Alert/NSUserNotification fallback. SDK evidence in the doc.
use super::{
    Activation, Driver,
    policy::{self, Result, UNAVAILABLE},
};
use nsh_platform_macos::{
    objc2::{
        msg_send,
        rc::Retained,
        runtime::{AnyClass, AnyObject, AnyProtocol, Bool, ClassBuilder, Sel},
        sel,
    },
    objc2_foundation::{MainThreadMarker, NSString},
};
use serde_json::Value;
use std::{
    collections::HashSet,
    ffi::{c_char, c_void},
    ptr,
    sync::{Arc, Mutex, OnceLock, mpsc},
    time::Duration,
};

#[link(name = "UserNotifications", kind = "framework")]
unsafe extern "C" {
    static UNNotificationDefaultActionIdentifier: *mut AnyObject;
}
#[link(name = "AppKit", kind = "framework")]
unsafe extern "C" {
    static mut NSApp: *mut AnyObject;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFGetTypeID(object: *const c_void) -> usize;
    fn CFBooleanGetTypeID() -> usize;
}
unsafe extern "C" {
    static _NSConcreteStackBlock: c_void;
    fn _Block_copy(block: *const c_void) -> *mut c_void;
    fn _Block_release(block: *const c_void);
}
// Clang Blocks ABI (Block_private.h): copy/dispose helpers retain the Arc on each heap copy.
// No borrowed captures survive submission/timeout. Callbacks can arrive after owner shutdown.
type Callback = dyn Fn(*mut AnyObject, bool) + Send + Sync;
#[repr(C)]
struct Block {
    isa: *const c_void,
    flags: i32,
    reserved: i32,
    invoke: *const c_void,
    descriptor: *const Descriptor,
    context: *const Arc<Callback>,
}
unsafe impl nsh_platform_macos::objc2::encode::RefEncode for Block {
    const ENCODING_REF: nsh_platform_macos::objc2::encode::Encoding =
        nsh_platform_macos::objc2::encode::Encoding::Block;
}
#[repr(C)]
struct Descriptor {
    reserved: usize,
    size: usize,
    copy: unsafe extern "C" fn(*mut Block, *const Block),
    dispose: unsafe extern "C" fn(*mut Block),
    signature: *const c_char,
}
unsafe impl Sync for Descriptor {}
unsafe extern "C" fn copy_block(dst: *mut Block, src: *const Block) {
    unsafe {
        (*dst).context = Box::into_raw(Box::new((*(*src).context).clone()));
    }
}
unsafe extern "C" fn dispose_block(block: *mut Block) {
    unsafe {
        drop(Box::from_raw((*block).context.cast_mut()));
    }
}
static OBJECT: Descriptor = Descriptor {
    reserved: 0,
    size: std::mem::size_of::<Block>(),
    copy: copy_block,
    dispose: dispose_block,
    signature: c"v@?@".as_ptr(),
};
static PERMISSION: Descriptor = Descriptor {
    reserved: 0,
    size: std::mem::size_of::<Block>(),
    copy: copy_block,
    dispose: dispose_block,
    signature: if cfg!(target_arch = "aarch64") {
        c"v@?B@".as_ptr()
    } else {
        c"v@?c@".as_ptr()
    },
};
unsafe extern "C" fn object_callback(block: *const Block, value: *mut AnyObject) {
    nsh_platform_macos::objc2::rc::autoreleasepool(|_| unsafe {
        (*(*block).context)(value, false)
    });
}
unsafe extern "C" fn permission_callback(
    block: *const Block,
    granted: Bool,
    error: *mut AnyObject,
) {
    nsh_platform_macos::objc2::rc::autoreleasepool(|_| unsafe {
        (*(*block).context)(error, granted.as_bool())
    });
}
struct HeapBlock(*mut c_void);
impl HeapBlock {
    fn new(permission: bool, callback: Arc<Callback>) -> Self {
        let context = Box::into_raw(Box::new(callback));
        let block = Block {
            isa: ptr::addr_of!(_NSConcreteStackBlock),
            flags: (1 << 25) | (1 << 30),
            reserved: 0,
            invoke: if permission {
                permission_callback as *const c_void
            } else {
                object_callback as *const c_void
            },
            descriptor: if permission { &PERMISSION } else { &OBJECT },
            context,
        };
        let heap = unsafe { _Block_copy(ptr::addr_of!(block).cast()) };
        unsafe {
            drop(Box::from_raw(context));
        }
        Self(heap)
    }
}
impl Drop for HeapBlock {
    fn drop(&mut self) {
        unsafe {
            _Block_release(self.0);
        }
    }
}
fn class(name: &'static str) -> Result<&'static AnyClass> {
    let name = std::ffi::CString::new(name).map_err(|_| UNAVAILABLE)?;
    AnyClass::get(&name).ok_or_else(|| "notification_unsupported".into())
}
unsafe fn string(value: *mut AnyObject) -> Option<String> {
    if value.is_null() {
        return None;
    }
    let string_class = class("NSString").ok()?;
    let is_string: Bool = unsafe { msg_send![value, isKindOfClass:string_class] };
    if !is_string.as_bool() {
        return None;
    }
    let p: *const c_char = unsafe { msg_send![value, UTF8String] };
    if p.is_null() {
        None
    } else {
        unsafe { std::ffi::CStr::from_ptr(p) }
            .to_str()
            .ok()
            .map(str::to_owned)
    }
}
static SINK: OnceLock<Mutex<Option<Activation>>> = OnceLock::new();
fn sink() -> Option<Activation> {
    SINK.get()?.lock().ok()?.clone()
}
unsafe fn receipt(notification: *mut AnyObject) -> Option<String> {
    if notification.is_null() {
        return None;
    }
    unsafe {
        let request: *mut AnyObject = msg_send![notification, request];
        let identifier: *mut AnyObject = msg_send![request, identifier];
        let s = string(identifier)?;
        let id = s.strip_prefix("yuri.nsh.local.")?;
        if !policy::uuid(id) {
            return None;
        }
        let content: *mut AnyObject = msg_send![request, content];
        let info: *mut AnyObject = msg_send![content, userInfo];
        let count: usize = msg_send![info, count];
        if count != 2 {
            return None;
        }
        let r: *mut AnyObject = msg_send![info, objectForKey: &*NSString::from_str("receipt")];
        let v: *mut AnyObject = msg_send![info, objectForKey: &*NSString::from_str("v")];
        if v.is_null() || CFGetTypeID(v.cast()) == CFBooleanGetTypeID() {
            return None;
        }
        let is_number: Bool = msg_send![v, isKindOfClass:class("NSNumber").ok()?];
        if !is_number.as_bool() {
            return None;
        }
        let version: f64 = msg_send![v, doubleValue];
        if version == 1.0 && string(r).as_deref() == Some(id) {
            Some(id.into())
        } else {
            None
        }
    }
}
// Completion blocks are supplied by the OS; read only their common block header/invoke slot.
unsafe extern "C" fn present(
    _: *mut AnyObject,
    _: Sel,
    _: *mut AnyObject,
    notification: *mut AnyObject,
    completion: *mut Block,
) {
    let options = unsafe { receipt(notification) }
        .and_then(|id| sink().map(|s| s.may_present(&id)))
        .filter(|v| *v)
        .map(|_| 2usize | 8 | 16)
        .unwrap_or(0);
    let invoke: unsafe extern "C" fn(*mut Block, usize) =
        unsafe { std::mem::transmute((*completion).invoke) };
    unsafe {
        invoke(completion, options);
    }
}
unsafe extern "C" fn receive(
    _: *mut AnyObject,
    _: Sel,
    _: *mut AnyObject,
    response: *mut AnyObject,
    completion: *mut Block,
) {
    unsafe {
        let action: *mut AnyObject = msg_send![response, actionIdentifier];
        let default_action: Bool = msg_send![action, isEqual:UNNotificationDefaultActionIdentifier];
        if default_action.as_bool() {
            let notification: *mut AnyObject = msg_send![response, notification];
            if let (Some(id), Some(sink)) = (receipt(notification), sink()) {
                let _ = sink.receive(&id);
            }
        }
        let invoke: unsafe extern "C" fn(*mut Block) = std::mem::transmute((*completion).invoke);
        invoke(completion);
    }
}
// UNUserNotificationCenter explicitly permits calls from any thread. This wrapper is never
// used for arbitrary AppKit objects; it only keeps that center alive through a late callback.
struct CallbackCenter(Retained<AnyObject>);
unsafe impl Send for CallbackCenter {}
unsafe impl Sync for CallbackCenter {}
pub struct Native {
    center: Retained<AnyObject>,
    delegate: Retained<AnyObject>,
    activation: Activation,
    pending: Arc<Mutex<HashSet<String>>>,
}
impl Native {
    /// Call early, before didFinishLaunching returns / before JS; no request or notification here.
    /// This may be constructed by the worker; UN delegate methods are not UI operations.
    pub fn new(activation: Activation) -> Result<Self> {
        let mut global = SINK
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|_| UNAVAILABLE)?;
        if global.is_some() {
            return Err(UNAVAILABLE.into());
        }
        let delegate_class = if let Some(c) = AnyClass::get(c"YuriDesktopNotificationsDelegate") {
            c
        } else {
            let mut b = ClassBuilder::new(c"YuriDesktopNotificationsDelegate", class("NSObject")?)
                .ok_or(UNAVAILABLE)?;
            if let Some(protocol) = AnyProtocol::get(c"UNUserNotificationCenterDelegate") {
                b.add_protocol(protocol);
            }
            unsafe {
                b.add_method(
                    sel!(userNotificationCenter:willPresentNotification:withCompletionHandler:),
                    present as unsafe extern "C" fn(_, _, _, _, _),
                );
                b.add_method(sel!(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:), receive as unsafe extern "C" fn(_,_,_,_,_));
            }
            b.register()
        };
        unsafe {
            if NSApp.is_null() {
                return Err(UNAVAILABLE.into());
            }
            // Unbundled executables must not call currentNotificationCenter (Apple raises).
            let bundle: *mut AnyObject = msg_send![class("NSBundle")?, mainBundle];
            let identifier: *mut AnyObject = msg_send![bundle, bundleIdentifier];
            if identifier.is_null() {
                return Err("notification_unsupported".into());
            }
            let center: Retained<AnyObject> = msg_send![
                class("UNUserNotificationCenter")?,
                currentNotificationCenter
            ];
            let previous: *mut AnyObject = msg_send![&*center, delegate];
            if !previous.is_null() {
                return Err(UNAVAILABLE.into());
            }
            let delegate: Retained<AnyObject> = msg_send![delegate_class, new];
            *global = Some(activation.clone());
            let _: () = msg_send![&*center, setDelegate: &*delegate];
            Ok(Self {
                center,
                delegate,
                activation,
                pending: Arc::new(Mutex::new(HashSet::new())),
            })
        }
    }
    fn query(&self, delivered: bool) -> Result<Vec<String>> {
        let (tx, rx) = mpsc::sync_channel(1);
        let callback = HeapBlock::new(
            false,
            Arc::new(move |array, _| {
                let mut ids = Vec::new();
                if array.is_null() {
                    let _ = tx.try_send(Err(UNAVAILABLE.into()));
                    return;
                }
                unsafe {
                    let count: usize = msg_send![array, count];
                    if count > 4096 {
                        let _ = tx.try_send(Err(UNAVAILABLE.into()));
                        return;
                    }
                    for i in 0..count {
                        let obj: *mut AnyObject = msg_send![array, objectAtIndex:i];
                        let request: *mut AnyObject = if delivered {
                            msg_send![obj, request]
                        } else {
                            obj
                        };
                        let id: *mut AnyObject = msg_send![request, identifier];
                        let Some(s) = string(id) else {
                            let _ = tx.try_send(Err(UNAVAILABLE.into()));
                            return;
                        };
                        ids.push(s);
                    }
                }
                let _ = tx.try_send(Ok(ids));
            }),
        );
        unsafe {
            if delivered {
                let _: () = msg_send![&*self.center, getDeliveredNotificationsWithCompletionHandler: callback.0];
            } else {
                let _: () = msg_send![&*self.center, getPendingNotificationRequestsWithCompletionHandler: callback.0];
            }
        }
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| UNAVAILABLE)?
    }
}
impl Driver for Native {
    fn status(&mut self) -> Result<Value> {
        let (tx, rx) = mpsc::sync_channel(1);
        let callback = HeapBlock::new(
            false,
            Arc::new(move |settings, _| unsafe {
                if settings.is_null() {
                    let _ = tx.try_send(Err(UNAVAILABLE.into()));
                    return;
                }
                let authorization: isize = msg_send![settings, authorizationStatus];
                let alert: isize = msg_send![settings, alertSetting];
                let sound: isize = msg_send![settings, soundSetting];
                let badge: isize = msg_send![settings, badgeSetting];
                let setting = |v| match v {
                    0 => "unsupported",
                    1 => "disabled",
                    2 => "enabled",
                    _ => "unknown",
                };
                let _ = tx.try_send(Ok(policy::status(
                    match authorization {
                        0 => "notDetermined",
                        1 => "denied",
                        2 => "authorized",
                        3 => "provisional",
                        4 => "ephemeral",
                        _ => "unknown",
                    },
                    setting(alert),
                    setting(sound),
                    setting(badge),
                )));
            }),
        );
        unsafe {
            let _: () =
                msg_send![&*self.center, getNotificationSettingsWithCompletionHandler: callback.0];
        }
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| UNAVAILABLE)?
    }
    fn request(&mut self, current: &dyn Fn() -> bool) -> Result<Value> {
        if !current() {
            return Err(policy::STALE.into());
        }
        if self.status()?["authorization"] != "notDetermined" {
            return self.status();
        }
        if !current() {
            return Err(policy::STALE.into());
        }
        let (tx, rx) = mpsc::sync_channel(1);
        let callback = HeapBlock::new(
            true,
            Arc::new(move |error, _| {
                let _ = tx.try_send(error.is_null());
            }),
        );
        unsafe {
            let _: () = msg_send![&*self.center, requestAuthorizationWithOptions: 6usize, completionHandler: callback.0];
        }
        // An OS permission dialog can remain open. Timeout reports unknown, never denial/success.
        if !rx
            .recv_timeout(Duration::from_secs(60))
            .map_err(|_| UNAVAILABLE)?
        {
            return Err(UNAVAILABLE.into());
        }
        self.status()
    }
    fn add(&mut self, receipt: &str, title: &str, body: &str) -> Result<()> {
        if !self.activation.may_present(receipt) {
            return Err(policy::STALE.into());
        }
        let (tx, rx) = mpsc::sync_channel(1);
        if self.pending.lock().map_err(|_| UNAVAILABLE)?.len() >= 256 {
            return Err(UNAVAILABLE.into());
        }
        let pending = self.pending.clone();
        let id = receipt.to_owned();
        let activation = self.activation.clone();
        let retained = unsafe { Retained::retain(Retained::as_ptr(&self.center).cast_mut()) }
            .ok_or(UNAVAILABLE)?;
        let callback_center = Arc::new(CallbackCenter(retained));
        self.pending
            .lock()
            .map_err(|_| UNAVAILABLE)?
            .insert(id.clone());
        let callback = HeapBlock::new(
            false,
            Arc::new(move |error, _| {
                // A timeout is not add completion. Re-check on the actual OS callback, including
                // after shutdown or authorization retirement; late acceptance cannot resurrect it.
                if !activation.current_submission(&id) {
                    unsafe {
                        if let Ok(array_class) = class("NSArray") {
                            let array: *mut AnyObject = msg_send![array_class, arrayWithObject:&*NSString::from_str(&format!("yuri.nsh.local.{id}"))];
                            let _: () = msg_send![&*callback_center.0, removePendingNotificationRequestsWithIdentifiers:array];
                            let _: () = msg_send![&*callback_center.0, removeDeliveredNotificationsWithIdentifiers:array];
                        }
                    }
                }
                if let Ok(mut pending) = pending.lock() {
                    pending.remove(&id);
                }
                let _ = tx.try_send(error.is_null());
            }),
        );
        unsafe {
            let content: Retained<AnyObject> =
                msg_send![class("UNMutableNotificationContent")?, new];
            let _: () = msg_send![&*content, setTitle: &*NSString::from_str(title)];
            let _: () = msg_send![&*content, setBody: &*NSString::from_str(body)];
            let sound: *mut AnyObject = msg_send![class("UNNotificationSound")?, defaultSound];
            let _: () = msg_send![&*content, setSound:sound];
            let info: Retained<AnyObject> = msg_send![class("NSMutableDictionary")?, new];
            let number: *mut AnyObject = msg_send![class("NSNumber")?, numberWithInteger:1isize];
            let _: () = msg_send![&*info, setObject:number, forKey:&*NSString::from_str("v")];
            let _: () = msg_send![&*info, setObject:&*NSString::from_str(receipt), forKey:&*NSString::from_str("receipt")];
            let _: () = msg_send![&*content, setUserInfo:&*info];
            let request: Retained<AnyObject> = msg_send![class("UNNotificationRequest")?, requestWithIdentifier:&*NSString::from_str(&format!("yuri.nsh.local.{receipt}")), content:&*content, trigger:ptr::null::<AnyObject>()];
            let _: () = msg_send![&*self.center, addNotificationRequest:&*request, withCompletionHandler:callback.0];
        }
        if rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| UNAVAILABLE)?
        {
            Ok(())
        } else {
            Err(UNAVAILABLE.into())
        }
    }
    fn remove(&mut self, receipts: &[String]) -> Result<()> {
        if self
            .pending
            .lock()
            .map_err(|_| UNAVAILABLE)?
            .iter()
            .any(|id| receipts.contains(id))
        {
            return Err(UNAVAILABLE.into());
        }
        unsafe {
            let array: Retained<AnyObject> = msg_send![class("NSMutableArray")?, new];
            for id in receipts {
                let _: () = msg_send![&*array, addObject:&*NSString::from_str(&format!("yuri.nsh.local.{id}"))];
            }
            let _: () =
                msg_send![&*self.center, removePendingNotificationRequestsWithIdentifiers:&*array];
            let _: () =
                msg_send![&*self.center, removeDeliveredNotificationsWithIdentifiers:&*array];
        }
        for id in self.query(false)?.into_iter().chain(self.query(true)?) {
            if receipts.iter().any(|r| id == format!("yuri.nsh.local.{r}")) {
                return Err(UNAVAILABLE.into());
            }
        }
        Ok(())
    }
}
impl Drop for Native {
    fn drop(&mut self) {
        unsafe {
            let current: *mut AnyObject = msg_send![&*self.center, delegate];
            if current == Retained::as_ptr(&self.delegate).cast_mut() {
                let _: () = msg_send![&*self.center, setDelegate:ptr::null::<AnyObject>()];
            }
        }
        if let Some(global) = SINK.get()
            && let Ok(mut sink) = global.lock()
        {
            *sink = None;
        }
    }
}
pub fn open_settings() -> Result<()> {
    if MainThreadMarker::new().is_none() {
        return Err(UNAVAILABLE.into());
    }
    // macOS has no public app-specific UN settings opener. Open the system Notifications pane;
    // URL routing can fail on an OS revision, in which case report unavailable, never fake success.
    unsafe {
        let url: *mut AnyObject = msg_send![class("NSURL")?, URLWithString:&*NSString::from_str("x-apple.systempreferences:com.apple.Notifications-Settings.extension")];
        let workspace: *mut AnyObject = msg_send![class("NSWorkspace")?, sharedWorkspace];
        let opened: Bool = msg_send![workspace, openURL:url];
        if opened.as_bool() {
            Ok(())
        } else {
            Err(UNAVAILABLE.into())
        }
    }
}
pub unsafe fn focus_window(window: *mut c_void) -> Result<()> {
    if MainThreadMarker::new().is_none() || window.is_null() {
        return Err(UNAVAILABLE.into());
    }
    unsafe {
        let app: *mut AnyObject = msg_send![class("NSApplication")?, sharedApplication];
        let _: () =
            msg_send![window.cast::<AnyObject>(), makeKeyAndOrderFront:ptr::null::<AnyObject>()];
        let _: () = msg_send![app, activateIgnoringOtherApps:Bool::YES];
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[test]
    fn copied_block_keeps_owned_callback_alive_after_original_drop() {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let block = HeapBlock::new(
            false,
            Arc::new(move |value, _| {
                assert!(value.is_null());
                seen.fetch_add(1, Ordering::AcqRel);
            }),
        );
        let copied = unsafe { _Block_copy(block.0) };
        drop(block);
        unsafe {
            let header = copied.cast::<Block>();
            let invoke: unsafe extern "C" fn(*const Block, *mut AnyObject) =
                std::mem::transmute((*header).invoke);
            invoke(header, ptr::null_mut());
            _Block_release(copied);
        }
        assert_eq!(calls.load(Ordering::Acquire), 1);
        assert_eq!(Arc::strong_count(&calls), 1);
    }
    #[test]
    fn block_layout_and_permission_callback_match_platform_bool_encoding() {
        assert_eq!(std::mem::offset_of!(Block, invoke), 16);
        assert_eq!(std::mem::offset_of!(Block, descriptor), 24);
        assert_eq!(std::mem::size_of::<Block>(), 40);
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let block = HeapBlock::new(
            true,
            Arc::new(move |error, granted| {
                assert!(error.is_null());
                assert!(granted);
                seen.fetch_add(1, Ordering::AcqRel);
            }),
        );
        unsafe {
            let header = block.0.cast::<Block>();
            let invoke: unsafe extern "C" fn(*const Block, Bool, *mut AnyObject) =
                std::mem::transmute((*header).invoke);
            invoke(header, Bool::YES, ptr::null_mut());
        }
        assert_eq!(calls.load(Ordering::Acquire), 1);
        use nsh_platform_macos::objc2::encode::Encode;
        let signature = unsafe { std::ffi::CStr::from_ptr(PERMISSION.signature) }
            .to_str()
            .unwrap();
        assert_eq!(signature, format!("v@?{}@", Bool::ENCODING));
    }
}
