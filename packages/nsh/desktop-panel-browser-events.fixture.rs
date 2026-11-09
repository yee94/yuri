//! Test-only Engine harness: production NativeDesktopPanel JSX and native event
//! dispatch, no registered browser implementation, OS window, Vault or network.
use nsh_core::{EventKind, EventPayload, MountBatch, MountItem, NodeId};
use nsh_engine::{Bundle, Engine, EngineConfig, HostChannel, MountSink};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::mpsc, time::{Duration, Instant}};

struct Sink(mpsc::Sender<MountBatch>);
impl MountSink for Sink {
    fn submit(&self, batch: MountBatch) { let _ = self.0.send(batch); }
    fn report_error(&self, message: &str) { eprintln!("panel-browser engine: {message}"); }
}
#[derive(Default)]
struct Screen {
    ids: HashMap<String, NodeId>,
    components: HashMap<NodeId, String>,
    props: HashMap<NodeId, Value>,
    texts: HashMap<NodeId, String>,
    inputs: HashMap<NodeId, String>,
    parents: HashMap<NodeId, NodeId>,
    browser_creates: usize,
}
impl Screen {
    fn apply(&mut self, batch: MountBatch) {
        for item in batch.items {
            match item {
                MountItem::Insert { parent, child, .. } => { self.parents.insert(child, parent); }
                MountItem::Remove { id } => { self.parents.remove(&id); }
                MountItem::ViewProps { id, props } => { if let Some(key) = props.test_id { self.ids.insert(key.to_string(), id); } }
                MountItem::Component { id, name } => {
                    if &*name == "yuri.desktop.browser" { self.browser_creates += 1; }
                    self.components.insert(id, name.to_string());
                }
                MountItem::ComponentProps { id, props } => {
                    let value = self.props.entry(id).or_insert(json!({}));
                    for (key, field) in props { value[&*key] = field.unwrap_or(Value::Null); }
                }
                MountItem::Text { id, text, .. } => { self.texts.insert(id, text.text.clone()); }
                MountItem::InputValue { id, text, .. } => { self.inputs.insert(id, text); }
                MountItem::Delete { id } => {
                    self.parents.remove(&id);
                    self.ids.retain(|_, value| *value != id); self.components.remove(&id);
                    self.props.remove(&id); self.texts.remove(&id); self.inputs.remove(&id);
                }
                _ => {}
            }
        }
    }
    fn active_browser(&self) -> Option<(NodeId, Value)> {
        self.components.iter().find_map(|(id, name)| {
            let binding = &self.props.get(id)?["binding"];
            (name == "yuri.desktop.browser" && binding["active"] == true && self.attached(*id)).then(|| (*id, binding.clone()))
        })
    }
    fn attached(&self, mut id: NodeId) -> bool {
        while id != nsh_core::ROOT_ID { let Some(parent) = self.parents.get(&id) else { return false; }; id = *parent; }
        true
    }
    fn address(&self) -> &str { self.inputs.get(&self.ids["desktop-browser-address"]).map(String::as_str).unwrap_or("") }
}
struct Fixture { engine: Engine, host: HostChannel, rx: mpsc::Receiver<MountBatch>, screen: Screen, ticket: usize }
impl Fixture {
    fn start(os: nsh_core::platform::Os) -> Self {
        let path = std::env::var("NSH_PANEL_BROWSER_BUNDLE").expect("fixture bundle");
        let mut config = EngineConfig::new(Bundle::read(std::path::Path::new(&path)).unwrap());
        config.ui_sets = vec![nsh_base::registry()];
        config.environment.os = os; config.environment.idiom = nsh_core::platform::Idiom::Desktop;
        config.viewport = nsh_core::Size::new(nsh_core::geometry::px(1000.0), nsh_core::geometry::px(800.0));
        config.environment.window = config.viewport;
        let host = HostChannel::default(); config.host = host.clone();
        let (tx, rx) = mpsc::channel();
        let engine = Engine::start(config, || nsh_core::ApproxTextEngine, Sink(tx)).unwrap();
        let mut fixture = Self { engine, host, rx, screen: Screen::default(), ticket: 0 };
        fixture.until(|screen| screen.texts.values().any(|text| text == "browser-fixture-ready:true"));
        fixture.control("header", None); fixture
    }
    fn until(&mut self, predicate: impl Fn(&Screen) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !predicate(&self.screen) {
            assert!(Instant::now() < deadline, "panel-browser timeout; ids={:?}, props={:?}, texts={:?}", self.screen.ids, self.screen.props, self.screen.texts);
            self.engine.control().frame();
            if let Ok(batch) = self.rx.recv_timeout(Duration::from_millis(10)) { self.screen.apply(batch); }
        }
        self.settle();
    }
    fn settle(&mut self) {
        self.engine.control().frame();
        while let Ok(batch) = self.rx.recv_timeout(Duration::from_millis(60)) { self.screen.apply(batch); }
    }
    fn control(&mut self, action: &str, url: Option<&str>) {
        self.ticket += 1;
        let expected = format!("browser-fixture-control:{}", self.ticket);
        self.host.send("browser.test.control", json!({"action":action,"url":url,"ticket":self.ticket})).unwrap();
        self.until(|screen| screen.texts.values().any(|text| text == &expected));
    }
    fn audit(&mut self) -> Value {
        self.control("audit", None);
        serde_json::from_str(&self.screen.texts[&self.screen.ids["browser-fixture-audit"]]).unwrap()
    }
    fn open(&mut self, url: &str) -> (NodeId, Value) {
        self.control("url", Some(url)); self.until(|screen| screen.active_browser().is_some());
        self.screen.active_browser().unwrap()
    }
    fn native(&mut self, id: NodeId, value: Value) {
        self.engine.control().dispatch_event(id, EventKind::NativeEvent, EventPayload::Native { name: "browser".into(), data: value }); self.settle();
    }
    fn receipt(binding: &Value, url: &str) -> Value {
        json!({"owner":binding["owner"],"expectedHost":binding["expectedHost"],"generation":binding["generation"],"phase":"ready","url":url,"canBack":true,"canForward":false,"error":null})
    }
    fn unchanged(&mut self, before: &Value) {
        let after = self.audit();
        for field in ["snapshot", "metadata", "stored", "reads", "writes", "notifications"] { assert_eq!(after[field], before[field], "unexpected browser write: {field}"); }
    }
}

