use super::{Book, Key, MAX_REQUESTS};
use serde_json::{Value, json};

fn input(id: &str) -> Value {
    json!({
        "ownerID": "owner_a", "requestID": id, "windowID": "window-1",
        "expectedHost": {"hostID":"synthetic", "lease":"00000000-0000-4000-ABCD-000000000001"}
    })
}

fn key(id: &str) -> Key {
    Key::parse(&input(id), "window-1", false).unwrap()
}

#[test]
fn exact_request_and_cancel_envelopes_normalize_the_real_policy_scope() {
    let cancel = input("request-1");
    let mut request = cancel.clone();
    request["path"] = json!("/api/session/synthetic/generate");
    let parsed = Key::parse(&request, "window-1", true).unwrap();
    assert_eq!(parsed, Key::parse(&cancel, "window-1", false).unwrap());
    assert_eq!(
        parsed.scope["lease"],
        "00000000-0000-4000-abcd-000000000001"
    );
    request["method"] = json!("POST");
    request["body"] = json!({"prompt":"synthetic"});
    assert_eq!(Key::parse(&request, "window-1", true).unwrap(), parsed);
    assert_eq!(
        Key::parse(&request, "window-1", false).unwrap_err(),
        "http_receipt_invalid"
    );
    assert_eq!(
        Key::parse(&cancel, "window-1", true).unwrap_err(),
        "http_receipt_invalid"
    );
}

#[test]
fn every_missing_or_extra_field_is_rejected_without_network_policy_guessing() {
    for field in ["ownerID", "requestID", "windowID", "expectedHost"] {
        let mut value = input("request");
        value.as_object_mut().unwrap().remove(field);
        assert_eq!(
            Key::parse(&value, "window-1", false).unwrap_err(),
            "http_receipt_invalid"
        );
    }
    for field in ["headers", "url", "signal", "ticket", "extra"] {
        for request in [false, true] {
            let mut value = input("request");
            if request {
                value["path"] = json!("/api/synthetic");
            }
            value[field] = Value::Null;
            assert_eq!(
                Key::parse(&value, "window-1", request).unwrap_err(),
                "http_receipt_invalid"
            );
        }
    }
    for path in [Value::Null, json!(1), json!(""), json!([])] {
        let mut value = input("request");
        value["path"] = path;
        assert_eq!(
            Key::parse(&value, "window-1", true).unwrap_err(),
            "http_receipt_invalid"
        );
    }
    for value in [Value::Null, json!([]), json!("input")] {
        assert_eq!(
            Key::parse(&value, "window-1", false).unwrap_err(),
            "http_receipt_invalid"
        );
    }
}

#[test]
fn ids_are_nonempty_ascii_bounded_tokens_and_window_is_native_exact() {
    for field in ["ownerID", "requestID", "windowID"] {
        for invalid in [
            json!(""),
            json!("a".repeat(129)),
            json!("has space"),
            json!("a/b"),
            json!("a.b"),
            json!("a\n"),
            json!("中文"),
            json!(7),
            Value::Null,
        ] {
            let mut value = input("request");
            value[field] = invalid;
            assert_eq!(
                Key::parse(&value, "window-1", false).unwrap_err(),
                "http_receipt_invalid"
            );
        }
    }
    let id = "aA0_-".repeat(25) + "abc";
    let mut value = input(&id);
    value["ownerID"] = json!(&id);
    value["windowID"] = json!(&id);
    assert_eq!(id.len(), 128);
    assert!(Key::parse(&value, &id, false).is_ok());
    assert_eq!(
        Key::parse(&input("request"), "Window-1", false).unwrap_err(),
        "http_receipt_stale"
    );
}

#[test]
fn invalid_scopes_map_to_the_stable_receipt_error() {
    for scope in [
        Value::Null,
        json!({}),
        json!({"hostID":"host","lease":"invalid"}),
        json!({"hostID":"","lease":"00000000-0000-4000-abcd-000000000001"}),
        json!({"hostID":"host","lease":"00000000-0000-4000-abcd-000000000001","extra":true}),
    ] {
        let mut value = input("request");
        value["expectedHost"] = scope;
        assert_eq!(
            Key::parse(&value, "window-1", false).unwrap_err(),
            "http_receipt_invalid"
        );
    }
}

