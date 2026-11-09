//! Fixed offline terminal in an NSH-owned child HWND. WebView2 handles real
//! keyboard/IME/selection; the only page bridge is typed terminal JSON.
use super::{COMPONENT, Registration, Result, document};
#[path = "terminal_desktop_webview2.rs"]
mod abi;
#[path = "terminal_desktop_contract.rs"]
mod contract;
use abi::{Com, Hr, Raw, Rect, guid, handler, ok, wide};
use nsh_platform_windows::{self as platform, windows::Win32::Foundation::HWND};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::HashMap,
    ptr,
    rc::{Rc, Weak},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
static NEXT_PROFILE: AtomicU64 = AtomicU64::new(1);

#[cfg_attr(
    target_os = "windows",
    link(name = "WebView2LoaderStatic", kind = "static")
)]
unsafe extern "system" {
    fn CreateCoreWebView2EnvironmentWithOptions(
        browser: *const u16,
        profile: *const u16,
        options: Raw,
        handler: Raw,
    ) -> Hr;
}
#[cfg_attr(target_os = "windows", link(name = "shlwapi"))]
unsafe extern "system" {
    fn SHCreateMemStream(bytes: *const u8, length: u32) -> Raw;
}
#[cfg_attr(target_os = "windows", link(name = "user32"))]
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
    fn IsWindowVisible(hwnd: Raw) -> i32;
    fn SetTimer(
        hwnd: Raw,
        id: usize,
        millis: u32,
        callback: unsafe extern "system" fn(Raw, u32, usize, u32),
    ) -> usize;
    fn KillTimer(hwnd: Raw, id: usize) -> i32;
    fn GetParent(hwnd: Raw) -> Raw;
    fn GetFocus() -> Raw;
    fn IsChild(parent: Raw, child: Raw) -> i32;
    fn SetFocus(hwnd: Raw) -> Raw;
}
thread_local! {static VIEWS:RefCell<HashMap<usize,Weak<RefCell<State>>>>=RefCell::new(HashMap::new());}
unsafe extern "system" fn timer(hwnd: Raw, _: u32, _: usize, _: u32) {
    let weak = VIEWS.with(|views| views.borrow().get(&(hwnd as usize)).cloned());
    if let Some(state) = weak.and_then(|w| w.upgrade()) {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| tick(&state)));
        if result.is_err() {
            state.borrow_mut().fail("terminal_native_callback_failed");
        }
    }
}
pub fn register(components: &platform::Components) -> Result<Registration> {
    document::bootstrap()?;
    let registration = Registration::prepared();
    let shared = registration.clone();
    components.register(
        COMPONENT,
        Rc::new(move |context| {
            // NSH reparents/converts this hidden popup into its clipped child HWND.
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
                registration: shared.clone(),
                props: json!({}),
                authority: None,
                active: false,
                closed: false,
                failed: false,
                started: None,
                environment: None,
                controller: None,
                web: None,
                events: Vec::new(),
                document_admission: contract::OfflineDocument::default(),
                document_response: None,
                denied_response: None,
                loaded: false,
                ready: false,
                presentation: None,
                pending_config: false,
            }));
            VIEWS.with(|views| {
                views
                    .borrow_mut()
                    .insert(hwnd as usize, Rc::downgrade(&state));
            });
            if hwnd.is_null() || unsafe { SetTimer(hwnd, 1, 16, timer) } == 0 {
                state.borrow_mut().failed = true;
            }
            Box::new(Viewport {
                hwnd: HWND(hwnd),
                state,
            })
        }),
    );
    Ok(registration)
}
struct Viewport {
    hwnd: HWND,
    state: Rc<RefCell<State>>,
}
impl platform::NativeComponent for Viewport {
    fn window(&self) -> Option<HWND> {
        if self.hwnd.0.is_null() {
            None
        } else {
            Some(self.hwnd)
        }
    }
    fn set_prop(&mut self, name: &str, value: Option<&Value>) {
        if ![
            "owner",
            "expectedHost",
            "generation",
            "active",
            "inputLabel",
            "configuration",
        ]
        .contains(&name)
        {
            return;
        }
        let mut s = self.state.borrow_mut();
        if s.closed {
            return;
        }
        let value = value.cloned().unwrap_or(Value::Null);
        if ["owner", "expectedHost", "generation"].contains(&name)
            && s.authority.as_ref().is_some_and(|a| a[name] != value)
        {
            s.fail("terminal_owner_changed");
            return;
        }
        s.props[name] = value;
        if name == "active" {
            s.active = s.props["active"] == true;
            if !s.active {
                let _ = s.post("active", &json!(false));
                s.hide();
            }
        }
        if name == "configuration" {
            if let Err(error) = document::configuration(&s.props["configuration"]) {
                if !s.props["configuration"].is_null() {
                    s.fail(&error);
                }
                return;
            }
            s.pending_config = true;
        }
    }
    fn command(&mut self, name: &str, args: &Value) {
        let mut s = self.state.borrow_mut();
        if !s.current()
            || !s.ready
            || !s
                .authority
                .as_ref()
                .is_some_and(|a| contract::matches(a, args))
        {
            return;
        }
        if !contract::command(name, args) {
            s.fail("terminal_renderer_command_invalid");
            return;
        }
        let active = s.interactive();
        let result = match name {
            "focus" if active => {
                if let Some(c) = &s.controller {
                    let f: unsafe extern "system" fn(Raw, i32) -> Hr = unsafe { c.method(12) };
                    ok(unsafe { f(c.0, 0) }).and_then(|_| s.post("focus", &Value::Null))
                } else {
                    Ok(())
                }
            }
            "focus" => Ok(()),
            "render" => {
                let mut value = args.clone();
                value["live"] = json!(active && value["live"] == true);
                s.post("render", &value)
            }
            "layout" => s.post("layout", &Value::Null),
            "inputResult" => s.post("inputResult", args),
            "shortcuts" => s.post("shortcuts", &args["bindings"]),
            _ => Ok(()),
        };
        if let Err(error) = result {
            s.fail(&error);
        }
    }
}
impl Drop for Viewport {
    fn drop(&mut self) {
        let objects = {
            let mut s = self.state.borrow_mut();
            s.closed = true;
            s.active = false;
            s.ready = false;
            s.detach()
        };
        drop(objects);
        VIEWS.with(|views| {
            views.borrow_mut().remove(&(self.hwnd.0 as usize));
        });
        if !self.hwnd.0.is_null() {
            unsafe {
                KillTimer(self.hwnd.0, 1);
                DestroyWindow(self.hwnd.0);
            }
        }
    }
}
struct State {
    hwnd: Raw,
    context: platform::ComponentContext,
    registration: Registration,
    props: Value,
    authority: Option<Value>,
    active: bool,
    closed: bool,
    failed: bool,
    started: Option<Instant>,
    environment: Option<Com>,
    controller: Option<Com>,
    web: Option<Com>,
    events: Vec<(Com, usize, i64)>,
    document_admission: contract::OfflineDocument,
    document_response: Option<Com>,
    denied_response: Option<Com>,
    loaded: bool,
    ready: bool,
    presentation: Option<(Rect, bool)>,
    pending_config: bool,
}
impl State {
    fn current(&self) -> bool {
        !self.closed
            && !self.failed
            && self
                .authority
                .as_ref()
                .is_some_and(|a| self.registration.current(&a["expectedHost"]))
    }
    fn interactive(&self) -> bool {
        self.current() && self.active && unsafe { IsWindowVisible(self.hwnd) } != 0
    }
    fn emit(&self, mut event: Value) {
        if !self.current() {
            return;
        }
        if let Some(a) = &self.authority {
            for key in ["owner", "generation", "expectedHost"] {
                event[key] = a[key].clone();
            }
            self.context.emit("terminal", event);
        }
    }
    fn fail(&mut self, code: &str) {
        self.emit(json!({"type":"error","code":code}));
        self.failed = true;
        self.ready = false;
        self.active = false;
        self.hide();
    }
    fn hide(&self) {
        if let Some(c) = &self.controller {
            let _ = c.set_bool(4, false);
        }
        unsafe {
            let focused = GetFocus();
            if focused == self.hwnd || IsChild(self.hwnd, focused) != 0 {
                SetFocus(GetParent(self.hwnd));
            }
        }
    }
    fn post(&self, command: &str, value: &Value) -> Result<()> {
        if !self.current() || !self.ready {
            return Ok(());
        }
        if let Some(web) = &self.web {
            web.text(
                32,
                &json!({"bridge":self.authority,"command":command,"value":value}).to_string(),
            )
        } else {
            Ok(())
        }
    }
    fn detach(&mut self) -> NativeObjects {
        NativeObjects {
            events: std::mem::take(&mut self.events),
            controller: self.controller.take(),
            _owned: [
                self.web.take(),
                self.environment.take(),
                self.document_response.take(),
                self.denied_response.take(),
            ],
        }
    }
}
struct NativeObjects {
    events: Vec<(Com, usize, i64)>,
    controller: Option<Com>,
    _owned: [Option<Com>; 4],
}
struct PendingController(Option<Com>);
impl Drop for PendingController {
    fn drop(&mut self) {
        if let Some(controller) = self.0.take() {
            let _ = controller.call(24);
        }
    }
}
impl Drop for NativeObjects {
    fn drop(&mut self) {
        // COM can synchronously reenter callbacks. State is already retired and
        // unborrowed before removing event tokens or closing its controller.
        for (object, remove, token) in self.events.drain(..) {
            object.remove(remove, token);
        }
        if let Some(controller) = &self.controller {
            let _ = controller.call(24);
        }
    }
}
fn start(state: &Rc<RefCell<State>>) -> Result<()> {
    let weak = Rc::downgrade(state);
    let completed = handler(
        guid(0x4e8a3389_c9d8_4bd2_b6b5_124fee6cc14d),
        true,
        move |status, raw| {
            let Some(state) = weak.upgrade() else {
                return;
            };
            if !state.borrow().current() {
                return;
            }
            let result = (|| -> Result<()> {
                ok(status as isize as i32)?;
                let env = unsafe { Com::retain(raw) }
                    .ok_or("terminal_webview2_environment_unavailable")?;
                let env10 = env.query(guid(0xee0eb9df_6f12_46ce_b53f_3f47b9c928e0))?;
                let options = env10.object(20)?;
                options.set_bool(6, true)?;
                options.text(
                    4,
                    &format!(
                        "Terminal{}_{}",
                        std::process::id(),
                        NEXT_PROFILE.fetch_add(1, Ordering::Relaxed)
                    ),
                )?;
                let hwnd = state.borrow().hwnd;
                state.borrow_mut().environment = Some(env);
                let weak = Rc::downgrade(&state);
                let completed = handler(
                    guid(0x6c4819f3_c9b7_4260_8127_c9f5bde7f68c),
                    true,
                    move |status, raw| {
                        let mut controller = PendingController(unsafe { Com::retain(raw) });
                        let Some(state) = weak.upgrade() else {
                            return;
                        };
                        if !state.borrow().current() {
                            return;
                        }
                        if let Err(error) = ok(status as isize as i32) {
                            state.borrow_mut().fail(&error);
                            return;
                        }
                        let result = (|| -> Result<()> {
                            let c = controller
                                .0
                                .take()
                                .ok_or("terminal_webview2_controller_unavailable")?;
                            // Keep controller owned before any fallible step, so teardown
                            // closes it even if settings or an event registration fails.
                            state.borrow_mut().controller = Some(c.clone());
                            c.set_bool(4, false)?;
                            let web = c.object(25)?;
                            state.borrow_mut().web = Some(web.clone());
                            let settings = web.object(3)?;
                            settings.set_bool(4, true)?;
                            settings.set_bool(6, true)?;
                            for slot in [8, 10, 12, 14, 16, 18, 20] {
                                settings.set_bool(slot, false)?;
                            }
                            install_events(&state, &web)?;
                            Ok(())
                        })();
                        if let Err(e) = result {
                            state.borrow_mut().fail(&e);
                        }
                    },
                );
                let f: unsafe extern "system" fn(Raw, Raw, Raw, Raw) -> Hr =
                    unsafe { env10.method(21) };
                ok(unsafe { f(env10.0, hwnd, options.0, completed.0) })
            })();
            if let Err(e) = result {
                state.borrow_mut().fail(&e);
            }
        },
    );
    // InPrivate controller is mandatory, never fall back to the app/browser profile.
    let directory = std::env::temp_dir().join("yuri-nsh-terminal-runtime");
    let profile = wide(&directory.to_string_lossy());
    ok(unsafe {
        CreateCoreWebView2EnvironmentWithOptions(
            ptr::null(),
            profile.as_ptr(),
            ptr::null_mut(),
            completed.0,
        )
    })
}
fn add(
    state: &Rc<RefCell<State>>,
    object: &Com,
    slot: usize,
    iid: u128,
    callback: impl Fn(Raw, Raw) + 'static,
) -> Result<()> {
    let token = object.event(slot, &handler(guid(iid), false, callback))?;
    state
        .borrow_mut()
        .events
        .push((object.clone(), slot + 1, token));
    Ok(())
}
fn install_events(state: &Rc<RefCell<State>>, web: &Com) -> Result<()> {
    let weak = Rc::downgrade(state);
    add(
        state,
        web,
        7,
        0x9adbe429_f36d_432b_9ddc_f8881fbd76e3,
        move |_, raw| {
            let Some(args) = (unsafe { Com::retain(raw) }) else {
                return;
            };
            let allowed = weak.upgrade().is_some_and(|state| {
                let mut s = state.borrow_mut();
                let current = s.current();
                args.string(3, 256)
                    .is_ok_and(|uri| s.document_admission.navigation(&uri, current))
            });
            let _ = args.set_bool(8, !allowed);
        },
    )?;
    // Frames, popups, permissions and every network resource are refused even
    // if terminal output contains escape-sequence links or hostile text.
    add(
        state,
        web,
        17,
        0x9adbe429_f36d_432b_9ddc_f8881fbd76e3,
        move |_, raw| {
            if let Some(args) = unsafe { Com::retain(raw) } {
                let _ = args.set_bool(8, true);
            }
        },
    )?;
    add(
        state,
        web,
        44,
        0xd4c185fe_c81c_4989_97af_2d3fa7ab5651,
        move |_, raw| {
            if let Some(args) = unsafe { Com::retain(raw) } {
                let _ = args.set_bool(6, true);
            }
        },
    )?;
    add(
        state,
        web,
        23,
        0x15e1c6a3_c72a_4df3_91d7_d097fbec6bfd,
        move |_, raw| {
            if let Some(args) = unsafe { Com::retain(raw) } {
                let f: unsafe extern "system" fn(Raw, i32) -> Hr = unsafe { args.method(7) };
                unsafe { f(args.0, 2) };
            }
        },
    )?;
    let weak = Rc::downgrade(state);
    add(
        state,
        web,
        55,
        0xab00b74c_15f1_4646_80e8_e76341d25d71,
        move |_, raw| {
            let Some(state) = weak.upgrade() else {
                return;
            };
            let Some(args) = (unsafe { Com::retain(raw) }) else {
                return;
            };
            let denied = state.borrow().denied_response.clone();
            let set: unsafe extern "system" fn(Raw, Raw) -> Hr = unsafe { args.method(5) };
            let result = (|| -> Result<()> {
                // Install a preallocated denial first. Allocation/read failures
                // must never leave WebView2's default network request in place.
                let denied = denied.ok_or("terminal_resource_denial_missing")?;
                ok(unsafe { set(args.0, denied.0) })?;
                let request = args.object(3)?;
                let uri = request.string(3, 256)?;
                let method = request.string(5, 16)?;
                let mut context = 0;
                let get: unsafe extern "system" fn(Raw, *mut i32) -> Hr = unsafe { args.method(7) };
                ok(unsafe { get(args.0, &mut context) })?;
                let response = {
                    let mut s = state.borrow_mut();
                    let current = s.current();
                    if s.document_admission
                        .resource(&uri, &method, context, current)
                    {
                        s.document_response.take()
                    } else {
                        None
                    }
                };
                if let Some(response) = response {
                    ok(unsafe { set(args.0, response.0) })?;
                }
                Ok(())
            })();
            if let Err(error) = result {
                let web = state.borrow().web.clone();
                if let Some(web) = web {
                    let _ = web.call(43);
                }
                state.borrow_mut().fail(&error);
                let objects = state.borrow_mut().detach();
                drop(objects);
            }
        },
    )?;
    let f: unsafe extern "system" fn(Raw, *const u16, i32) -> Hr = unsafe { web.method(57) };
    ok(unsafe { f(web.0, wide("*").as_ptr(), 0) })?;
    let weak = Rc::downgrade(state);
    add(
        state,
        web,
        34,
        0x57213f19_00e6_49fa_8e07_898ea01ecbd2,
        move |_, raw| {
            let Some(state) = weak.upgrade() else {
                return;
            };
            let Some(args) = (unsafe { Com::retain(raw) }) else {
                return;
            };
            let mut s = state.borrow_mut();
            if !s.current() || !s.loaded {
                return;
            }
            if !args
                .string(3, 256)
                .is_ok_and(|u| u == contract::DOCUMENT_URL)
            {
                return;
            }
            let value = args
                .string(4, 524288)
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok());
            let Some(value) = value.filter(contract::event) else {
                s.fail("terminal_renderer_message_invalid");
                return;
            };
            if value["type"] == "ready" {
                if s.ready {
                    return;
                }
                s.ready = true;
                let _ = s.post("active", &json!(s.interactive()));
            }
            if value["type"] == "input" && !s.interactive() {
                let _ = s.post(
                    "inputResult",
                    &json!({"key":value["key"],"receipt":value["receipt"],"status":"suspended"}),
                );
                return;
            }
            s.emit(value);
        },
    )?;
    let weak = Rc::downgrade(state);
    add(
        state,
        web,
        25,
        0x79e0aea4_990b_42d9_aa1d_0fcc2e5bc7f1,
        move |_, _| {
            if let Some(s) = weak.upgrade() {
                s.borrow_mut().fail("terminal_renderer_process_terminated");
            }
        },
    )?;
    let weak = Rc::downgrade(state);
    add(
        state,
        web,
        15,
        0xd33a35bf_1c49_4f98_93ab_006e0533fe1c,
        move |_, raw| {
            let Some(state) = weak.upgrade() else {
                return;
            };
            if let Some(args) = unsafe { Com::retain(raw) } {
                let mut success = 0;
                let f: unsafe extern "system" fn(Raw, *mut i32) -> Hr = unsafe { args.method(3) };
                if ok(unsafe { f(args.0, &mut success) }).is_err() || success == 0 {
                    state.borrow_mut().fail("terminal_renderer_load_failed");
                }
            }
        },
    )?;
    Ok(())
}
fn tick(state: &Rc<RefCell<State>>) {
    let mut s = state.borrow_mut();
    if s.authority
        .as_ref()
        .is_some_and(|a| !s.registration.current(&a["expectedHost"]))
    {
        s.closed = true;
        s.hide();
    }
    if s.closed || s.failed {
        let objects = s.detach();
        drop(s);
        drop(objects);
        return;
    }
    if s.authority.is_none() {
        let Ok(authority) = contract::authority(&s.props) else {
            return;
        };
        if !s.registration.current(&authority["expectedHost"])
            || document::configuration(&s.props["configuration"]).is_err()
        {
            return;
        }
        s.authority = Some(authority);
    }
    if s.started.is_none() {
        s.started = Some(Instant::now());
        drop(s);
        if let Err(e) = start(state) {
            state.borrow_mut().fail(&e);
        }
        return;
    }
    if !s.ready
        && s.started
            .is_some_and(|start| start.elapsed() > Duration::from_secs(15))
    {
        s.fail("terminal_renderer_ready_timeout");
        return;
    }
    let Some(web) = s.web.clone() else {
        return;
    };
    let Some(c) = s.controller.clone() else {
        return;
    };
    if !s.loaded {
        let mut rect = Rect::default();
        if unsafe { GetClientRect(s.hwnd, &mut rect) } == 0 {
            s.fail("terminal_native_bounds_failed");
            return;
        }
        if rect.right <= rect.left || rect.bottom <= rect.top {
            return;
        }
        let mut configuration = s.props["configuration"].clone();
        configuration["bridge"] = s.authority.clone().unwrap_or(Value::Null);
        let env = s.environment.clone();
        drop(s);
        let result = (|| -> Result<()> {
            let env = env.ok_or("terminal_webview2_environment_unavailable")?;
            let html = document::render(&configuration)?;
            let response = memory_response(&env, 200, html.as_bytes())?;
            let denied = memory_response(&env, 403, b"")?;
            let bounds: unsafe extern "system" fn(Raw, Rect) -> Hr = unsafe { c.method(6) };
            ok(unsafe { bounds(c.0, rect) })?;
            {
                let mut s = state.borrow_mut();
                if !s.current() {
                    return Ok(());
                }
                s.document_response = Some(response);
                s.denied_response = Some(denied);
                s.document_admission.arm();
                s.loaded = true;
            }
            web.text(5, contract::DOCUMENT_URL)
        })();
        if let Err(error) = result {
            state.borrow_mut().fail(&error);
        }
        return;
    }
    let mut rect = Rect::default();
    if unsafe { GetClientRect(s.hwnd, &mut rect) } == 0 {
        s.fail("terminal_native_bounds_failed");
        return;
    }
    let active = s.interactive();
    let previous = s.presentation;
    s.presentation = Some((rect, active));
    let config = if s.ready && s.pending_config {
        s.pending_config = false;
        Some(s.props["configuration"].clone())
    } else {
        None
    };
    drop(s);
    let result = (|| -> Result<()> {
        if previous.map(|v| v.0) != Some(rect) {
            let f: unsafe extern "system" fn(Raw, Rect) -> Hr = unsafe { c.method(6) };
            ok(unsafe { f(c.0, rect) })?;
            state.borrow().post("layout", &Value::Null)?;
        }
        if previous.map(|v| v.1) != Some(active) {
            c.set_bool(4, active)?;
            state.borrow().post("active", &json!(active))?;
        }
        if let Some(config) = config {
            state.borrow().post("configure", &config)?;
        }
        Ok(())
    })();
    if let Err(e) = result {
        state.borrow_mut().fail(&e);
    }
}