fn navigation(os: nsh_core::platform::Os) {
    let mut f = Fixture::start(os);
    assert!(f.screen.ids.contains_key("native-desktop-panel"));
    let (id, first) = f.open("https://first.invalid/");
    assert_eq!(f.screen.address(), "https://first.invalid/");
    let first_audit = f.audit();
    let (next_id, next) = f.open("http://localhost:3000/second");
    assert_eq!(next_id, id); assert_eq!(next["owner"], first["owner"]);
    assert_eq!(next["generation"].as_u64().unwrap(), first["generation"].as_u64().unwrap() + 1);
    assert_eq!(next["intent"]["kind"], "loopback"); assert_eq!(f.screen.address(), "http://localhost:3000/second");
    assert_eq!(f.screen.browser_creates, 1, "URL replacement must not remount native browser");
    let next_audit = f.audit(); assert_eq!(next_audit["snapshot"]["selectedID"], first_audit["snapshot"]["selectedID"]);
    f.native(id, Fixture::receipt(&first, "https://stale-generation.invalid/")); f.unchanged(&next_audit);
    f.native(id, Fixture::receipt(&next, "https://navigated.invalid/path"));
    f.until(|screen| screen.address() == "https://navigated.invalid/path");
    assert_eq!(f.screen.address(), "https://navigated.invalid/path");
    let navigated = f.audit();
    for tabs in [&navigated["snapshot"]["tabs"], &navigated["metadata"][0]["tabs"], &navigated["stored"]["scopes"][0]["tabs"]] {
        assert_eq!(tabs[0]["id"], "desktop-browser"); assert_eq!(tabs[0]["url"], "https://navigated.invalid/path");
    }
    assert_eq!(f.screen.active_browser().unwrap().1["generation"], next["generation"], "reflected navigation must not issue a second native request");
    f.control("context", None); f.control("header", None);
    assert_eq!(f.screen.address(), "https://navigated.invalid/path"); assert_eq!(f.screen.browser_creates, 1);

    // Standard native text/press events exercise the production address Input.
    // A navigation request is not a native navigation receipt or metadata write.
    let before_typing = f.audit();
    let input = f.screen.ids["desktop-browser-address"];
    f.engine.control().dispatch_event(input, EventKind::ChangeText, EventPayload::Text { text: "https://requested.invalid/".into(), count: 1 }); f.settle();
    f.engine.control().dispatch_event(f.screen.ids["desktop-browser-go"], EventKind::Press, EventPayload::None); f.settle();
    let (request_id, request) = f.screen.active_browser().unwrap();
    assert_eq!(request_id, id); assert_eq!(request["intent"]["url"], "https://requested.invalid/"); f.unchanged(&before_typing);
    f.native(id, Fixture::receipt(&next, "https://late-after-request.invalid/")); f.unchanged(&before_typing);
    f.native(id, Fixture::receipt(&request, "https://requested.invalid/"));
    let accepted = f.audit(); assert_eq!(accepted["stored"]["scopes"][0]["tabs"][0]["url"], "https://requested.invalid/");
}

