use super::*;
type RecordedEvents = Arc<Mutex<Vec<(String, Value)>>>;
fn scope() -> Value {
    json!({"hostID":"synthetic", "lease":"00000000-0000-4000-8000-000000000001"})
}
fn value(owner: &str, x: f64) -> Value {
    json!({"owner":owner,"generation":1,"revision":1,"expectedHost":scope(),"active":true,"rect":{"x":x,"y":10.,"width":60.,"height":24.}})
}
fn p(x: f64) -> Point {
    Point { x, y: 20. }
}
fn fixture() -> (Registration, RecordedEvents) {
    let r = Registration::default();
    r.set_scope(Some(&scope())).unwrap();
    r.gate(true, false);
    let events = Arc::new(Mutex::new(Vec::new()));
    for (id, x) in [(1, 10.), (2, 80.)] {
        let events = events.clone();
        r.bind(
            id,
            Some(&value(&format!("owner_{id}"), x)),
            Arc::new(move |name, data| events.lock().unwrap().push((name.into(), data))),
        );
    }
    (r, events)
}
#[test]
fn down_up_same_tab_only_and_no_double_close() {
    let (r, e) = fixture();
    r.observe(NativeInput::MiddleDown(p(20.)), false);
    r.observe(NativeInput::MiddleUp(p(100.)), false);
    assert!(e.lock().unwrap().is_empty());
    r.observe(NativeInput::MiddleDown(p(20.)), false);
    r.observe(NativeInput::MiddleUp(p(30.)), false);
    r.observe(NativeInput::MiddleUp(p(30.)), false);
    let e = e.lock().unwrap();
    assert_eq!(e.len(), 1);
    assert_eq!(e[0].0, "middleClose");
    assert_eq!(e[0].1["owner"], "owner_1");
    assert!(e[0].1.get("id").is_none());
}
#[test]
fn rect_edges_overlaps_hidden_and_malformed_fail_closed() {
    let (r, e) = fixture();
    for x in [9., 70., 79., 140., f64::NAN] {
        r.observe(NativeInput::MiddleDown(p(x)), false);
        r.observe(NativeInput::MiddleUp(p(x)), false);
    }
    assert!(e.lock().unwrap().is_empty());
    r.bind(
        3,
        Some(&value("overlap", 10.)),
        Arc::new(|_, _| panic!("ambiguous hit")),
    );
    r.observe(NativeInput::MiddleDown(p(20.)), false);
    r.observe(NativeInput::MiddleUp(p(20.)), false);
    assert!(e.lock().unwrap().is_empty());
    assert!(binding(&json!({"owner":"bad"})).is_none());
    let mut bad = value("bad", 10.);
    bad["rect"]["width"] = json!(0);
    assert!(binding(&bad).is_none());
    bad = value("bad", 10.);
    bad["close"] = json!(true);
    assert!(binding(&bad).is_none());
}
#[test]
fn layout_scope_lease_retire_and_cancel_fence_pressed() {
    for mode in [
        "layout",
        "lease",
        "retire",
        "cancel",
        "blur",
        "modal",
        "inactive",
        "detach",
        "double_down",
    ] {
        let (r, e) = fixture();
        r.observe(NativeInput::MiddleDown(p(20.)), false);
        match mode {
            "layout" => {
                let mut v = value("owner_1", 10.);
                v["revision"] = json!(2);
                r.bind(1, Some(&v), Arc::new(|_, _| panic!("stale geometry")));
            }
            "lease" => {
                r.set_scope(Some(
                    &json!({"hostID":"synthetic","lease":"00000000-0000-4000-8000-000000000002"}),
                ))
                .unwrap();
            }
            "retire" => r.set_scope(None).unwrap(),
            "cancel" => r.observe(NativeInput::Cancel, false),
            "blur" => r.observe(NativeInput::Blur, false),
            "modal" => r.gate(true, true),
            "inactive" => r.gate(false, false),
            "detach" => r.detach(1),
            _ => r.observe(NativeInput::MiddleDown(p(20.)), false),
        }
        r.observe(NativeInput::MiddleUp(p(20.)), false);
        assert!(e.lock().unwrap().is_empty(), "{mode}");
    }
}
#[test]
fn same_scope_does_not_retire_and_foreign_scope_cannot_register() {
    let (r, e) = fixture();
    r.observe(NativeInput::MiddleDown(p(20.)), false);
    r.set_scope(Some(&scope())).unwrap();
    r.observe(NativeInput::MiddleUp(p(20.)), false);
    assert_eq!(e.lock().unwrap().len(), 1);
    let mut bad = value("foreign", 10.);
    bad["expectedHost"]["hostID"] = json!("other");
    r.bind(1, Some(&bad), Arc::new(|_, _| panic!("foreign")));
    r.observe(NativeInput::MiddleDown(p(20.)), false);
    r.observe(NativeInput::MiddleUp(p(20.)), false);
    assert_eq!(e.lock().unwrap().len(), 1);
}
#[test]
fn windows_left_focus_outside_and_window_blur_mac_never_native_focuses() {
    let (r, e) = fixture();
    r.observe(NativeInput::LeftDown(p(20.)), false);
    assert!(e.lock().unwrap().is_empty());
    r.observe(NativeInput::LeftDown(p(20.)), true);
    r.observe(NativeInput::LeftDown(p(100.)), true);
    r.observe(NativeInput::Blur, true);
    assert_eq!(
        e.lock()
            .unwrap()
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        vec!["tabFocus", "tabBlur", "tabFocus", "tabBlur"]
    );
    r.observe(NativeInput::LeftDown(p(20.)), true);
    r.observe(NativeInput::LeftDown(p(200.)), true);
    assert_eq!(e.lock().unwrap().last().unwrap().0, "tabBlur");
}
#[test]
fn emit_is_outside_lock_and_reentrant_retire_is_safe() {
    let (r, _) = fixture();
    let captured = r.clone();
    r.bind(1, None, Arc::new(|_, _| {}));
    r.bind(
        1,
        Some(&value("reentrant", 10.)),
        Arc::new(move |_, _| {
            captured.set_scope(None).unwrap();
        }),
    );
    r.observe(NativeInput::MiddleDown(p(20.)), false);
    r.observe(NativeInput::MiddleUp(p(20.)), false);
    assert!(r.book.lock().unwrap().entries.is_empty());
}
#[test]
fn retired_component_handle_cannot_revive_on_delayed_prop_or_same_scope_aba() {
    let (r, e) = fixture();
    let mut observed = r.current_scope().unwrap();
    observed["hostID"] = json!("detached-copy");
    assert_eq!(r.current_scope(), Some(scope()));
    let epoch = r.epoch();
    r.set_scope(None).unwrap();
    assert_eq!(r.current_scope(), None);
    r.set_scope(Some(&scope())).unwrap();
    assert_eq!(r.current_scope(), Some(scope()));
    r.bind_epoch(
        1,
        epoch,
        Some(&value("owner_1", 10.)),
        Arc::new(|_, _| panic!("old context revived")),
    );
    r.observe(NativeInput::MiddleDown(p(20.)), false);
    r.observe(NativeInput::MiddleUp(p(20.)), false);
    assert!(e.lock().unwrap().is_empty());
    assert!(r.book.lock().unwrap().entries.is_empty());
}
#[test]
fn windows_signed_client_pixels_respect_dpi_and_invalid_dpi_has_no_hit() {
    let packed = ((45u32 << 16) | (-30i16 as u16 as u32)) as isize;
    assert_eq!(
        windows_client_point(packed, 144),
        Some(Point { x: -20., y: 30. })
    );
    assert_eq!(windows_client_point(packed, 0), None);
}