#[test]
fn normal_reserve_bind_finish_is_one_shot_and_late_finish_is_inert() {
    let mut book = Book::default();
    let a = key("a");
    assert!(!book.current(&a, 10));
    assert_eq!(book.finish(10), None);
    assert_eq!(book.bind(&a, 10).unwrap_err(), "http_receipt_stale");
    assert!(book.reserve(&a).unwrap());
    assert!(!book.current(&a, 10));
    assert!(book.bind(&a, 10).unwrap());
    assert!(book.current(&a, 10));
    assert!(!book.current(&a, 11));
    assert_eq!(book.reserve(&a).unwrap_err(), "http_receipt_reused");
    assert_eq!(book.bind(&a, 10).unwrap_err(), "http_receipt_reused");
    assert_eq!(book.finish(10), Some(a.clone()));
    assert!(!book.current(&a, 10));
    assert_eq!(book.finish(10), None);
    assert_eq!(book.cancel(&a).unwrap(), None);
    assert_eq!(book.reserve(&a).unwrap_err(), "http_receipt_reused");
    assert_eq!(book.bind(&a, 11).unwrap_err(), "http_receipt_reused");
}

#[test]
fn cancel_before_reserve_leaves_a_tombstone_and_never_starts_or_replays() {
    let mut book = Book::default();
    let a = key("a");
    assert_eq!(book.cancel(&a).unwrap(), None);
    assert_eq!(book.cancel(&a).unwrap(), None);
    assert!(!book.bind(&a, 10).unwrap());
    assert!(!book.reserve(&a).unwrap());
    assert!(!book.bind(&a, 10).unwrap());
    assert!(!book.current(&a, 10));
    assert_eq!(book.finish(10), None);
    assert_eq!(book.reserve(&a).unwrap_err(), "http_receipt_reused");
}

#[test]
fn cancel_between_reserve_and_bind_prevents_dispatch() {
    let mut book = Book::default();
    let a = key("a");
    assert!(book.reserve(&a).unwrap());
    assert_eq!(book.cancel(&a).unwrap(), None);
    assert!(!book.bind(&a, 1).unwrap());
    assert!(!book.current(&a, 1));
    assert_eq!(book.reserve(&a).unwrap_err(), "http_receipt_reused");
}

#[test]
fn cancelling_one_running_identity_cannot_take_another_job() {
    let mut book = Book::default();
    let a = key("a");
    let b = key("b");
    for (key, ticket) in [(&a, 10), (&b, 20)] {
        assert!(book.reserve(key).unwrap());
        assert!(book.bind(key, ticket).unwrap());
    }
    assert_eq!(book.cancel(&a).unwrap(), Some(10));
    assert!(!book.current(&a, 10));
    assert!(book.current(&b, 20));
    assert_eq!(book.cancel(&a).unwrap(), None);
    assert_eq!(book.finish(10), None);
    assert_eq!(book.finish(20), Some(b));
}

#[test]
fn every_identity_component_is_required_for_reserve_bind_cancel_and_current() {
    let a = key("a");
    let mut other_owner = a.clone();
    other_owner.owner_id = "owner_b".into();
    let mut other_window = a.clone();
    other_window.window_id = "window-2".into();
    let mut other_host = a.clone();
    other_host.scope["hostID"] = json!("other");
    let mut other_lease = a.clone();
    other_lease.scope["lease"] = json!("00000000-0000-4000-abcd-000000000002");
    for state in ["pre", "reserved", "running", "finished", "cancelled"] {
        let mut book = Book::default();
        if state == "pre" {
            book.cancel(&a).unwrap();
        } else {
            book.reserve(&a).unwrap();
            if state != "reserved" {
                book.bind(&a, 10).unwrap();
            }
            if state == "finished" {
                book.finish(10);
            }
            if state == "cancelled" {
                book.cancel(&a).unwrap();
            }
        }
        for wrong in [&other_owner, &other_window, &other_host, &other_lease] {
            assert_eq!(book.reserve(wrong).unwrap_err(), "http_receipt_stale");
            assert_eq!(book.bind(wrong, 10).unwrap_err(), "http_receipt_stale");
            assert_eq!(book.cancel(wrong).unwrap_err(), "http_receipt_stale");
            assert!(!book.current(wrong, 10));
        }
        assert_eq!(book.current(&a, 10), state == "running");
        if state == "pre" {
            assert!(!book.reserve(&a).unwrap());
        }
    }
}

