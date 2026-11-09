//! WKWebView is a leaf NSView, never a window/root/NSH application renderer.
//! Only public AppKit/WebKit selectors are used; NSH does not reexport objc2-web-kit.
use super::*;
use foundation::{
    NSData, NSDictionary, NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString, NSURL,
    NSURLRequest,
};
use kit::NSView;
use nsh_platform_macos::{
    self as platform, objc2, objc2_app_kit as kit, objc2_foundation as foundation,
};
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::{Allocated, Retained},
    runtime::{AnyClass, AnyObject, Sel},
    sel,
};
use std::{
    cell::RefCell,
    collections::HashMap,
    ffi::c_void,
    rc::{Rc, Weak},
};

#[link(name = "WebKit", kind = "framework")]
unsafe extern "C" {}
// Objective-C blocks are a system ABI, not a dependency or arbitrary script bridge.
#[repr(C)]
struct BlockHeader {
    isa: *const c_void,
    flags: i32,
    reserved: i32,
    invoke: *const c_void,
    descriptor: *const c_void,
}
unsafe fn decide(block: *mut c_void, policy: isize) {
    let header = unsafe { &*(block as *const BlockHeader) };
    let call: unsafe extern "C" fn(*mut c_void, isize) =
        unsafe { std::mem::transmute(header.invoke) };
    unsafe {
        call(block, policy);
    }
}
// Only compileContentRuleList's completion uses a copied block. The capture is Rc on the UI thread.
#[repr(C)]
struct RulesBlock {
    header: BlockHeader,
    state: *const RefCell<State>,
}
#[repr(C)]
struct Descriptor {
    reserved: usize,
    size: usize,
    copy: unsafe extern "C" fn(*mut RulesBlock, *const RulesBlock),
    dispose: unsafe extern "C" fn(*mut RulesBlock),
    signature: *const u8,
}
unsafe impl Sync for Descriptor {}
unsafe extern "C" fn copy_block(dst: *mut RulesBlock, src: *const RulesBlock) {
    unsafe {
        (*dst).state = (*src).state;
        Rc::increment_strong_count((*src).state);
    }
}
unsafe extern "C" fn dispose_block(block: *mut RulesBlock) {
    unsafe {
        Rc::decrement_strong_count((*block).state);
    }
}
unsafe extern "C" fn rules_done(
    block: *mut RulesBlock,
    rules: *mut AnyObject,
    error: *mut AnyObject,
) {
    let state = unsafe { &*(*block).state };
    let mut s = state.borrow_mut();
    if !error.is_null() || rules.is_null() {
        s.fail("browser_network_rules_unavailable");
        return;
    }
    s.rules = unsafe { Retained::retain(rules) };
    s.rules_ready = true;
}
static RULES_DESCRIPTOR: Descriptor = Descriptor {
    reserved: 0,
    size: std::mem::size_of::<RulesBlock>(),
    copy: copy_block,
    dispose: dispose_block,
    signature: c"v@?@@".as_ptr().cast(),
};
unsafe extern "C" {
    static _NSConcreteStackBlock: c_void;
}
#[link(name = "objc")]
unsafe extern "C" {
    fn objc_msgSend();
}