fn fences(os: nsh_core::platform::Os) {
    let mut f = Fixture::start(os);
    let (id, binding) = f.open("https://prior.invalid/");
    let before = f.audit();
    for (field, value) in [("owner", json!("retired-owner")), ("generation", json!(0)), ("expectedHost", json!({"hostID":"other","lease":"lease-a"})), ("expectedHost", json!({"hostID":"synthetic","lease":"retired"})), ("url", json!("javascript:alert(1)"))] {
        let mut receipt = Fixture::receipt(&binding, "https://forbidden.invalid/"); receipt[field] = value;
        f.native(id, receipt); f.unchanged(&before); assert_eq!(f.screen.address(), "https://prior.invalid/");
    }
    for modal in ["cover", "internal-modal"] {
        f.control(modal, None); let covered = f.audit();
        f.native(id, Fixture::receipt(&binding, "https://modal-forbidden.invalid/")); f.unchanged(&covered);
        assert_eq!(f.screen.address(), "https://prior.invalid/"); f.control(modal, None);
    }
    f.control("lease", None); f.until(|screen| screen.active_browser().is_some_and(|(_, value)| value["expectedHost"]["lease"] != binding["expectedHost"]["lease"]));
    let (renewed_id, renewed) = f.screen.active_browser().unwrap();
    assert_ne!(renewed["owner"], binding["owner"], "renewed binding={renewed}, prior={binding}");
    let renewed_prior = f.audit();
    f.native(id, Fixture::receipt(&binding, "https://retired-node.invalid/")); f.unchanged(&renewed_prior);
    f.native(renewed_id, Fixture::receipt(&binding, "https://old-owner.invalid/")); f.unchanged(&renewed_prior);
    let mut old_lease = Fixture::receipt(&renewed, "https://old-lease.invalid/"); old_lease["expectedHost"] = binding["expectedHost"].clone();
    f.native(renewed_id, old_lease); f.unchanged(&renewed_prior);
    f.native(renewed_id, Fixture::receipt(&renewed, "https://renewed.invalid/")); assert_eq!(f.audit()["snapshot"]["tabs"][0]["url"], "https://renewed.invalid/");
    f.control("host", None); f.control("header", None); let (other_id, other) = f.open("https://other.invalid/");
    let other_prior = f.audit(); f.native(other_id, Fixture::receipt(&renewed, "https://retired-host.invalid/")); f.unchanged(&other_prior);
    assert_ne!(other["expectedHost"]["hostID"], renewed["expectedHost"]["hostID"]);

    f.control("preview", None); f.until(|screen| screen.active_browser().is_some_and(|(_, binding)| binding["intent"]["kind"] == "html"));
    let (preview_id, preview) = f.screen.active_browser().unwrap();
    let preview_prior = f.audit();
    f.native(preview_id, Fixture::receipt(&preview, "/workspace/index.html")); f.unchanged(&preview_prior);
    f.native(preview_id, Fixture::receipt(&preview, "https://preview-only.invalid/")); f.unchanged(&preview_prior);
    f.native(other_id, Fixture::receipt(&other, "https://inactive-browser.invalid/")); f.unchanged(&preview_prior);
    let after = f.audit(); assert_eq!(after["snapshot"]["tabs"][0]["url"], "https://other.invalid/");
    f.control("header", None); assert_eq!(f.screen.address(), "https://other.invalid/");
}

#[test] fn macos_production_panel_navigation_receipts() { navigation(nsh_core::platform::Os::MacOs); }
#[test] fn windows_production_panel_navigation_receipts() { navigation(nsh_core::platform::Os::Windows); }
#[test] fn macos_production_panel_receipt_fences_and_preview() { fences(nsh_core::platform::Os::MacOs); }
#[test] fn windows_production_panel_receipt_fences_and_preview() { fences(nsh_core::platform::Os::Windows); }
