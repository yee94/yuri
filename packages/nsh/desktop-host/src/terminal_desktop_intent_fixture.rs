//! Headless-only production Dock -> preview factory -> native browser intent.
//! Native events are injected through public EngineControl; no OS renderer,
//! browser network, Vault, PTY or application entrypoint is run.
#[path = "terminal_document.rs"]
mod document;
#[cfg(test)]
mod tests {
    use nsh_core::{Command, EventKind, EventPayload, MountBatch, MountItem, NodeId};
    use nsh_engine::{Bundle, Engine, EngineConfig, HostChannel, MountSink};
    use serde_json::{Value, json};
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex, mpsc},
        time::{Duration, Instant},
    };

    struct Sink(mpsc::Sender<MountBatch>);
    impl MountSink for Sink {
        fn submit(&self, batch: MountBatch) {
            let _ = self.0.send(batch);
        }
        fn report_error(&self, message: &str) {
            eprintln!("synthetic Dock engine: {message}");
        }
    }
    #[derive(Default)]
    struct Screen {
        ids: HashMap<String, NodeId>,
        components: HashMap<NodeId, String>,
        props: HashMap<NodeId, Value>,
        terminal_key: String,
        external: Vec<String>,
        commands: Vec<String>,
    }
    impl Screen {
        fn apply(&mut self, batch: MountBatch, engine: &Engine) {
            for item in batch.items {
                match item {
                    MountItem::ViewProps { id, props } => {
                        if let Some(key) = props.test_id {
                            self.ids.insert(key.to_string(), id);
                        }
                    }
                    MountItem::Remove { id } => {
                        self.ids.retain(|_, value| *value != id);
                        self.components.remove(&id);
                        self.props.remove(&id);
                    }
                    MountItem::Component { id, name } => {
                        self.components.insert(id, name.to_string());
                    }
                    MountItem::ComponentProps { id, props } => {
                        let value = self.props.entry(id).or_insert(json!({}));
                        for (name, field) in props {
                            value[&*name] = field.unwrap_or(Value::Null);
                        }
                    }
                    MountItem::Command {
                        id,
                        command: Command::Native { name, args },
                    } if self
                        .components
                        .get(&id)
                        .is_some_and(|name| name == "yuri.terminal.viewport") =>
                    {
                        self.commands.push(name.to_string());
                        if &*name == "render" {
                            self.terminal_key = args["key"].as_str().unwrap_or("").to_owned();
                            if let Some(last) =
                                args["chunks"].as_array().and_then(|chunks| chunks.last())
                            {
                                self.terminal_event(engine, json!({"type":"ack","key":args["key"],"serial":args["serial"],"cursor":last["id"]}));
                            }
                        }
                    }
                    MountItem::Command {
                        command: Command::OpenUrl { id, url },
                        ..
                    } => {
                        self.external.push(url);
                        engine.control().dispatch_event(
                            nsh_core::ROOT_ID,
                            EventKind::OpenUrl,
                            EventPayload::Json(json!({"id":id,"opened":true})),
                        );
                    }
                    _ => {}
                }
            }
        }
        fn terminal(&self) -> (NodeId, &Value) {
            let id = *self
                .ids
                .get("desktop-terminal-viewport")
                .expect("real Dock native viewport");
            (id, self.props.get(&id).expect("native props"))
        }
        fn terminal_event(&self, engine: &Engine, event: Value) {
            let (id, props) = self.terminal();
            let mut value = json!({"owner":props["owner"],"generation":props["generation"],"expectedHost":props["expectedHost"]});
            for (key, field) in event.as_object().unwrap() {
                value[key] = field.clone();
            }
            engine.control().dispatch_event(
                id,
                EventKind::NativeEvent,
                EventPayload::Native {
                    name: "terminal".into(),
                    data: value,
                },
            );
        }
        fn browser(&self, url: &str, kind: &str) -> bool {
            self.components.iter().any(|(id, name)| {
                name == "yuri.desktop.browser"
                    && self.props.get(id).is_some_and(|props| {
                        props["binding"]["intent"]["kind"] == kind
                            && props["binding"]["intent"]["url"] == url
                            && props["binding"]["active"] == true
                    })
            })
        }
    }
    fn until(
        screen: &mut Screen,
        rx: &mpsc::Receiver<MountBatch>,
        engine: &Engine,
        predicate: impl Fn(&Screen) -> bool,
    ) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !predicate(screen) {
            assert!(
                Instant::now() < deadline,
                "headless Dock timeout; key={:?}, commands={:?}, ids={:?}, props={:?}",
                screen.terminal_key,
                screen.commands,
                screen.ids,
                screen.props
            );
            engine.control().frame();
            if let Ok(batch) = rx.recv_timeout(Duration::from_millis(20)) {
                screen.apply(batch, engine);
            }
        }
    }
    fn settle(screen: &mut Screen, rx: &mpsc::Receiver<MountBatch>, engine: &Engine) {
        engine.control().frame();
        while let Ok(batch) = rx.recv_timeout(Duration::from_millis(100)) {
            screen.apply(batch, engine);
        }
    }
    #[test]
    fn actual_dock_preview_button_and_native_links_reach_production_browser_intents_headless() {
        let bundle_path =
            std::env::var("NSH_TERMINAL_DOCK_INTENT_BUNDLE").expect("fixture bundle required");
        for os in [
            nsh_core::platform::Os::MacOs,
            nsh_core::platform::Os::Windows,
        ] {
            let host = HostChannel::default();
            let attachment = Arc::new(Mutex::new(Value::Null));
            for name in [
                "terminal.desktop.capabilities",
                "terminal.capabilities",
                "terminal.catalog.read",
                "terminal.catalog.write",
                "terminal.create",
                "terminal.attach",
                "terminal.detach",
                "terminal.resize",
                "terminal.input",
                "terminal.probe",
            ] {
                let attachment = attachment.clone();
                let sender = host.clone();
                host.handle(name, move |mut call| {
                    let input = call.take_data();
                    let output = match name {
                        "terminal.desktop.capabilities" => json!({"expectedHost":input["expectedHost"],"component":"yuri.terminal.viewport","version":1,"native":true,"inline":true,"vt":true,"inputReceipts":true,"outputAcknowledgements":true,"hostAppearance":true,"selection":true,"ime":true,"bracketedPaste":true}),
                        "terminal.capabilities" => json!({"scope":"native-opaque","wsVersion":2,"durableMetadata":true}),
                        "terminal.catalog.read" => json!({"schema":1,"hostID":"synthetic","directories":[]}),
                        "terminal.create" => json!({"sessionId":"synthetic-pty-receipt"}),
                        "terminal.attach" => { *attachment.lock().unwrap() = input.clone(); let mut connected = input; connected["type"] = json!("connected"); sender.send("terminal.event", connected).unwrap(); json!(true) }
                        _ => json!(true),
                    };
                    call.resolve(output);
                });
            }
            let bundle = Bundle::read(std::path::Path::new(&bundle_path)).unwrap();
            let mut config = EngineConfig::new(bundle);
            config.ui_sets = vec![nsh_base::registry()];
            config.host = host.clone();
            config.environment.os = os;
            config.environment.idiom = nsh_core::platform::Idiom::Desktop;
            config.viewport = nsh_core::Size::new(
                nsh_core::geometry::px(1000.0),
                nsh_core::geometry::px(700.0),
            );
            config.environment.window = config.viewport;
            let (tx, rx) = mpsc::channel();
            let engine = Engine::start(config, || nsh_core::ApproxTextEngine, Sink(tx)).unwrap();
            let mut screen = Screen::default();
            until(&mut screen, &rx, &engine, |screen| {
                screen.ids.contains_key("desktop-terminal-viewport")
                    && screen
                        .props
                        .values()
                        .any(|props| props["configuration"]["size"].as_f64().is_some())
            });
            super::document::configuration(&screen.terminal().1["configuration"]).expect(
                "actual production renderer configuration must be admitted before synthetic ready",
            );
            screen.terminal_event(&engine, json!({"type":"ready","version":1}));
            until(&mut screen, &rx, &engine, |screen| {
                !screen.terminal_key.is_empty()
            });
            screen.terminal_event(
                &engine,
                json!({"type":"resize","key":screen.terminal_key,"cols":90,"rows":20}),
            );
            until(&mut screen, &rx, &engine, |_| {
                !attachment.lock().unwrap().is_null()
            });
            let mut output = attachment.lock().unwrap().clone();
            output["type"] = json!("data");
            output["id"] = json!(1);
            output["data"] = json!("Local: http://localhost:3000/\n");
            host.send("terminal.event", output).unwrap();
            until(&mut screen, &rx, &engine, |screen| {
                screen.ids.contains_key("desktop-terminal-preview")
            });
            let button = screen.ids["desktop-terminal-preview"];
            engine
                .control()
                .dispatch_event(button, EventKind::Press, EventPayload::None);
            until(&mut screen, &rx, &engine, |screen| {
                screen.browser("http://localhost:3000/", "loopback")
            });
            assert!(
                screen.external.is_empty(),
                "loopback must reach Host browser intent, never system openUrl"
            );
            let key = screen.terminal_key.clone();
            screen.terminal_event(&engine, json!({"type":"openPreview","key":key,"url":"https://example.invalid/docs","mode":"external"}));
            until(&mut screen, &rx, &engine, |screen| {
                screen.external.len() == 1
            });
            assert_eq!(screen.external, ["https://example.invalid/docs"]);
            screen.terminal_event(&engine, json!({"type":"openPreview","key":key,"url":"http://localhost:4000/app","mode":"external"}));
            until(&mut screen, &rx, &engine, |screen| {
                screen.browser("http://localhost:4000/app", "loopback")
            });
            assert_eq!(screen.external.len(), 1);
            screen.terminal_event(&engine, json!({"type":"openPreview","key":key,"url":"https://example.invalid/old","mode":"external","generation":0}));
            screen.terminal_event(&engine, json!({"type":"openPreview","key":key,"url":"https://user:password@example.invalid/","mode":"external"}));
            screen.terminal_event(&engine, json!({"type":"openPreview","key":key,"url":"http://127.1:3000/","mode":"external"}));
            host.send("fixture.active", json!(false)).unwrap();
            settle(&mut screen, &rx, &engine);
            screen.terminal_event(&engine, json!({"type":"openPreview","key":key,"url":"https://example.invalid/hidden","mode":"external"}));
            settle(&mut screen, &rx, &engine);
            assert_eq!(
                screen.external.len(),
                1,
                "stale, unsafe and inactive links must not emit openUrl"
            );
            drop(engine);
        }
    }
}
