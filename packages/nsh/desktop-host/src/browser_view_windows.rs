//! WebView2 Win32 child HWND; no NSH built-in WebView (that injects window.nsh).
//! Small system COM ABI declarations, checked against Microsoft's WebView2 IDL.
//! No webview2-com dependency is imported through an accidental transitive dependency.
use super::*;
use nsh_platform_windows::{self as platform, windows::Win32::Foundation::HWND};
use std::{
    cell::RefCell,
    collections::HashMap,
    ffi::c_void,
    ptr,
    rc::{Rc, Weak},
    sync::atomic::AtomicU32,
};
type Raw = *mut c_void;
type Hr = i32;
type TimerProc = unsafe extern "system" fn(Raw, u32, usize, u32);
#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq)]
struct Guid {
    a: u32,
    b: u16,
    c: u16,
    d: [u8; 8],
}
const fn guid(v: u128) -> Guid {
    Guid {
        a: (v >> 96) as u32,
        b: (v >> 80) as u16,
        c: (v >> 64) as u16,
        d: (v as u64).to_be_bytes(),
    }
}
const UNKNOWN: Guid = guid(0x00000000_0000_0000_c000_000000000046);
#[repr(C)]
#[derive(Default, Clone, Copy, PartialEq, Eq)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}
#[link(name = "WebView2LoaderStatic", kind = "static")]
unsafe extern "system" {
    fn CreateCoreWebView2EnvironmentWithOptions(
        browser: *const u16,
        profile: *const u16,
        options: Raw,
        handler: Raw,
    ) -> Hr;
}
#[link(name = "user32")]
unsafe extern "system" {
    fn CreateWindowExW(
        ex: u32,
        class: *const u16,
        title: *const u16,
        style: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        parent: Raw,
        menu: Raw,
        instance: Raw,
        param: Raw,
    ) -> Raw;
    fn DestroyWindow(hwnd: Raw) -> i32;
    fn GetClientRect(hwnd: Raw, rect: *mut Rect) -> i32;
    fn SetTimer(
        hwnd: Raw,
        id: usize,
        millis: u32,
        callback: Option<TimerProc>,
    ) -> usize;
    fn KillTimer(hwnd: Raw, id: usize) -> i32;
}
#[link(name = "ole32")]
unsafe extern "system" {
    fn CoTaskMemFree(value: Raw);
}
#[link(name = "shlwapi")]
unsafe extern "system" {
    fn SHCreateMemStream(bytes: *const u8, length: u32) -> Raw;
}
#[link(name = "shell32")]
unsafe extern "system" {
    fn ShellExecuteW(
        hwnd: Raw,
        op: *const u16,
        file: *const u16,
        args: *const u16,
        cwd: *const u16,
        show: i32,
    ) -> Raw;
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn ok(hr: Hr) -> Result<()> {
    if hr >= 0 {
        Ok(())
    } else {
        Err("browser_webview2_call_failed".into())
    }
}
struct Com(Raw);
impl Com {
    unsafe fn retain(raw: Raw) -> Option<Self> {
        if raw.is_null() {
            return None;
        }
        let c = Self(raw);
        let f: unsafe extern "system" fn(Raw) -> u32 = unsafe { c.method(1) };
        unsafe { f(raw) };
        Some(c)
    }
    unsafe fn method<T: Copy>(&self, index: usize) -> T {
        let table = unsafe { *(self.0 as *const *const Raw) };
        unsafe { std::mem::transmute_copy(&*table.add(index)) }
    }
    fn query(&self, iid: Guid) -> Result<Self> {
        let mut out = ptr::null_mut();
        let f: unsafe extern "system" fn(Raw, *const Guid, *mut Raw) -> Hr =
            unsafe { self.method(0) };
        ok(unsafe { f(self.0, &iid, &mut out) })?;
        if out.is_null() {
            Err("browser_webview2_interface_unavailable".into())
        } else {
            Ok(Self(out))
        }
    }
    fn object(&self, index: usize) -> Result<Self> {
        let mut out = ptr::null_mut();
        let f: unsafe extern "system" fn(Raw, *mut Raw) -> Hr = unsafe { self.method(index) };
        ok(unsafe { f(self.0, &mut out) })?;
        if out.is_null() {
            Err("browser_webview2_object_unavailable".into())
        } else {
            Ok(Self(out))
        }
    }
    fn string(&self, index: usize) -> Result<String> {
        let mut out = ptr::null_mut::<u16>();
        let f: unsafe extern "system" fn(Raw, *mut *mut u16) -> Hr = unsafe { self.method(index) };
        ok(unsafe { f(self.0, &mut out) })?;
        if out.is_null() {
            return Err("browser_webview2_string_unavailable".into());
        }
        let mut len = 0;
        unsafe {
            while len < 32768 && *out.add(len) != 0 {
                len += 1
            }
        };
        let value = if len == 32768 {
            Err("browser_webview2_string_limit".into())
        } else {
            Ok(String::from_utf16_lossy(unsafe {
                std::slice::from_raw_parts(out, len)
            }))
        };
        unsafe { CoTaskMemFree(out.cast()) };
        value
    }
    fn set_bool(&self, index: usize, value: bool) -> Result<()> {
        let f: unsafe extern "system" fn(Raw, i32) -> Hr = unsafe { self.method(index) };
        ok(unsafe { f(self.0, value as i32) })
    }
    fn boolean(&self, index: usize) -> bool {
        let mut value = 0;
        let f: unsafe extern "system" fn(Raw, *mut i32) -> Hr = unsafe { self.method(index) };
        unsafe { f(self.0, &mut value) };
        value != 0
    }
    fn call(&self, index: usize) -> Result<()> {
        let f: unsafe extern "system" fn(Raw) -> Hr = unsafe { self.method(index) };
        ok(unsafe { f(self.0) })
    }
    fn text(&self, index: usize, value: &str) -> Result<()> {
        let value = wide(value);
        let f: unsafe extern "system" fn(Raw, *const u16) -> Hr = unsafe { self.method(index) };
        ok(unsafe { f(self.0, value.as_ptr()) })
    }
    fn event(&self, index: usize, handler: &Com) -> Result<()> {
        let mut token = 0i64;
        let f: unsafe extern "system" fn(Raw, Raw, *mut i64) -> Hr = unsafe { self.method(index) };
        ok(unsafe { f(self.0, handler.0, &mut token) })
    }
}
impl Clone for Com {
    fn clone(&self) -> Self {
        unsafe { Self::retain(self.0).expect("owned COM object") }
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
        let h = &*(this as *mut Handler);
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
        (*(this as *mut Handler))
            .refs
            .fetch_add(1, Ordering::Relaxed)
            + 1
    }
}
unsafe extern "system" fn release(this: Raw) -> u32 {
    let count = unsafe {
        (*(this as *mut Handler))
            .refs
            .fetch_sub(1, Ordering::AcqRel)
            - 1
    };
    if count == 0 {
        unsafe { drop(Box::from_raw(this as *mut Handler)) }
    }
    count
}
unsafe extern "system" fn invoke_event(this: Raw, sender: Raw, args: Raw) -> Hr {
    unsafe { ((*(this as *mut Handler)).callback)(sender, args) };
    0
}
unsafe extern "system" fn invoke_completed(this: Raw, status: Hr, value: Raw) -> Hr {
    unsafe { ((*(this as *mut Handler)).callback)(status as isize as Raw, value) };
    0
}
// The vtable storage is immutable and contains only system-ABI function pointers.
struct Table([Raw; 4]);
unsafe impl Sync for Table {}
static EVENTS: Table = Table([
    query as Raw,
    add_ref as Raw,
    release as Raw,
    invoke_event as Raw,
]);
static COMPLETED: Table = Table([
    query as Raw,
    add_ref as Raw,
    release as Raw,
    invoke_completed as Raw,
]);
fn handler(iid: Guid, completed: bool, callback: impl Fn(Raw, Raw) + 'static) -> Com {
    Com(Box::into_raw(Box::new(Handler {
        table: if completed {
            COMPLETED.0.as_ptr()
        } else {
            EVENTS.0.as_ptr()
        },
        refs: AtomicU32::new(1),
        iid,
        callback: Box::new(callback),
    }))
    .cast())
}

thread_local! { static VIEWS:RefCell<HashMap<usize,Weak<RefCell<State>>>>=RefCell::new(HashMap::new()); }
unsafe extern "system" fn timer(hwnd: Raw, _: u32, _: usize, _: u32) {
    VIEWS.with(|views| {
        let weak = views.borrow().get(&(hwnd as usize)).cloned();
        if let Some(state) = weak.and_then(|w| w.upgrade()) {
            tick(&state);
        }
    });
}
/// Windows run_app accepts AppOptions.components. Register there BEFORE run_app;
/// each child HWND has its own UI-thread timer, so no hidden AppView is required.
pub fn register(components: &platform::Components, port: Port) {
    components.register(
        COMPONENT,
        Rc::new(move |context| {
            let hwnd = unsafe {
                CreateWindowExW(
                    0,
                    wide("STATIC").as_ptr(),
                    wide("").as_ptr(),
                    0x80000000,
                    0,
                    0,
                    1,
                    1,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            };
            let state = Rc::new(RefCell::new(State {
                hwnd,
                context,
                port: port.clone(),
                binding: None,
                capture: None,
                preparing: None,
                document: None,
                history: Vec::new(),
                env: None,
                controller: None,
                web: None,
                pending: Vec::new(),
                active: false,
                closed: false,
                started: false,
                bytes: 0,
                requests: 0,
                phase: "idle",
                display: String::new(),
                error: None,
                command: None,
                navigation_id: 0,
                presentation: None,
            }));
            VIEWS.with(|v| {
                v.borrow_mut().insert(hwnd as usize, Rc::downgrade(&state));
            });
            if hwnd.is_null() || unsafe { SetTimer(hwnd, 1, 16, Some(timer)) } == 0 {
                state.borrow_mut().fail("browser_win32_owner_unavailable");
            }
            Box::new(Component {
                state,
                hwnd: HWND(hwnd),
            }) as Box<dyn platform::NativeComponent>
        }),
    );
}
struct Component {
    state: Rc<RefCell<State>>,
    hwnd: HWND,
}
impl platform::NativeComponent for Component {
    fn window(&self) -> Option<HWND> {
        if self.hwnd.0.is_null() {
            None
        } else {
            Some(self.hwnd)
        }
    }
    fn set_prop(&mut self, name: &str, value: Option<&Value>) {
        if name == "binding" {
            let result = self.state.borrow_mut().bind(value.unwrap_or(&Value::Null));
            if let Err(e) = result {
                self.state.borrow_mut().fail(&e);
            }
        }
    }
    fn command(&mut self, name: &str, args: &Value) {
        let mut s = self.state.borrow_mut();
        if s.matches(args) {
            if name == "close" {
                s.retire();
            } else if s.active {
                if name == "stop" {
                    s.cancel_reads();
                }
                if name == "reload" {
                    s.bytes = 0;
                    s.requests = 0;
                    if let Some(doc) = &s.document
                        && doc.route(&doc.entry).is_err()
                    {
                        let intent = doc.refresh_intent(&s.display);
                        s.archive_document();
                        if let Err(error) = intent.and_then(|intent| s.begin(intent)) {
                            s.fail(&error);
                        }
                        return;
                    }
                }
                s.command = Some(name.into());
            }
        }
    }
}
impl Drop for Component {
    fn drop(&mut self) {
        self.state.borrow_mut().retire();
        let controller = self.state.borrow_mut().controller.take();
        if let Some(c) = controller {
            let _ = c.call(24);
        }
        unsafe {
            KillTimer(self.hwnd.0, 1);
            DestroyWindow(self.hwnd.0);
        };
        VIEWS.with(|v| {
            v.borrow_mut().remove(&(self.hwnd.0 as usize));
        });
    }
}
struct Pending {
    args: Com,
    deferral: Com,
    read: Read,
    document: bool,
}
struct State {
    hwnd: Raw,
    context: platform::ComponentContext,
    port: Port,
    binding: Option<Value>,
    capture: Option<Capture>,
    preparing: Option<Preparing>,
    document: Option<Document>,
    history: Vec<Document>,
    env: Option<Com>,
    controller: Option<Com>,
    web: Option<Com>,
    pending: Vec<Pending>,
    active: bool,
    closed: bool,
    started: bool,
    bytes: usize,
    requests: usize,
    phase: &'static str,
    display: String,
    error: Option<String>,
    command: Option<String>,
    navigation_id: u64,
    presentation: Option<(Rect, bool)>,
}
impl State {
    fn matches(&self, args: &Value) -> bool {
        !self.closed
            && self.binding.as_ref().is_some_and(|b| {
                b["owner"] == args["owner"]
                    && b["generation"] == args["generation"]
                    && b["expectedHost"] == args["expectedHost"]
            })
    }
    fn bind(&mut self, value: &Value) -> Result<()> {
        policy::keys(
            value,
            &["owner", "expectedHost", "generation", "active", "intent"],
            &["owner", "expectedHost", "generation", "active", "intent"],
        )?;
        if self.closed {
            return Err("browser_owner_closed".into());
        }
        let owner = policy::string(value, "owner")?;
        let scope = policy::scope(&value["expectedHost"])?;
        let generation = value["generation"]
            .as_u64()
            .filter(|v| *v > 0)
            .ok_or("browser_invalid_generation")?;
        if !owner_valid(owner) {
            return Err("browser_invalid_owner".into());
        }
        let active = value["active"].as_bool().ok_or("browser_invalid_active")?;
        let intent = Intent::parse(&value["intent"])?;
        if let Some(old) = &self.binding {
            if old["owner"] != owner
                || old["expectedHost"] != scope
                || generation < old["generation"].as_u64().unwrap_or(0)
                || generation == old["generation"].as_u64().unwrap_or(0)
                    && old["intent"] != value["intent"]
            {
                return Err("browser_owner_stale".into());
            }
        }
        if self.binding.is_none() {
            self.port.capture(&scope)?;
            self.port.claim(&scope, owner)?;
        }
        let changed = self
            .binding
            .as_ref()
            .is_none_or(|b| b["generation"] != value["generation"]);
        self.binding = Some(value.clone());
        self.active = active;
        if changed {
            self.cancel_reads();
            self.capture = Some(self.port.capture(&scope)?);
            self.archive_document();
            self.navigation_id = 0;
            self.display = match &intent {
                Intent::Html { path, .. } => path.clone(),
                Intent::Loopback(url) | Intent::Browser(url) => url.clone(),
            };
            self.bytes = 0;
            self.requests = 0;
            self.error = None;
        }
        if active && (changed || self.phase == "suspended") {
            let resume = if changed {
                intent
            } else {
                self.document
                    .as_ref()
                    .and_then(|d| d.refresh_intent(&self.display).ok())
                    .or_else(|| Intent::parse(&json!({"kind":"browser","url":self.display})).ok())
                    .unwrap_or(intent)
            };
            self.archive_document();
            self.begin(resume)?
        } else if !active {
            self.cancel_reads();
            self.command = Some("stop".into());
            self.phase = "suspended";
        }
        self.emit();
        Ok(())
    }
    fn begin(&mut self, intent: Intent) -> Result<()> {
        self.navigation_id = 0;
        let b = self.binding.as_ref().ok_or("browser_owner_missing")?;
        let capture = self
            .capture
            .as_ref()
            .filter(|c| c.current())
            .ok_or("browser_host_scope_stale")?
            .clone();
        match Preparing::begin(capture, b["owner"].as_str().unwrap_or("").into(), intent)? {
            Ok(p) => {
                self.preparing = Some(p);
                self.phase = "preparing";
            }
            Err(Prepared::External(url)) => {
                self.display = url;
                self.phase = "preparing";
                self.command = Some("navigate".into());
            }
            _ => unreachable!(),
        };
        Ok(())
    }
    fn archive_document(&mut self) {
        if let Some(doc) = self.document.take() {
            self.history.push(doc);
        }
    }
    fn document_for(&self, url: &str) -> Option<Document> {
        self.document
            .iter()
            .chain(self.history.iter().rev())
            .find(|d| d.route(url).is_ok())
            .cloned()
    }
    fn cancel_reads(&mut self) {
        self.preparing = None;
        let pending = std::mem::take(&mut self.pending);
        for p in pending {
            let _ = p.deferral.call(3);
        }
    }
    fn retire(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        self.active = false;
        if let Some(c) = &self.capture {
            c.close();
        }
        self.cancel_reads();
        self.document = None;
        self.history.clear();
        self.phase = "closed";
        self.command = Some("retire".into());
        self.emit();
    }
    fn fail(&mut self, error: &str) {
        if self.closed {
            return;
        }
        self.error = Some(public_error(error).into());
        self.phase = "failed";
        self.emit();
    }
    fn emit(&self) {
        if let Some(b) = &self.binding {
            self.context.emit("browser",json!({"owner":b["owner"],"expectedHost":b["expectedHost"],"generation":b["generation"],"phase":self.phase,"url":self.display,"canBack":self.web.as_ref().is_some_and(|w|w.boolean(38)),"canForward":self.web.as_ref().is_some_and(|w|w.boolean(39)),"error":self.error}));
        }
    }
    fn virtual_url(&self, value: &str) -> String {
        let owner = self
            .binding
            .as_ref()
            .and_then(|b| b["owner"].as_str())
            .unwrap_or("");
        value.replacen(
            &format!("yuri-resource://{owner}"),
            &format!("https://{owner}.yuri-preview.invalid"),
            1,
        )
    }
    fn resource_url(&self, value: &str) -> String {
        let owner = self
            .binding
            .as_ref()
            .and_then(|b| b["owner"].as_str())
            .unwrap_or("");
        value.replacen(
            &format!("https://{owner}.yuri-preview.invalid"),
            &format!("yuri-resource://{owner}"),
            1,
        )
    }
}
fn start_environment(state: &Rc<RefCell<State>>) -> Result<()> {
    let weak = Rc::downgrade(state);
    let completed = handler(
        guid(0x4e8a3389_c9d8_4bd2_b6b5_124fee6cc14d),
        true,
        move |status, env| {
            let Some(state) = weak.upgrade() else { return };
            if state.borrow().closed {
                return;
            }
            let result: Result<()> = (|| {
                ok(status as isize as i32)?;
                let env =
                    unsafe { Com::retain(env) }.ok_or("browser_webview2_runtime_unavailable")?;
                let env10 = env.query(guid(0xee0eb9df_6f12_46ce_b53f_3f47b9c928e0))?;
                let options = env10.object(20)?;
                options.set_bool(6, true)?;
                let owner = state
                    .borrow()
                    .binding
                    .as_ref()
                    .and_then(|b| b["owner"].as_str())
                    .unwrap_or("")
                    .to_owned();
                options.text(4, &owner)?;
                state.borrow_mut().env = Some(env);
                let weak = Rc::downgrade(&state);
                let completed = handler(
                    guid(0x6c4819f3_c9b7_4260_8127_c9f5bde7f68c),
                    true,
                    move |status, controller| {
                        if let Some(state) = weak.upgrade() {
                            if state.borrow().closed {
                                return;
                            }
                            let result: Result<()> = (|| {
                                ok(status as isize as i32)?;
                                let controller = unsafe { Com::retain(controller) }
                                    .ok_or("browser_webview2_controller_unavailable")?;
                                let web = controller.object(25)?;
                                let settings = web.object(3)?;
                                for index in [6, 8, 10, 12, 14, 16, 20] {
                                    settings.set_bool(index, false)?;
                                }
                                install_events(&state, &web)?;
                                let mut s = state.borrow_mut();
                                s.controller = Some(controller);
                                s.web = Some(web);
                                Ok(())
                            })();
                            if let Err(e) = result {
                                state.borrow_mut().fail(&e)
                            }
                        }
                    },
                );
                let hwnd = state.borrow().hwnd;
                let f: unsafe extern "system" fn(Raw, Raw, Raw, Raw) -> Hr =
                    unsafe { env10.method(21) };
                ok(unsafe { f(env10.0, hwnd, options.0, completed.0) })
            })();
            if let Err(e) = result {
                state.borrow_mut().fail(&e)
            }
        },
    );
    // ControllerOptions InPrivate is mandatory: no owner cookie, password or app profile fallback.
    // The WebView2 runtime may keep its executable/cache under this isolated non-credential profile.
    let root = std::env::temp_dir().join("yuri-nsh-browser-runtime");
    let profile = wide(&root.to_string_lossy());
    ok(unsafe {
        CreateCoreWebView2EnvironmentWithOptions(
            ptr::null(),
            profile.as_ptr(),
            ptr::null_mut(),
            completed.0,
        )
    })
}
fn install_events(state: &Rc<RefCell<State>>, web: &Com) -> Result<()> {
    for (slot, iid) in [
        (11, guid(0x3c067f9f_5388_4772_8b48_79f7ef1ab37c)),
        (13, guid(0xc79a420c_efd9_4058_9295_3e8b4bcab645)),
    ] {
        let weak = Rc::downgrade(state);
        web.event(
            slot,
            &handler(iid, false, move |_, _| {
                let Some(state) = weak.upgrade() else {
                    return;
                };
                let web = state.borrow().web.clone();
                let Some(web) = web else {
                    return;
                };
                let Ok(url) = web.string(4) else {
                    return;
                };
                let mut s = state.borrow_mut();
                if !s.active || s.closed || !s.capture.as_ref().is_some_and(Capture::current) {
                    return;
                }
                let resource = s.resource_url(&url);
                if let Some(doc) = s.document_for(&resource) {
                    if let Ok(display) = doc.display_url(&resource) {
                        s.display = display;
                    }
                } else if !resource.starts_with("yuri-resource://")
                    && web_url(&url).is_ok_and(|(_, local)| !local)
                {
                    s.display = url;
                }
                s.emit();
            }),
        )?;
    }
    let weak = Rc::downgrade(state);
    web.event(
        25,
        &handler(
            guid(0x79e0aea4_990b_42d9_aa1d_0fcc2e5bc7f1),
            false,
            move |_, _| {
                if let Some(state) = weak.upgrade() {
                    state
                        .borrow_mut()
                        .fail("browser_content_process_terminated");
                }
            },
        ),
    )?;
    let weak = Rc::downgrade(state);
    web.event(
        7,
        &handler(
            guid(0x9adbe429_f36d_432b_9ddc_f8881fbd76e3),
            false,
            move |_, args| {
                let Some(state) = weak.upgrade() else { return };
                let Some(args) = (unsafe { Com::retain(args) }) else {
                    return;
                };
                let Ok(url) = args.string(3) else {
                    let _ = args.set_bool(8, true);
                    return;
                };
                let mut s = state.borrow_mut();
                let current =
                    s.active && !s.closed && s.capture.as_ref().is_some_and(Capture::current);
                let resource = s.resource_url(&url);
                let document = s.document_for(&resource);
                let custom = resource.starts_with("yuri-resource://");
                let allowed = current
                    && (document.is_some()
                        || !custom && web_url(&url).is_ok_and(|(_, local)| !local));
                let _ = args.set_bool(8, !allowed);
                if allowed {
                    let f: unsafe extern "system" fn(Raw, *mut u64) -> Hr =
                        unsafe { args.method(9) };
                    unsafe { f(args.0, &mut s.navigation_id) };
                    s.display = document
                        .as_ref()
                        .and_then(|d| d.display_url(&resource).ok())
                        .unwrap_or(url);
                    if let Some(doc) = document {
                        if s.document.as_ref().is_none_or(|d| d.entry != doc.entry) {
                            s.archive_document();
                            s.document = Some(doc);
                        }
                    } else {
                        s.archive_document();
                    }
                    s.phase = "loading";
                    s.emit();
                } else if current {
                    if let Ok(intent) = Intent::parse(&json!({"kind":"browser","url":url})) {
                        s.cancel_reads();
                        s.archive_document();
                        if let Err(e) = s.begin(intent) {
                            s.fail(&e);
                        }
                    }
                }
            },
        ),
    )?;
    let weak = Rc::downgrade(state);
    web.event(
        15,
        &handler(
            guid(0xd33a35bf_1c49_4f98_93ab_006e0533fe1c),
            false,
            move |_, args| {
                let Some(state) = weak.upgrade() else { return };
                let Some(args) = (unsafe { Com::retain(args) }) else {
                    return;
                };
                let mut id = 0;
                let f: unsafe extern "system" fn(Raw, *mut u64) -> Hr = unsafe { args.method(5) };
                unsafe { f(args.0, &mut id) };
                let mut s = state.borrow_mut();
                if s.active && !s.closed && id == s.navigation_id {
                    if args.boolean(3) {
                        s.phase = "ready";
                        s.error = None;
                        s.emit();
                    } else {
                        s.fail("browser_navigation_failed");
                    }
                }
            },
        ),
    )?;
    let weak = Rc::downgrade(state);
    web.event(
        44,
        &handler(
            guid(0xd4c185fe_c81c_4989_97af_2d3fa7ab5651),
            false,
            move |_, args| {
                let Some(args) = (unsafe { Com::retain(args) }) else {
                    return;
                };
                let _ = args.set_bool(6, true);
                if let Some(state) = weak.upgrade() {
                    let mut s = state.borrow_mut();
                    if s.active && !s.closed {
                        if let Ok(url) = args.string(3) {
                            if let Ok(intent) = Intent::parse(&json!({"kind":"browser","url":url}))
                            {
                                s.cancel_reads();
                                s.archive_document();
                                if let Err(e) = s.begin(intent) {
                                    s.fail(&e);
                                }
                            }
                        }
                    }
                }
            },
        ),
    )?;
    web.event(
        23,
        &handler(
            guid(0x15e1c6a3_c72a_4df3_91d7_d097fbec6bfd),
            false,
            move |_, args| {
                if let Some(args) = unsafe { Com::retain(args) } {
                    let f: unsafe extern "system" fn(Raw, i32) -> Hr = unsafe { args.method(7) };
                    unsafe { f(args.0, 2) };
                }
            },
        ),
    )?;
    let weak = Rc::downgrade(state);
    web.event(
        55,
        &handler(
            guid(0xab00b74c_15f1_4646_80e8_e76341d25d71),
            false,
            move |_, args| {
                let Some(state) = weak.upgrade() else { return };
                let Some(args) = (unsafe { Com::retain(args) }) else {
                    return;
                };
                let result: Result<()> = (|| {
                    let request = args.object(3)?;
                    let url = request.string(3)?;
                    let method = request.string(5)?;
                    let mut s = state.borrow_mut();
                    if !s.active || s.closed || !s.capture.as_ref().is_some_and(Capture::current) {
                        return Err("browser_host_scope_stale".into());
                    }
                    let resource = s.resource_url(&url);
                    let Some(doc) = s.document_for(&resource) else {
                        if !resource.starts_with("yuri-resource://")
                            && web_url(&url).is_ok_and(|(_, local)| !local)
                        {
                            return Ok(());
                        }
                        return Err("browser_client_loopback_blocked".into());
                    };
                    if method != "GET"
                        || s.pending.len() >= 8
                        || s.requests >= 256
                        || s.bytes >= TOTAL
                    {
                        return Err("browser_resource_admission".into());
                    }
                    let read = doc.read(&resource, (TOTAL - s.bytes).min(LIMIT))?;
                    let deferral = args.object(6)?;
                    let mut context = 0;
                    let get_context: unsafe extern "system" fn(Raw, *mut i32) -> Hr =
                        unsafe { args.method(7) };
                    ok(unsafe { get_context(args.0, &mut context) })?;
                    s.requests += 1;
                    s.pending.push(Pending {
                        args: args.clone(),
                        deferral,
                        read,
                        document: context == 1,
                    });
                    Ok(())
                })();
                if result.is_err() {
                    let env = state.borrow().env.clone();
                    if let Some(env) = env {
                        let _ = respond(
                            &env,
                            &args,
                            403,
                            "text/plain",
                            b"Preview request denied",
                            None,
                        );
                    }
                }
            },
        ),
    )?;
    let filter = wide("*");
    let f: unsafe extern "system" fn(Raw, *const u16, i32) -> Hr = unsafe { web.method(57) };
    ok(unsafe { f(web.0, filter.as_ptr(), 0) })
}
fn respond(
    env: &Com,
    args: &Com,
    status: i32,
    mime: &str,
    data: &[u8],
    csp: Option<&str>,
) -> Result<()> {
    let stream = unsafe { SHCreateMemStream(data.as_ptr(), data.len() as u32) };
    if stream.is_null() {
        return Err("browser_response_stream_unavailable".into());
    }
    let stream = Com(stream);
    let headers = wide(&format!(
        "Content-Type: {mime}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: {CSP}{}\r\n",
        csp.map(|v| format!(", {v}")).unwrap_or_default()
    ));
    let reason = wide(if status == 200 { "OK" } else { "Denied" });
    let mut response = ptr::null_mut();
    let f: unsafe extern "system" fn(Raw, Raw, i32, *const u16, *const u16, *mut Raw) -> Hr =
        unsafe { env.method(4) };
    ok(unsafe {
        f(
            env.0,
            stream.0,
            status,
            reason.as_ptr(),
            headers.as_ptr(),
            &mut response,
        )
    })?;
    if response.is_null() {
        return Err("browser_response_unavailable".into());
    }
    let response = Com(response);
    let f: unsafe extern "system" fn(Raw, Raw) -> Hr = unsafe { args.method(5) };
    ok(unsafe { f(args.0, response.0) })
}
fn tick(state: &Rc<RefCell<State>>) {
    let mut s = state.borrow_mut();
    if s.capture.as_ref().is_some_and(|c| !c.current()) {
        s.retire();
    }
    if s.closed {
        let controller = s.controller.take();
        s.web = None;
        drop(s);
        if let Some(c) = controller {
            let _ = c.call(24);
        }
        return;
    }
    if !s.active && s.command.is_none() { return; }
    if !s.started && s.binding.is_some() {
        s.started = true;
        drop(s);
        if let Err(e) = start_environment(state) {
            state.borrow_mut().fail(&e)
        }
        return;
    }
    let Some(web) = s.web.clone() else { return };
    let controller = s.controller.clone();
    let env = s.env.clone();
    if let Some(result) = s.preparing.as_mut().and_then(Preparing::poll) {
        s.preparing = None;
        match result {
            Ok(Prepared::Resource(doc)) => {
                s.display = doc.display.clone();
                s.document = Some(*doc);
                s.command = Some("navigate".into());
            }
            Ok(_) => {}
            Err(e) => s.fail(&e),
        }
    }
    let mut index = 0;
    while index < s.pending.len() {
        let Some(result) = s.pending[index].read.poll() else {
            index += 1;
            continue;
        };
        let p = s.pending.remove(index);
        let response = match result {
            Ok(response)
                if response.data.len() <= TOTAL.saturating_sub(s.bytes)
                    && (!p.document
                        || response.mime.split(';').next().map(str::trim) == Some("text/html")) =>
            {
                s.bytes += response.data.len();
                Some(response)
            }
            _ => None,
        };
        drop(s);
        if let Some(env) = &env {
            let _ = match response {
                Some(r) => respond(
                    env,
                    &p.args,
                    r.status as i32,
                    &r.mime,
                    &r.data,
                    r.csp.as_deref(),
                ),
                None => respond(env, &p.args, 403, "text/plain", b"Preview failed", None),
            };
        }
        let _ = p.deferral.call(3);
        s = state.borrow_mut();
    }
    let command = s.command.take();
    let target = s
        .document
        .as_ref()
        .map(|d| s.virtual_url(&d.entry))
        .unwrap_or_else(|| s.display.clone());
    let active = s.active;
    let hwnd = s.hwnd;
    let previous_presentation = s.presentation;
    let mut rect = Rect::default();
    if controller.is_some() { unsafe { GetClientRect(hwnd, &mut rect); } s.presentation = Some((rect, active)); }
    if command.as_deref() == Some("navigate") {
        s.phase = "loading";
        s.emit();
    }
    if command.as_deref() == Some("stop") && active {
        s.phase = "cancelled";
        s.emit();
    }
    drop(s);
    if let Some(c) = controller {
        if previous_presentation.map(|p| p.0) != Some(rect) {
            let f: unsafe extern "system" fn(Raw, Rect) -> Hr = unsafe { c.method(6) };
            unsafe { f(c.0, rect); }
        }
        if previous_presentation.map(|p| p.1) != Some(active) { let _ = c.set_bool(4, active); }
    }
    match command.as_deref() {
        Some("navigate") if active => {
            let _ = web.text(5, &target);
        }
        Some("back") if active => {
            let _ = web.call(40);
        }
        Some("forward") if active => {
            let _ = web.call(41);
        }
        Some("reload") if active => {
            let _ = web.call(31);
        }
        Some("stop") => {
            let _ = web.call(43);
        }
        Some("external") if active => {
            let value = state.borrow().display.clone();
            if web_url(&value).is_ok_and(|(_, local)| !local) {
                unsafe {
                    ShellExecuteW(
                        hwnd,
                        wide("open").as_ptr(),
                        wide(&value).as_ptr(),
                        ptr::null(),
                        ptr::null(),
                        1,
                    )
                };
            }
        }
        _ => {}
    }
}