#[test]
fn tickets_cannot_be_reassigned_even_after_finish_or_cancel() {
    let mut book = Book::default();
    let a = key("a");
    let b = key("b");
    let c = key("c");
    book.reserve(&a).unwrap();
    book.bind(&a, 10).unwrap();
    book.reserve(&b).unwrap();
    assert_eq!(book.bind(&b, 10).unwrap_err(), "http_receipt_reused");
    assert!(book.current(&a, 10));
    book.finish(10);
    assert_eq!(book.bind(&b, 10).unwrap_err(), "http_receipt_reused");
    assert!(book.bind(&b, 20).unwrap());
    book.cancel(&b).unwrap();
    book.reserve(&c).unwrap();
    assert_eq!(book.bind(&c, 20).unwrap_err(), "http_receipt_reused");
    assert!(book.bind(&c, 30).unwrap());
    assert_eq!(book.finish(10), None);
    assert_eq!(book.finish(20), None);
    assert!(book.current(&c, 30));
}

#[test]
fn scope_retirement_does_not_erase_seen_ids_or_late_cancel_protection() {
    let mut book = Book::default();
    let a = key("a");
    book.reserve(&a).unwrap();
    book.bind(&a, 1).unwrap();
    assert_eq!(book.finish(1), Some(a.clone()));
    let mut next = a.clone();
    next.scope["lease"] = json!("00000000-0000-4000-abcd-000000000002");
    assert_eq!(book.reserve(&next).unwrap_err(), "http_receipt_stale");
    next.request_id = "new_request".into();
    book.reserve(&next).unwrap();
    book.bind(&next, 2).unwrap();
    assert_eq!(book.cancel(&a).unwrap(), None);
    assert!(book.current(&next, 2));
}

#[test]
fn lifetime_capacity_counts_pre_cancelled_cancelled_finished_and_reserved_ids() {
    let mut book = Book::default();
    for index in 0..MAX_REQUESTS {
        let a = key(&format!("request_{index}"));
        match index % 4 {
            0 => {
                book.cancel(&a).unwrap();
            }
            1 => {
                book.reserve(&a).unwrap();
                book.cancel(&a).unwrap();
            }
            2 => {
                book.reserve(&a).unwrap();
                book.bind(&a, index as u64).unwrap();
                book.finish(index as u64);
            }
            _ => {
                book.reserve(&a).unwrap();
            }
        }
    }
    let extra = key("extra");
    assert_eq!(book.reserve(&extra).unwrap_err(), "http_receipt_capacity");
    assert_eq!(book.cancel(&extra).unwrap_err(), "http_receipt_capacity");
    let pre = key("request_0");
    assert!(!book.reserve(&pre).unwrap());
    assert_eq!(book.cancel(&pre).unwrap(), None);
    let reserved = key("request_3");
    assert!(book.bind(&reserved, u64::MAX).unwrap());
    assert_eq!(book.cancel(&reserved).unwrap(), Some(u64::MAX));
    assert_eq!(book.finish(u64::MAX), None);
    assert_eq!(book.reserve(&extra).unwrap_err(), "http_receipt_capacity");
}

#[test]
fn direct_native_construction_cannot_admit_malformed_keys() {
    let mut a = key("a");
    a.request_id = "bad/id".into();
    let mut book = Book::default();
    assert_eq!(book.reserve(&a).unwrap_err(), "http_receipt_invalid");
    assert_eq!(book.bind(&a, 1).unwrap_err(), "http_receipt_invalid");
    assert_eq!(book.cancel(&a).unwrap_err(), "http_receipt_invalid");
    assert!(!book.current(&a, 1));
}