#[derive(Default)]
struct Registry {
    surfaces: Vec<Weak<RefCell<State>>>,
}
/// Keep this on the main thread and call poll once each native event-loop turn.
pub struct Pump {
    registry: Rc<RefCell<Registry>>,
}
pub fn register(app: &platform::AppView, port: Port, mtm: MainThreadMarker) -> Pump {
    let registry = Rc::new(RefCell::new(Registry::default()));
    let factory_registry = registry.clone();
    app.register_component(
        COMPONENT,
        Rc::new(move |context| {
            let view = NSView::initWithFrame(
                NSView::alloc(mtm),
                NSRect::new(NSPoint::new(0., 0.), NSSize::new(1., 1.)),
            );
            let state = Rc::new(RefCell::new(State {
                view: view.clone(),
                context,
                port: port.clone(),
                binding: None,
                capture: None,
                preparing: None,
                document: None,
                history: Vec::new(),
                web: None,
                delegate: None,
                rules: None,
                rules_ready: false,
                compiling: false,
                pending: HashMap::new(),
                active: false,
                was_active: false,
                closed: false,
                bytes: 0,
                requests: 0,
                initial_document: false,
                navigation: 0,
                phase: "idle",
                error: None,
                display: String::new(),
            }));
            factory_registry
                .borrow_mut()
                .surfaces
                .push(Rc::downgrade(&state));
            Box::new(Component { state, view }) as Box<dyn platform::NativeComponent>
        }),
    );
    Pump { registry }
}
impl Pump {
    pub fn poll(&mut self) {
        let items = self.registry.borrow().surfaces.clone();
        for weak in items {
            if let Some(state) = weak.upgrade() {
                tick(&state);
            }
        }
        self.registry
            .borrow_mut()
            .surfaces
            .retain(|s| s.strong_count() > 0);
    }
}
struct Component {
    state: Rc<RefCell<State>>,
    view: Retained<NSView>,
}
impl platform::NativeComponent for Component {
    fn view(&self) -> Retained<NSView> {
        self.view.clone()
    }
    fn set_prop(&mut self, name: &str, value: Option<&Value>) {
        if name != "binding" {
            return;
        }
        let result = self.state.borrow_mut().bind(value.unwrap_or(&Value::Null));
        if let Err(e) = result {
            self.state.borrow_mut().fail(&e);
        }
    }
    fn command(&mut self, name: &str, args: &Value) {
        // Scheduling WebKit from inside a RefCell borrow can synchronously invoke delegates.
        // Commands are admitted here and performed by the UI pump outside all borrows.
        let mut s = self.state.borrow_mut();
        if s.matches(args) {
            s.pending_command(name);
        }
    }
}
impl Drop for Component {
    fn drop(&mut self) {
        self.state.borrow_mut().close();
        detach(&self.state);
    }
}
struct Pending {
    task: Retained<AnyObject>,
    read: Read,
}
struct State {
    view: Retained<NSView>,
    context: platform::ComponentContext,
    port: Port,
    binding: Option<Value>,
    capture: Option<Capture>,
    preparing: Option<Preparing>,
    document: Option<Document>,
    history: Vec<Document>,
    web: Option<Retained<AnyObject>>,
    delegate: Option<Retained<Delegate>>,
    rules: Option<Retained<AnyObject>>,
    rules_ready: bool,
    compiling: bool,
    pending: HashMap<usize, Pending>,
    active: bool,
    was_active: bool,
    closed: bool,
    bytes: usize,
    requests: usize,
    initial_document: bool,
    navigation: usize,
    phase: &'static str,
    error: Option<String>,
    display: String,
}
impl State {
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
        let active = value["active"].as_bool().ok_or("browser_invalid_active")?;
        let intent = Intent::parse(&value["intent"])?;
        if !owner_valid(owner) {
            return Err("browser_invalid_owner".into());
        }
        if let Some(old) = &self.binding {
            if old["owner"] != owner
                || old["expectedHost"] != scope
                || generation < old["generation"].as_u64().unwrap_or(0)
            {
                return Err("browser_owner_stale".into());
            }
            if generation == old["generation"].as_u64().unwrap_or(0)
                && old["intent"] != value["intent"]
            {
                return Err("browser_generation_reused".into());
            }
        } else {
            self.port.capture(&scope)?;
            self.port.claim(&scope, owner)?;
        }
        self.active = active;
        let changed = self
            .binding
            .as_ref()
            .is_none_or(|old| old["generation"] != value["generation"]);
        self.binding = Some(value.clone());
        if changed {
            self.stop_reads();
            self.capture = Some(self.port.capture(&scope)?);
            self.archive_document();
            self.bytes = 0;
            self.requests = 0;
            self.error = None;
            self.display = match &intent {
                Intent::Html { path, .. } => path.clone(),
                Intent::Loopback(url) | Intent::Browser(url) => url.clone(),
            };
            if active {
                self.begin(intent)?;
            } else {
                self.phase = "suspended";
            }
        } else if !active {
            self.stop_reads();
            self.phase = "suspended";
        } else if self.phase == "suspended" {
            let resume = self
                .document
                .as_ref()
                .and_then(|d| d.refresh_intent(&self.display).ok())
                .or_else(|| Intent::parse(&json!({"kind":"browser","url":self.display})).ok())
                .unwrap_or(intent);
            self.archive_document();
            self.begin(resume)?;
        }
        self.emit();
        Ok(())
    }
    fn begin(&mut self, intent: Intent) -> Result<()> {
        self.navigation = 0;
        let binding = self.binding.as_ref().ok_or("browser_owner_missing")?;
        let capture = self
            .capture
            .as_ref()
            .filter(|c| c.current())
            .ok_or("browser_host_scope_stale")?
            .clone();
        match Preparing::begin(
            capture,
            binding["owner"].as_str().unwrap_or("").into(),
            intent,
        )? {
            Ok(preparing) => {
                self.preparing = Some(preparing);
                self.phase = "preparing";
            }
            Err(Prepared::External(url)) => {
                self.display = url;
                self.phase = "navigate-external";
            }
            _ => unreachable!(),
        }
        Ok(())
    }
    fn matches(&self, args: &Value) -> bool {
        !self.closed
            && self.binding.as_ref().is_some_and(|b| {
                b["owner"] == args["owner"]
                    && b["expectedHost"] == args["expectedHost"]
                    && b["generation"] == args["generation"]
            })
    }
    fn pending_command(&mut self, name: &str) {
        if name == "close" {
            self.close();
            return;
        }
        if !self.active || !self.capture.as_ref().is_some_and(Capture::current) {
            return;
        }
        match name {
            "back" => self.phase = "command-back",
            "forward" => self.phase = "command-forward",
            "reload" => {
                self.bytes = 0;
                self.requests = 0;
                if let Some(doc) = &self.document
                    && doc.route(&doc.entry).is_err()
                {
                    let intent = doc.refresh_intent(&self.display);
                    self.archive_document();
                    match intent.and_then(|intent| self.begin(intent)) {
                        Ok(()) => {}
                        Err(e) => self.fail(&e),
                    }
                    return;
                }
                self.phase = "command-reload";
            }
            "stop" => {
                self.stop_reads();
                self.phase = "command-stop";
            }
            "external" => self.phase = "command-external",
            _ => {}
        }
    }
    fn stop_reads(&mut self) {
        self.preparing = None;
        self.pending.clear();
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
    fn close(&mut self) {
        if self.closed {
            return;
        }
        if let Some(c) = &self.capture {
            c.close();
        }
        self.stop_reads();
        self.closed = true;
        self.active = false;
        self.phase = "closed";
        self.emit();
        self.document = None;
        self.history.clear();
    }
    fn fail(&mut self, error: &str) {
        if self.closed {
            return;
        }
        self.stop_reads();
        self.error = Some(public_error(error).into());
        self.phase = "failed";
        self.emit();
    }
    fn emit(&self) {
        let Some(binding) = &self.binding else {
            return;
        };
        let (back, forward) = self
            .web
            .as_ref()
            .map(|web| unsafe {
                (
                    msg_send![&**web, canGoBack],
                    msg_send![&**web, canGoForward],
                )
            })
            .unwrap_or((false, false));
        self.context.emit("browser", json!({"owner":binding["owner"],"expectedHost":binding["expectedHost"],"generation":binding["generation"],"phase":self.phase,"url":self.display,"canBack":back,"canForward":forward,"error":self.error}));
    }
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "YuriNshBrowserDelegate"]
    #[ivars = Weak<RefCell<State>>]
    struct Delegate;
    unsafe impl NSObjectProtocol for Delegate {}
    impl Delegate {
        #[unsafe(method(webView:startURLSchemeTask:))]
        fn start(&self, _: &AnyObject, task: &AnyObject) {
            let Some(state) = self.ivars().upgrade() else { return; };
            let mut s = state.borrow_mut();
            let request: Retained<NSURLRequest> = unsafe { msg_send![task, request] };
            let url = request.URL().and_then(|v| v.absoluteString()).map(|v| v.to_string()).unwrap_or_default();
            let method: Retained<NSString> = unsafe { msg_send![&*request, HTTPMethod] };
            let result: Result<Read> = (|| {
                if !s.active || s.closed || method.to_string() != "GET" || s.pending.len() >= 8 || s.requests >= 256 || s.bytes >= TOTAL { return Err("browser_resource_admission".into()); }
                let read = s.document_for(&url).ok_or("browser_document_missing")?.read(&url, (TOTAL-s.bytes).min(LIMIT))?;
                Ok(read)
            })();
            match result {
                Ok(read) => { s.requests += 1; s.pending.insert(task as *const _ as usize, Pending { task: unsafe { Retained::retain(task as *const _ as *mut AnyObject).expect("live scheme task") }, read }); }
                Err(_) => { drop(s); fail_task(task); }
            }
        }
        #[unsafe(method(webView:stopURLSchemeTask:))]
        fn stop(&self, _: &AnyObject, task: &AnyObject) { if let Some(s) = self.ivars().upgrade() { s.borrow_mut().pending.remove(&(task as *const _ as usize)); } }
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn navigation(&self, _: &AnyObject, action: &AnyObject, decision: *mut c_void) {
            let Some(state) = self.ivars().upgrade() else { unsafe { decide(decision, 0); } return; };
            let request: Retained<NSURLRequest> = unsafe { msg_send![action, request] };
            let url = request.URL().and_then(|v| v.absoluteString()).map(|v| v.to_string()).unwrap_or_default();
            let frame: Option<Retained<AnyObject>> = unsafe { msg_send![action, targetFrame] };
            let main: bool = frame.as_ref().is_some_and(|f| unsafe { msg_send![&**f, isMainFrame] });
            let method: Retained<NSString> = unsafe { msg_send![&*request, HTTPMethod] };
            let mut s = state.borrow_mut();
            let current = !s.closed && s.active && s.capture.as_ref().is_some_and(Capture::current);
            let resource = s.document_for(&url);
            let allowed = current && main && method.to_string() == "GET" && (resource.is_some() || web_url(&url).is_ok_and(|(_, local)| !local));
            if allowed {
                s.display = resource.as_ref().and_then(|d| d.display_url(&url).ok()).unwrap_or(url);
                if let Some(doc) = resource { if s.document.as_ref().is_none_or(|d| d.entry != doc.entry) { s.archive_document(); s.document = Some(doc); } }
                else { s.archive_document(); }
                s.phase = "loading"; s.error = None; s.emit();
            } else if current && frame.is_none() && resource.is_some() && method.to_string() == "GET" {
                if let Some(mut doc) = resource {
                    s.display = doc.display_url(&url).unwrap_or_else(|_| s.display.clone());
                    doc.entry = url; s.archive_document(); s.document = Some(doc);
                    s.initial_document = true; s.phase = "navigate-resource";
                }
            } else if current && (main || frame.is_none()) && method.to_string() == "GET" {
                // Page links never open an uncontrolled new NSWindow. Redirected or clicked localhost
                // becomes a Host preview intent, and a normal link stays in this same native tab.
                if let Ok(intent) = Intent::parse(&json!({"kind":"browser","url":url})) {
                    s.stop_reads(); s.archive_document();
                    if let Err(e) = s.begin(intent) { s.fail(&e); }
                } else { s.fail("browser_preview_expired_or_unsafe_navigation"); }
            }
            drop(s); unsafe { decide(decision, if allowed { 1 } else { 0 }); }
        }
        #[unsafe(method(webView:didStartProvisionalNavigation:))]
        fn started(&self, _: &AnyObject, nav: Option<&AnyObject>) {
            if let Some(s) = self.ivars().upgrade() { let mut s = s.borrow_mut(); if s.active && !s.closed && s.phase == "loading" { s.navigation = nav.map(|n| n as *const _ as usize).unwrap_or(0); } }
        }
        #[unsafe(method(webView:didFinishNavigation:))]
        fn finished(&self, _: &AnyObject, nav: Option<&AnyObject>) { if let Some(s) = self.ivars().upgrade() { let mut s = s.borrow_mut(); if !s.closed && s.active && s.navigation != 0 && Some(s.navigation) == nav.map(|n| n as *const _ as usize) { s.phase = "ready"; s.emit(); } } }
        #[unsafe(method(webView:didFailNavigation:withError:))]
        fn failed(&self, _: &AnyObject, nav: Option<&AnyObject>, _: &AnyObject) { if let Some(s) = self.ivars().upgrade() { let mut s = s.borrow_mut(); if s.active && !s.closed && s.navigation != 0 && Some(s.navigation) == nav.map(|n| n as *const _ as usize) { s.fail("browser_navigation_failed"); } } }
        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        fn provisional(&self, web: &AnyObject, nav: Option<&AnyObject>, error: &AnyObject) {
            let code: isize = unsafe { msg_send![error, code] };
            let _ = web;
            if code != -999 && let Some(s) = self.ivars().upgrade() { let mut s = s.borrow_mut(); if s.active && !s.closed && s.navigation != 0 && Some(s.navigation) == nav.map(|n| n as *const _ as usize) { s.fail("browser_navigation_failed"); } }
        }
        #[unsafe(method(webViewWebContentProcessDidTerminate:))]
        fn terminated(&self, _: &AnyObject) { if let Some(s) = self.ivars().upgrade() { s.borrow_mut().fail("browser_content_process_terminated"); } }
    }
);
fn fail_task(task: &AnyObject) {
    let error: Retained<AnyObject> = unsafe {
        msg_send![AnyClass::get(c"NSError").expect("Foundation NSError"), errorWithDomain: &*NSString::from_str("YuriBrowser"), code: 1isize, userInfo: std::ptr::null::<AnyObject>()]
    };
    unsafe {
        let _: () = msg_send![task, didFailWithError: &*error];
    }
}
fn detach(state: &Rc<RefCell<State>>) {
    let web = state.borrow_mut().web.take();
    if let Some(web) = web {
        unsafe {
            let _: () = msg_send![&*web, setNavigationDelegate: std::ptr::null::<AnyObject>()];
            let _: () = msg_send![&*web, stopLoading];
            let _: () = msg_send![&*web, removeFromSuperview];
        }
    }
    state.borrow_mut().delegate = None;
}
fn compile_rules(state: &Rc<RefCell<State>>) {
    let rules = json!([
        {"trigger":{"url-filter":"^file:"},"action":{"type":"block"}},
        {"trigger":{"url-filter":"^https?://localhost"},"action":{"type":"block"}},
        {"trigger":{"url-filter":"^https?://[a-z0-9.-]+\\.localhost"},"action":{"type":"block"}},
        {"trigger":{"url-filter":"^https?://127\\."},"action":{"type":"block"}},
        {"trigger":{"url-filter":"^https?://0\\."},"action":{"type":"block"}},
        {"trigger":{"url-filter":"^https?://\\["},"action":{"type":"block"}},
        {"trigger":{"url-filter":"^wss?://localhost"},"action":{"type":"block"}},
        {"trigger":{"url-filter":"^wss?://[a-z0-9.-]+\\.localhost"},"action":{"type":"block"}},
        {"trigger":{"url-filter":"^wss?://127\\."},"action":{"type":"block"}},
        {"trigger":{"url-filter":"^wss?://0\\."},"action":{"type":"block"}},
        {"trigger":{"url-filter":"^wss?://\\["},"action":{"type":"block"}}
    ])
    .to_string();
    let ptr = Rc::into_raw(state.clone());
    let block = RulesBlock {
        header: BlockHeader {
            isa: unsafe { &_NSConcreteStackBlock },
            flags: (1 << 25) | (1 << 30),
            reserved: 0,
            invoke: rules_done as *const c_void,
            descriptor: &RULES_DESCRIPTOR as *const _ as *const c_void,
        },
        state: ptr,
    };
    let store: Retained<AnyObject> = unsafe {
        msg_send![
            AnyClass::get(c"WKContentRuleListStore").expect("WebKit linked"),
            defaultStore
        ]
    };
    // The block's @? argument encoding is not a raw ^v. Call the documented system
    // ABI directly rather than lying to objc2's typed message verifier.
    unsafe {
        let send: unsafe extern "C" fn(
            *const AnyObject,
            Sel,
            *const NSString,
            *const NSString,
            *const RulesBlock,
        ) = std::mem::transmute(objc_msgSend as *const c_void);
        send(
            &*store,
            sel!(compileContentRuleListForIdentifier:encodedContentRuleList:completionHandler:),
            &*NSString::from_str("yuri-nsh-no-client-loopback"),
            &*NSString::from_str(&rules),
            &block,
        );
        Rc::decrement_strong_count(ptr);
    }
}
fn make_web(state: &Rc<RefCell<State>>) -> Result<Retained<AnyObject>> {
    let mtm = MainThreadMarker::new().ok_or("browser_ui_thread_required")?;
    let delegate: Retained<Delegate> = unsafe {
        msg_send![
            super(Delegate::alloc(mtm).set_ivars(Rc::downgrade(state))),
            init
        ]
    };
    let configuration: Retained<AnyObject> = unsafe {
        msg_send![
            AnyClass::get(c"WKWebViewConfiguration").ok_or("browser_webkit_unavailable")?,
            new
        ]
    };
    let store: Retained<AnyObject> = unsafe {
        msg_send![
            AnyClass::get(c"WKWebsiteDataStore").ok_or("browser_webkit_unavailable")?,
            nonPersistentDataStore
        ]
    };
    let rules = state
        .borrow()
        .rules
        .clone()
        .ok_or("browser_network_rules_unavailable")?;
    unsafe {
        let _: () = msg_send![&*configuration, setWebsiteDataStore: &*store];
        let _: () = msg_send![&*configuration, setURLSchemeHandler: &*delegate, forURLScheme: &*NSString::from_str("yuri-resource")];
        let controller: Retained<AnyObject> = msg_send![&*configuration, userContentController];
        let _: () = msg_send![&*controller, addContentRuleList: &*rules];
        let preferences: Retained<AnyObject> = msg_send![&*configuration, preferences];
        let _: () = msg_send![&*preferences, setJavaScriptCanOpenWindowsAutomatically: false];
        let allocated: Allocated<AnyObject> = msg_send![
            AnyClass::get(c"WKWebView").ok_or("browser_webkit_unavailable")?,
            alloc
        ];
        let web: Retained<AnyObject> = msg_send![allocated, initWithFrame: NSRect::new(NSPoint::new(0.,0.), NSSize::new(1.,1.)), configuration: &*configuration];
        let _: () = msg_send![&*web, setNavigationDelegate: &*delegate];
        let _: () = msg_send![&*web, setAutoresizingMask: 18usize]; // NSViewWidthSizable | NSViewHeightSizable
        let root = state.borrow().view.clone();
        let bounds = root.bounds();
        let _: () = msg_send![&*web, setFrame: bounds];
        let _: () = msg_send![&*root, addSubview: &*web];
        state.borrow_mut().delegate = Some(delegate);
        Ok(web)
    }
}
fn load(web: &AnyObject, value: &str) {
    if let Some(url) = NSURL::URLWithString(&NSString::from_str(value)) {
        let request = NSURLRequest::requestWithURL(&url);
        unsafe {
            let _: Option<Retained<AnyObject>> = msg_send![web, loadRequest: &*request];
        }
    }
}
fn tick(state: &Rc<RefCell<State>>) {
    let mut s = state.borrow_mut();
    if s.closed {
        drop(s);
        detach(state);
        return;
    }
    if s.capture.as_ref().is_some_and(|c| !c.current()) {
        s.close();
        drop(s);
        detach(state);
        return;
    }
    if !s.active {
        if s.was_active && let Some(web) = s.web.clone() {
            s.was_active = false;
            drop(s);
            unsafe {
                let _: () = msg_send![&*web, stopLoading];
            }
        }
        return;
    }
    s.was_active = true;
    if !s.compiling {
        s.compiling = true;
        drop(s);
        compile_rules(state);
        return;
    }
    if !s.rules_ready {
        return;
    }
    if s.web.is_none() {
        drop(s);
        match make_web(state) {
            Ok(web) => state.borrow_mut().web = Some(web),
            Err(e) => state.borrow_mut().fail(&e),
        }
        return;
    }
    if let Some(result) = s.preparing.as_mut().and_then(Preparing::poll) {
        s.preparing = None;
        match result {
            Ok(Prepared::Resource(document)) => {
                s.display = document.display.clone();
                s.document = Some(*document);
                s.initial_document = true;
                s.phase = "navigate-resource";
            }
            Ok(Prepared::External(_)) => unreachable!(),
            Err(e) => s.fail(&e),
        }
    }
    let ids: Vec<usize> = s.pending.keys().copied().collect();
    for id in ids {
        let Some(result) = s.pending.get_mut(&id).and_then(|p| p.read.poll()) else {
            continue;
        };
        let pending = s.pending.remove(&id).expect("owned scheme task");
        match result {
            Ok(response)
                if response.data.len() <= TOTAL.saturating_sub(s.bytes)
                    && (!s.initial_document
                        || response.mime.split(';').next() == Some("text/html")) =>
            {
                s.bytes += response.data.len();
                s.initial_document = false;
                let request: Retained<NSURLRequest> = unsafe { msg_send![&*pending.task, request] };
                let Some(url) = request.URL() else {
                    drop(s);
                    fail_task(&pending.task);
                    s = state.borrow_mut();
                    continue;
                };
                let csp = format!(
                    "{}{}",
                    CSP,
                    response.csp.map(|v| format!(", {v}")).unwrap_or_default()
                );
                let headers = NSDictionary::from_slices(
                    &[
                        &*NSString::from_str("Content-Type"),
                        &*NSString::from_str("Content-Security-Policy"),
                        &*NSString::from_str("Cache-Control"),
                        &*NSString::from_str("Referrer-Policy"),
                        &*NSString::from_str("X-Content-Type-Options"),
                    ],
                    &[
                        &*NSString::from_str(&response.mime),
                        &*NSString::from_str(&csp),
                        &*NSString::from_str("no-store"),
                        &*NSString::from_str("no-referrer"),
                        &*NSString::from_str("nosniff"),
                    ],
                );
                let head: Retained<AnyObject> = unsafe {
                    let allocated: Allocated<AnyObject> = msg_send![
                        AnyClass::get(c"NSHTTPURLResponse").expect("Foundation"),
                        alloc
                    ];
                    msg_send![allocated, initWithURL: &*url, statusCode: response.status as isize, HTTPVersion: &*NSString::from_str("HTTP/1.1"), headerFields: &*headers]
                };
                let data = NSData::with_bytes(&response.data);
                drop(s);
                unsafe {
                    let _: () = msg_send![&*pending.task, didReceiveResponse: &*head];
                    let _: () = msg_send![&*pending.task, didReceiveData: &*data];
                    let _: () = msg_send![&*pending.task, didFinish];
                }
                s = state.borrow_mut();
            }
            _ => {
                drop(s);
                fail_task(&pending.task);
                s = state.borrow_mut();
                s.fail("browser_resource_failed");
            }
        }
    }
    let Some(web) = s.web.clone() else {
        return;
    };
    let phase = s.phase;
    let target = if phase == "navigate-resource" {
        s.document.as_ref().map(|d| d.entry.clone())
    } else {
        Some(s.display.clone())
    };
    if phase.starts_with("command-") || phase.starts_with("navigate-") {
        s.phase = if phase == "command-stop" {
            "cancelled"
        } else if phase == "command-external" {
            "ready"
        } else {
            "loading"
        };
        s.emit();
    }
    drop(s);
    unsafe {
        match phase {
            "navigate-resource" | "navigate-external" => {
                if let Some(url) = target {
                    load(&web, &url);
                }
            }
            "command-back" => {
                let _: Option<Retained<AnyObject>> = msg_send![&*web, goBack];
            }
            "command-forward" => {
                let _: Option<Retained<AnyObject>> = msg_send![&*web, goForward];
            }
            "command-reload" => {
                let _: Option<Retained<AnyObject>> = msg_send![&*web, reload];
            }
            "command-stop" => {
                let _: () = msg_send![&*web, stopLoading];
            }
            "command-external" => {
                if let Some(url) = target.filter(|v| web_url(v).is_ok_and(|(_, local)| !local))
                    && let Some(url) = NSURL::URLWithString(&NSString::from_str(&url))
                {
                    let workspace: Retained<AnyObject> = msg_send![
                        AnyClass::get(c"NSWorkspace").expect("AppKit"),
                        sharedWorkspace
                    ];
                    let _: bool = msg_send![&*workspace, openURL: &*url];
                }
            }
            _ => {}
        }
    }
}
