//! Independent AppKit WKWebView leaf; no main WebView and no generic Host bridge.
//! Uses objc2/Foundation/AppKit already re-exported by NSH, plus system WebKit.
use super::{COMPONENT, Registration, Result, document};
use nsh_platform_macos::{
    self as platform, ComponentContext, NativeComponent, objc2,
    objc2_app_kit::NSView,
    objc2_foundation::{NSObject, NSObjectProtocol, NSRect, NSSize, NSString},
};
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::{Allocated, Retained},
    runtime::{AnyClass, AnyObject, Bool},
};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    ffi::{c_char, c_void},
    rc::Rc,
};

unsafe extern "C" {
    fn dlopen(path: *const c_char, mode: i32) -> *mut c_void;
}
fn webkit() -> Result<()> {
    // Keep the system framework loaded for the process lifetime (ObjC classes).
    if unsafe {
        dlopen(
            c"/System/Library/Frameworks/WebKit.framework/WebKit".as_ptr(),
            1,
        )
    }
    .is_null()
    {
        return Err("terminal_webkit_unavailable".into());
    }
    for name in [
        c"WKWebView",
        c"WKWebViewConfiguration",
        c"WKWebsiteDataStore",
    ] {
        if AnyClass::get(name).is_none() {
            return Err("terminal_webkit_unavailable".into());
        }
    }
    Ok(())
}
#[derive(Clone)]
struct Authority {
    owner: String,
    generation: u64,
    expected: Value,
}
struct Ivars {
    context: ComponentContext,
    registration: Registration,
    authority: RefCell<Option<Authority>>,
    loading: Cell<bool>,
    stopped: Cell<bool>,
    active: Cell<bool>,
    web: RefCell<Option<Retained<AnyObject>>>,
}
// Clang Blocks ABI: WebKit passes the policy callback synchronously. No block
// is copied/retained or invoked after the delegate method returns.
#[repr(C)]
struct PolicyBlock {
    isa: *const c_void,
    flags: i32,
    reserved: i32,
    invoke: unsafe extern "C" fn(*const PolicyBlock, isize),
    descriptor: *const c_void,
}
define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = Ivars]
    #[name = "YuriTerminalViewportDelegate"]
    struct Delegate;
    unsafe impl NSObjectProtocol for Delegate {}
    impl Delegate {
        #[unsafe(method(userContentController:didReceiveScriptMessage:))]
        fn message(&self, _: &AnyObject, message: &AnyObject) {
            if !self.current() { return; }
            let main: bool = unsafe { let frame: Retained<AnyObject> = msg_send![message, frameInfo]; let main: Bool = msg_send![&frame, isMainFrame]; main.as_bool() };
            if !main { return; }
            let body: Retained<AnyObject> = unsafe { msg_send![message, body] };
            let Some(text) = body.downcast_ref::<NSString>() else { return; };
            let text = text.to_string(); if text.len()>524_288 { self.emit(json!({"type":"error","code":"renderer_message_overflow"})); return; }
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                if !["ready","resize","ack","input","inputRejected","error","focus","composition","shortcut","openPreview"].contains(&value["type"].as_str().unwrap_or("")) { return; }
                if value["type"]=="openPreview" && (value["url"].as_str().is_none_or(|url|url.len()>8192||!(url.starts_with("https://")||url.starts_with("http://"))||url.chars().any(char::is_control)) || !matches!(value["mode"].as_str(),Some("preview"|"external"))) { return; }
                if value["type"]=="input" {
                    if value["data"].as_str().is_none_or(|s| s.len()>65_536) || value["receipt"].as_u64().is_none_or(|n| n==0 || n>9_007_199_254_740_991) { return; }
                    if !self.ivars().active.get() {
                        // A native message can arrive after the hide prop. Settle
                        // that exact receipt as rejected, retaining its text; do
                        // not leave a sent-but-unacknowledged queue item behind.
                        if let Some(web)=self.ivars().web.borrow().as_ref() {
                            let result=json!({"key":value["key"],"receipt":value["receipt"],"status":"suspended"});
                            let script=NSString::from_str(&format!("window.terminalDesktopInputResult({result});"));
                            unsafe {let _:()=msg_send![web,evaluateJavaScript:&*script,completionHandler:std::ptr::null::<AnyObject>()];}
                        }return;
                    }
                }
                self.emit(value);
            }
        }
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn navigation(&self, _: &AnyObject, action: &AnyObject, decide: *const c_void) {
            let allowed = self.current() && self.ivars().loading.get() && unsafe {
                let target: Option<Retained<AnyObject>> = msg_send![action, targetFrame];
                let main = target.is_some_and(|frame| { let value: Bool = msg_send![&frame, isMainFrame]; value.as_bool() });
                let request: Retained<AnyObject> = msg_send![action, request];
                let url: Option<Retained<AnyObject>> = msg_send![&request, URL];
                let text = url.map(|url| { let s: Retained<NSString> = msg_send![&url, absoluteString]; s.to_string() }).unwrap_or_default();
                main && (text.is_empty() || text=="about:blank")
            };
            if allowed { self.ivars().loading.set(false); }
            if !decide.is_null() { unsafe { let block = decide.cast::<PolicyBlock>(); ((*block).invoke)(block, isize::from(allowed)); } }
        }
        #[unsafe(method(webViewWebContentProcessDidTerminate:))]
        fn terminated(&self, _: &AnyObject) { self.emit(json!({"type":"error","code":"renderer_process_terminated"})); }
        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        fn failed(&self, _: &AnyObject, _: &AnyObject, _: &AnyObject) { self.emit(json!({"type":"error","code":"renderer_load_failed"})); }
    }
);
impl Delegate {
    fn current(&self) -> bool {
        !self.ivars().stopped.get()
            && self
                .ivars()
                .authority
                .borrow()
                .as_ref()
                .is_some_and(|a| self.ivars().registration.current(&a.expected))
    }
    fn emit(&self, mut value: Value) {
        if !self.current() {
            return;
        }
        if let Some(authority) = self.ivars().authority.borrow().as_ref() {
            value["owner"] = json!(authority.owner);
            value["generation"] = json!(authority.generation);
            value["expectedHost"] = authority.expected.clone();
            self.ivars().context.emit("terminal", value);
        }
    }
}
struct Viewport {
    web: Retained<AnyObject>,
    delegate: Retained<Delegate>,
    props: Value,
    loaded: bool,
}
impl Viewport {
    fn new(context: ComponentContext, registration: Registration, mtm: MainThreadMarker) -> Self {
        let allocated = Delegate::alloc(mtm).set_ivars(Ivars {
            context,
            registration,
            authority: RefCell::new(None),
            loading: Cell::new(true),
            stopped: Cell::new(false),
            active: Cell::new(false),
            web: RefCell::new(None),
        });
        let delegate: Retained<Delegate> = unsafe { msg_send![super(allocated), init] };
        let configuration: Retained<AnyObject> = unsafe {
            msg_send![
                AnyClass::get(c"WKWebViewConfiguration").expect("registered WebKit"),
                new
            ]
        };
        unsafe {
            let data: Retained<AnyObject> = msg_send![
                AnyClass::get(c"WKWebsiteDataStore").expect("registered WebKit"),
                nonPersistentDataStore
            ];
            let _: () = msg_send![&configuration, setWebsiteDataStore: &*data];
            let preferences: Retained<AnyObject> = msg_send![&configuration, preferences];
            let _: () = msg_send![&preferences, setJavaScriptCanOpenWindowsAutomatically: false];
            let controller: Retained<AnyObject> = msg_send![&configuration, userContentController];
            let _: () = msg_send![&controller, addScriptMessageHandler: &*delegate, name: &*NSString::from_str("terminal")];
        }
        let web: Retained<AnyObject> = unsafe {
            let allocated: Allocated<AnyObject> = msg_send![
                AnyClass::get(c"WKWebView").expect("registered WebKit"),
                alloc
            ];
            msg_send![allocated, initWithFrame: NSRect::ZERO, configuration: &*configuration]
        };
        unsafe {
            let _: () = msg_send![&web, setNavigationDelegate: &*delegate];
        }
        *delegate.ivars().web.borrow_mut() = Some(web.clone());
        Self {
            web,
            delegate,
            props: json!({}),
            loaded: false,
        }
    }
    fn evaluate(&self, function: &str, argument: &Value) {
        if !self.delegate.current() {
            return;
        }
        let call = if [
            "terminalDesktopResize",
            "terminalDesktopConfigure",
            "terminalDesktopActive",
        ]
        .contains(&function)
        {
            format!("if(typeof window.{function}==='function')window.{function}({argument});")
        } else {
            format!("window.{function}({argument});")
        };
        let source = NSString::from_str(&format!(
            "try{{{call}}}catch(error){{window.webkit.messageHandlers.terminal.postMessage(JSON.stringify({{type:'error',code:'renderer_command_failed_'+String(error.name)}}));}}"
        ));
        unsafe {
            let _: () = msg_send![&self.web, evaluateJavaScript: &*source, completionHandler: std::ptr::null::<AnyObject>()];
        }
    }
    fn load_if_ready(&mut self) {
        if self.loaded {
            return;
        }
        let value = &self.props;
        let Some(owner) = value["owner"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 128)
        else {
            return;
        };
        let Some(generation) = value["generation"].as_u64().filter(|n| *n > 0) else {
            return;
        };
        if !self
            .delegate
            .ivars()
            .registration
            .current(&value["expectedHost"])
            || value["configuration"].is_null()
        {
            return;
        }
        *self.delegate.ivars().authority.borrow_mut() = Some(Authority {
            owner: owner.into(),
            generation,
            expected: value["expectedHost"].clone(),
        });
        match document::render(&value["configuration"]) {
            Ok(html) => {
                self.loaded = true;
                unsafe {
                    let _: Option<Retained<AnyObject>> = msg_send![&self.web, loadHTMLString: &*NSString::from_str(&html), baseURL: std::ptr::null::<AnyObject>()];
                }
            }
            Err(_) => self
                .delegate
                .emit(json!({"type":"error","code":"renderer_configuration_invalid"})),
        }
    }
}
impl NativeComponent for Viewport {
    fn view(&self) -> Retained<NSView> {
        unsafe {
            Retained::retain((&*self.web as *const AnyObject).cast::<NSView>() as *mut NSView)
                .expect("WKWebView is NSView")
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
        self.props[name] = value.cloned().unwrap_or(Value::Null);
        if name == "active" {
            self.delegate
                .ivars()
                .active
                .set(value == Some(&Value::Bool(true)));
        }
        if self.loaded {
            if name == "active" {
                self.evaluate(
                    "terminalDesktopActive",
                    &Value::Bool(value == Some(&Value::Bool(true))),
                );
            }
            if name == "configuration"
                && document::configuration(&self.props["configuration"]).is_ok()
            {
                self.evaluate("terminalDesktopConfigure", &self.props["configuration"]);
            }
        } else {
            self.load_if_ready();
        }
    }
    fn command(&mut self, name: &str, args: &Value) {
        let authority = self.delegate.ivars().authority.borrow().clone();
        if !self.loaded
            || !self.delegate.current()
            || authority.as_ref().is_none_or(|a| {
                args["owner"] != a.owner
                    || args["generation"] != a.generation
                    || args["expectedHost"] != a.expected
            })
        {
            return;
        }
        match name {
            "shortcuts"
                if args["bindings"].as_array().is_some_and(|rows| {
                    rows.len() <= 256
                        && rows.iter().all(|row| {
                            row["actionId"].as_str().is_some_and(|s| s.len() <= 128)
                                && row["keystroke"].as_str().is_some_and(|s| s.len() <= 64)
                        })
                }) =>
            {
                self.evaluate("terminalDesktopShortcuts", &args["bindings"])
            }
            "focus" if self.delegate.ivars().active.get() => {
                let view = self.view();
                if let Some(window) = view.window() {
                    window.makeFirstResponder(Some(&view));
                }
                self.evaluate("terminalDesktopFocus", &Value::Null);
            }
            "focus" => {}
            "layout"
                if args["width"]
                    .as_f64()
                    .is_some_and(|v| v > 0.0 && v <= 32_768.0)
                    && args["height"]
                        .as_f64()
                        .is_some_and(|v| v > 0.0 && v <= 32_768.0) =>
            {
                self.view().setFrameSize(NSSize::new(
                    args["width"].as_f64().unwrap_or(0.0),
                    args["height"].as_f64().unwrap_or(0.0),
                ));
                self.evaluate("terminalDesktopResize", &Value::Null);
            }
            "render"
                if args["type"] == "render"
                    && args["key"].as_str().is_some_and(|s| s.len() <= 128)
                    && args["live"].is_boolean()
                    && args["chunks"].as_array().is_some_and(|chunks| {
                        chunks.len() <= 65_536
                            && chunks.iter().all(|chunk| {
                                chunk["id"]
                                    .as_u64()
                                    .is_some_and(|n| n <= 9_007_199_254_740_991)
                                    && chunk["data"].as_str().is_some_and(|s| s.len() <= 1_048_576)
                            })
                            && chunks
                                .iter()
                                .filter_map(|chunk| chunk["data"].as_str())
                                .map(str::len)
                                .sum::<usize>()
                                <= 2_097_152
                    }) =>
            {
                let mut value = args.clone();
                value["live"] = json!(args["live"] == true && self.delegate.ivars().active.get());
                self.evaluate("terminalRender", &value);
            }
            "inputResult"
                if [
                    "accepted",
                    "rejected",
                    "unknown",
                    "closed",
                    "retry",
                    "suspended",
                ]
                .contains(&args["status"].as_str().unwrap_or("")) =>
            {
                self.evaluate("terminalDesktopInputResult", args)
            }
            _ => self
                .delegate
                .emit(json!({"type":"error","code":"renderer_command_invalid"})),
        }
    }
}
impl Drop for Viewport {
    fn drop(&mut self) {
        self.delegate.ivars().stopped.set(true);
        unsafe {
            let _: () = msg_send![&self.web, stopLoading];
            let _: () = msg_send![&self.web, setNavigationDelegate: std::ptr::null::<AnyObject>()];
            let configuration: Retained<AnyObject> = msg_send![&self.web, configuration];
            let controller: Retained<AnyObject> = msg_send![&configuration, userContentController];
            let _: () = msg_send![&controller, removeScriptMessageHandlerForName: &*NSString::from_str("terminal")];
        }
        self.delegate.ivars().web.borrow_mut().take();
    }
}
pub fn register(components: &platform::Components) -> Result<Registration> {
    let mtm = MainThreadMarker::new().ok_or("terminal_main_thread_required")?;
    webkit()?;
    document::bootstrap()?;
    let registration = Registration::prepared();
    let factory = registration.clone();
    components.register(
        COMPONENT,
        Rc::new(move |context| Box::new(Viewport::new(context, factory.clone(), mtm))),
    );
    Ok(registration)
}