fn memory_response(env: &Com, status: i32, body: &[u8]) -> Result<Com> {
    if body.len() > 8 * 1024 * 1024 {
        return Err("terminal_document_size_limit".into());
    }
    let raw = unsafe { SHCreateMemStream(body.as_ptr(), body.len() as u32) };
    if raw.is_null() {
        return Err("terminal_document_stream_unavailable".into());
    }
    let stream = Com(raw);
    let mut response = ptr::null_mut();
    let create: unsafe extern "system" fn(Raw, Raw, i32, *const u16, *const u16, *mut Raw) -> Hr =
        unsafe { env.method(4) };
    let headers = wide(&format!(
        "Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: {}\r\n",
        document::POLICY
    ));
    ok(unsafe {
        create(
            env.0,
            stream.0,
            status,
            wide(if status == 200 { "OK" } else { "Denied" }).as_ptr(),
            headers.as_ptr(),
            &mut response,
        )
    })?;
    if response.is_null() {
        Err("terminal_document_response_unavailable".into())
    } else {
        Ok(Com(response))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[repr(C)]
    struct FakeController {
        table: *const Raw,
        refs: AtomicU32,
        events: Rc<RefCell<Vec<&'static str>>>,
    }
    unsafe extern "system" fn retain(raw: Raw) -> u32 {
        unsafe {
            (*raw.cast::<FakeController>())
                .refs
                .fetch_add(1, Ordering::Relaxed)
                + 1
        }
    }
    unsafe extern "system" fn release(raw: Raw) -> u32 {
        let count = unsafe {
            (*raw.cast::<FakeController>())
                .refs
                .fetch_sub(1, Ordering::AcqRel)
                - 1
        };
        if count == 0 {
            unsafe {
                drop(Box::from_raw(raw.cast::<FakeController>()));
            }
        }
        count
    }
    unsafe extern "system" fn close(raw: Raw) -> Hr {
        unsafe {
            (*raw.cast::<FakeController>())
                .events
                .borrow_mut()
                .push("close");
        }
        0
    }
    unsafe extern "system" fn remove(raw: Raw, token: i64) -> Hr {
        assert_eq!(token, 7);
        unsafe {
            (*raw.cast::<FakeController>())
                .events
                .borrow_mut()
                .push("remove");
        }
        0
    }
    #[test]
    fn late_controller_completion_closes_and_teardown_removes_tokens_before_close() {
        // Only the raw COM ownership/cleanup protocol is exercised, no HWND,
        // Windows DLL, renderer pixels or NSH event loop is simulated here.
        let mut table = [ptr::null_mut(); 25];
        table[1] = retain as Raw;
        table[2] = release as Raw;
        table[5] = remove as Raw;
        table[24] = close as Raw;
        let events = Rc::new(RefCell::new(Vec::new()));
        let make = || {
            Com(Box::into_raw(Box::new(FakeController {
                table: table.as_ptr(),
                refs: AtomicU32::new(1),
                events: events.clone(),
            }))
            .cast())
        };
        let original = make();
        drop(PendingController(unsafe { Com::retain(original.0) }));
        assert_eq!(&*events.borrow(), &["close"]);
        events.borrow_mut().clear();
        let mut pending = PendingController(Some(make()));
        let objects = NativeObjects {
            controller: pending.0.take(),
            events: vec![(original.clone(), 5, 7)],
            _owned: [None, None, None, None],
        };
        drop(pending);
        assert!(
            events.borrow().is_empty(),
            "ownership transferred; no early/double Close"
        );
        drop(objects);
        assert_eq!(&*events.borrow(), &["remove", "close"]);
        drop(original);
    }
}
