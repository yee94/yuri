//! Terminal-local COM ABI. Slots/IIDs checked against WebView2 generated IDL;
//! no SDK crate, host objects or ExecuteScript entrypoint is exposed.
use std::{
    ffi::c_void,
    ptr,
    sync::atomic::{AtomicU32, Ordering},
};
pub type Raw = *mut c_void;
pub type Hr = i32;
type Result<T> = std::result::Result<T, String>;
#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Guid {
    a: u32,
    b: u16,
    c: u16,
    d: [u8; 8],
}
pub const fn guid(v: u128) -> Guid {
    Guid {
        a: (v >> 96) as u32,
        b: (v >> 80) as u16,
        c: (v >> 64) as u16,
        d: (v as u64).to_be_bytes(),
    }
}
const UNKNOWN: Guid = guid(0x00000000_0000_0000_c000_000000000046);
#[repr(C)]
#[derive(Default, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}
#[cfg_attr(target_os = "windows", link(name = "ole32"))]
unsafe extern "system" {
    fn CoTaskMemFree(value: Raw);
}
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
pub fn ok(hr: Hr) -> Result<()> {
    if hr >= 0 {
        Ok(())
    } else {
        Err("terminal_webview2_call_failed".into())
    }
}
pub struct Com(pub Raw);
impl Com {
    pub unsafe fn retain(raw: Raw) -> Option<Self> {
        if raw.is_null() {
            return None;
        }
        let value = Self(raw);
        let f: unsafe extern "system" fn(Raw) -> u32 = unsafe { value.method(1) };
        unsafe { f(raw) };
        Some(value)
    }
    pub unsafe fn method<T: Copy>(&self, index: usize) -> T {
        assert_eq!(std::mem::size_of::<T>(), std::mem::size_of::<Raw>());
        unsafe {
            let table = *(self.0 as *const *const Raw);
            std::mem::transmute_copy(&*table.add(index))
        }
    }
    pub fn query(&self, iid: Guid) -> Result<Self> {
        let mut out = ptr::null_mut();
        let f: unsafe extern "system" fn(Raw, *const Guid, *mut Raw) -> Hr =
            unsafe { self.method(0) };
        ok(unsafe { f(self.0, &iid, &mut out) })?;
        if out.is_null() {
            Err("terminal_webview2_interface_unavailable".into())
        } else {
            Ok(Self(out))
        }
    }
    pub fn object(&self, index: usize) -> Result<Self> {
        let mut out = ptr::null_mut();
        let f: unsafe extern "system" fn(Raw, *mut Raw) -> Hr = unsafe { self.method(index) };
        ok(unsafe { f(self.0, &mut out) })?;
        if out.is_null() {
            Err("terminal_webview2_object_unavailable".into())
        } else {
            Ok(Self(out))
        }
    }
    pub fn text(&self, index: usize, value: &str) -> Result<()> {
        let value = wide(value);
        let f: unsafe extern "system" fn(Raw, *const u16) -> Hr = unsafe { self.method(index) };
        ok(unsafe { f(self.0, value.as_ptr()) })
    }
    pub fn string(&self, index: usize, limit: usize) -> Result<String> {
        let mut out = ptr::null_mut::<u16>();
        let f: unsafe extern "system" fn(Raw, *mut *mut u16) -> Hr = unsafe { self.method(index) };
        ok(unsafe { f(self.0, &mut out) })?;
        if out.is_null() {
            return Err("terminal_webview2_string_unavailable".into());
        }
        let mut len = 0;
        unsafe {
            while len < limit && *out.add(len) != 0 {
                len += 1;
            }
        }
        let result = if len == limit {
            Err("terminal_webview2_message_limit".into())
        } else {
            String::from_utf16(unsafe { std::slice::from_raw_parts(out, len) })
                .map_err(|_| "terminal_webview2_utf16_invalid".into())
        };
        unsafe { CoTaskMemFree(out.cast()) };
        result
    }
    pub fn set_bool(&self, index: usize, value: bool) -> Result<()> {
        let f: unsafe extern "system" fn(Raw, i32) -> Hr = unsafe { self.method(index) };
        ok(unsafe { f(self.0, i32::from(value)) })
    }
    pub fn call(&self, index: usize) -> Result<()> {
        let f: unsafe extern "system" fn(Raw) -> Hr = unsafe { self.method(index) };
        ok(unsafe { f(self.0) })
    }
    pub fn event(&self, index: usize, handler: &Com) -> Result<i64> {
        let mut token = 0;
        let f: unsafe extern "system" fn(Raw, Raw, *mut i64) -> Hr = unsafe { self.method(index) };
        ok(unsafe { f(self.0, handler.0, &mut token) })?;
        Ok(token)
    }
    pub fn remove(&self, index: usize, token: i64) {
        let f: unsafe extern "system" fn(Raw, i64) -> Hr = unsafe { self.method(index) };
        unsafe { f(self.0, token) };
    }
}
impl Clone for Com {
    fn clone(&self) -> Self {
        unsafe { Self::retain(self.0).expect("owned terminal COM") }
    }
}
impl Drop for Com {
    fn drop(&mut self) {
        let f: unsafe extern "system" fn(Raw) -> u32 = unsafe { self.method(2) };
        unsafe { f(self.0) };
    }
}

#[repr(C)]
struct Handler {
    table: *const Raw,
    refs: AtomicU32,
    iid: Guid,
    callback: Box<dyn Fn(Raw, Raw)>,
}
unsafe extern "system" fn query(this: Raw, iid: *const Guid, out: *mut Raw) -> Hr {
    if iid.is_null() || out.is_null() {
        return 0x80004003u32 as i32;
    }
    unsafe {
        *out = ptr::null_mut();
        let h = &*this.cast::<Handler>();
        if *iid == UNKNOWN || *iid == h.iid {
            *out = this;
            add_ref(this);
            0
        } else {
            0x80004002u32 as i32
        }
    }
}
unsafe extern "system" fn add_ref(this: Raw) -> u32 {
    unsafe {
        (*this.cast::<Handler>())
            .refs
            .fetch_add(1, Ordering::Relaxed)
            + 1
    }
}
unsafe extern "system" fn release(this: Raw) -> u32 {
    let n = unsafe {
        (*this.cast::<Handler>())
            .refs
            .fetch_sub(1, Ordering::AcqRel)
            - 1
    };
    if n == 0 {
        unsafe { drop(Box::from_raw(this.cast::<Handler>())) };
    }
    n
}
unsafe extern "system" fn invoke(this: Raw, sender: Raw, args: Raw) -> Hr {
    callback(this, sender, args)
}
unsafe extern "system" fn completed(this: Raw, status: Hr, value: Raw) -> Hr {
    callback(this, status as isize as Raw, value)
}
fn callback(this: Raw, a: Raw, b: Raw) -> Hr {
    // Rust unwinding must never cross the COM/system ABI boundary.
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
        ((*this.cast::<Handler>()).callback)(a, b)
    })) {
        Ok(()) => 0,
        Err(_) => 0x80004005u32 as i32,
    }
}
struct Table([Raw; 4]);
unsafe impl Sync for Table {}
static EVENT: Table = Table([query as Raw, add_ref as Raw, release as Raw, invoke as Raw]);
static COMPLETED: Table = Table([
    query as Raw,
    add_ref as Raw,
    release as Raw,
    completed as Raw,
]);
pub fn handler(iid: Guid, is_completed: bool, callback: impl Fn(Raw, Raw) + 'static) -> Com {
    Com(Box::into_raw(Box::new(Handler {
        table: if is_completed {
            COMPLETED.0.as_ptr()
        } else {
            EVENT.0.as_ptr()
        },
        refs: AtomicU32::new(1),
        iid,
        callback: Box::new(callback),
    }))
    .cast())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn callback_iunknown_layout_and_hresult_are_system_abi() {
        assert_eq!(std::mem::size_of::<Guid>(), 16);
        assert_eq!(std::mem::size_of::<Rect>(), 16);
        assert_eq!(std::mem::offset_of!(Handler, table), 0);
        let seen = std::rc::Rc::new(std::cell::Cell::new(0));
        let result = seen.clone();
        let iid = guid(0x57213f19_00e6_49fa_8e07_898ea01ecbd2);
        let h = handler(iid, true, move |status, _| {
            result.set(status as isize as i32)
        });
        let alias = h.query(iid).unwrap();
        assert!(h.query(guid(1)).is_err());
        let f: unsafe extern "system" fn(Raw, Hr, Raw) -> Hr = unsafe { alias.method(3) };
        assert_eq!(unsafe { f(alias.0, -42, ptr::null_mut()) }, 0);
        assert_eq!(seen.get(), -42);
        drop(alias);
        drop(h);
    }
}
