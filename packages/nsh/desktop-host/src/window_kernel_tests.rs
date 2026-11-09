//! Two real QuickJS Engines/HostChannels; no AppKit windows, filesystem or credentials.
use super::*;
use nsh_engine::{Bundle, Engine, EngineConfig, FetchTask, HttpRequest, MountSink, Network};
use serde_json::json;
use std::{
    sync::{Arc, mpsc},
    time::Duration,
};

struct Offline;
impl Network for Offline {
    fn fetch(&self, _: HttpRequest, _: nsh_engine::FetchEvents) -> Box<dyn FetchTask> {
        panic!("window admission cannot perform network I/O")
    }
}
struct Sink;
impl MountSink for Sink {
    fn submit(&self, _: nsh_core::MountBatch) {}
}
struct Fixture {
    host: HostChannel,
    services: crate::host_services::Port,
    decisions: mpsc::Receiver<(Value, HostReply)>,
    events: mpsc::Receiver<Value>,
    replies: mpsc::Receiver<Value>,
    engine: Engine,
}
fn fixture(key: &str, vote: bool) -> Fixture {
    let host = HostChannel::default();
    host.set_params(
        json!({"windowKey":key,"vote":vote})
            .as_object()
            .unwrap()
            .clone(),
    );
    let services = crate::host_services::Port::new(Arc::new(Offline));
    let (tx, decisions) = mpsc::sync_channel(16);
    host.handle("desktop.window.closeDecision", move |mut call| {
        let value = call.take_data();
        if let Some(reply) = call.into_reply() {
            tx.try_send((value, reply)).ok().unwrap();
        }
    });
    let (tx, events) = mpsc::channel();
    host.handle("test.event", move |mut call| {
        tx.send(call.take_data()).unwrap();
    });
    let (tx, replies) = mpsc::channel();
    host.handle("test.reply", move |mut call| {
        tx.send(call.take_data()).unwrap();
    });
    let mut bundle = Bundle::source(r#"import {host} from 'nsh';
      let vote=host.params.vote;
      host.on('test.vote', value=>{vote=value;host.post('test.event',{vote});});
      host.on('test.ping', value=>host.post('test.event',{ping:value,key:host.params.windowKey}));
      host.on('desktop.window.closeRequested', async event=>{
        host.post('test.event',event);
        try { const result=await host.call('desktop.window.closeDecision',{ticket:event.ticket,approved:vote});host.post('test.reply',{ok:result,ticket:event.ticket}); }
        catch {host.post('test.reply',{cancelled:true,ticket:event.ticket});}
      });
      host.post('test.event',{ready:true,key:host.params.windowKey});"#.into());
    bundle.policy.declared =
        Some(nsh_core::access::Capabilities::from_json(&json!({"host":true})).unwrap());
    let mut config = EngineConfig::new(bundle);
    config.host = host.clone();
    let engine = Engine::start(config, || nsh_core::ApproxTextEngine, Sink).unwrap();
    assert_eq!(
        events.recv_timeout(Duration::from_secs(5)).unwrap(),
        json!({"ready":true,"key":key})
    );
    Fixture {
        host,
        services,
        decisions,
        events,
        replies,
        engine,
    }
}
fn receive(rx: &mpsc::Receiver<Value>) -> Value {
    rx.recv_timeout(Duration::from_secs(5)).unwrap()
}
fn vote(catalog: &mut Catalog, id: usize, fixture: &Fixture, now: Instant) -> Value {
    let event = receive(&fixture.events);
    let (value, reply) = fixture
        .decisions
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    catalog.decide(id, &value, reply, now);
    event
}

#[test]
fn native_writer_veto_overrides_all_ts_quit_votes_without_fencing_either_window() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let now = Instant::now();
    let a = fixture("main-a", true);
    let b = fixture("main-b", true);
    let ready = Arc::new(AtomicBool::new(false));
    let native = ready.clone();
    a.services
        .install_writer_close_guard(Arc::new(move || native.load(Ordering::Acquire)))
        .unwrap();
    let mut catalog = Catalog::default();
    catalog
        .insert(11, a.host.clone(), a.services.clone())
        .unwrap();
    catalog
        .insert(22, b.host.clone(), b.services.clone())
        .unwrap();
    catalog.request_quit(now);
    vote(&mut catalog, 11, &a, now);
    vote(&mut catalog, 22, &b, now);
    assert_eq!(receive(&a.replies)["cancelled"], true);
    assert_eq!(receive(&b.replies)["cancelled"], true);
    assert!(a.services.live() && b.services.live());
    assert!(!catalog.quitting());
    assert!(!a.services.final_close_approved() && !b.services.final_close_approved());
    ready.store(true, Ordering::Release);
    catalog.request_quit(now);
    vote(&mut catalog, 11, &a, now);
    vote(&mut catalog, 22, &b, now);
    assert_eq!(receive(&a.replies)["ok"], true);
    assert_eq!(receive(&b.replies)["ok"], true);
    assert!(a.services.final_close_approved() && b.services.final_close_approved());
    assert!(catalog.quitting());
}

#[test]
fn closing_one_engine_keeps_the_other_channel_events_and_native_owner_live() {
    let now = Instant::now();
    let a = fixture("main-a", true);
    let b = fixture("main-b", true);
    assert_ne!(
        a.services.window_id().unwrap(),
        b.services.window_id().unwrap()
    );
    let mut catalog = Catalog::default();
    catalog
        .insert(11, a.host.clone(), a.services.clone())
        .unwrap();
    catalog
        .insert(22, b.host.clone(), b.services.clone())
        .unwrap();
    catalog.request_close(11, now);
    let event = vote(&mut catalog, 11, &a, now);
    assert_eq!(event["reason"], "close");
    assert_eq!(receive(&a.replies)["ok"], true);
    assert!(catalog.closing(11));
    assert!(!catalog.closing(22));
    assert!(!catalog.quitting());
    assert!(b.events.try_recv().is_err());
    catalog.remove(11);
    drop(a.engine);
    assert!(!a.services.live());
    assert!(b.services.live());
    b.host.send("test.ping", json!(50)).unwrap();
    assert_eq!(receive(&b.events), json!({"ping":50,"key":"main-b"}));
    catalog.decide(
        22,
        &json!({"ticket":event["ticket"],"approved":true}),
        HostReply::default(),
        now,
    );
    assert!(!catalog.closing(22));
}

#[test]
fn quit_holds_all_approved_promises_until_every_window_grants_and_veto_unlocks_without_teardown() {
    let now = Instant::now();
    let a = fixture("main-a", true);
    let b = fixture("main-b", false);
    let mut catalog = Catalog::default();
    catalog
        .insert(11, a.host.clone(), a.services.clone())
        .unwrap();
    catalog
        .insert(22, b.host.clone(), b.services.clone())
        .unwrap();
    catalog.request_quit(now);
    let first = vote(&mut catalog, 11, &a, now);
    assert_eq!(first["reason"], "quit");
    assert!(a.replies.try_recv().is_err());
    assert!(!catalog.closing(11));
    vote(&mut catalog, 22, &b, now);
    assert_eq!(receive(&a.replies)["cancelled"], true);
    assert_eq!(receive(&b.replies)["ok"], true);
    assert!(!catalog.quitting());
    assert!(!catalog.closing(11));
    assert!(!catalog.closing(22));
    assert!(a.services.live() && b.services.live());
    b.host.send("test.vote", json!(true)).unwrap();
    assert_eq!(receive(&b.events), json!({"vote":true}));
    catalog.request_quit(now);
    let retry = vote(&mut catalog, 11, &a, now);
    assert_ne!(first["ticket"], retry["ticket"]);
    assert!(a.replies.try_recv().is_err());
    vote(&mut catalog, 22, &b, now);
    assert_eq!(receive(&a.replies)["ok"], true);
    assert_eq!(receive(&b.replies)["ok"], true);
    assert!(catalog.quitting() && catalog.closing(11) && catalog.closing(22));
    assert!(
        !a.services.live() && !b.services.live(),
        "all authority is fenced before the first platform teardown"
    );
}

#[test]
fn quit_timeout_and_late_window_decision_cannot_close_a_retry_or_the_other_window() {
    let now = Instant::now();
    let a = fixture("main-a", true);
    let b = fixture("main-b", true);
    let mut catalog = Catalog::default();
    catalog
        .insert(11, a.host.clone(), a.services.clone())
        .unwrap();
    catalog
        .insert(22, b.host.clone(), b.services.clone())
        .unwrap();
    catalog.request_quit(now);
    vote(&mut catalog, 11, &a, now);
    let late = receive(&b.events);
    let (value, reply) = b.decisions.recv_timeout(Duration::from_secs(5)).unwrap();
    catalog.expire(now + TIMEOUT);
    assert_eq!(receive(&a.replies)["cancelled"], true);
    catalog.request_quit(now + TIMEOUT);
    catalog.decide(22, &value, reply, now + TIMEOUT);
    assert_eq!(receive(&b.replies)["cancelled"], true);
    let retry = vote(&mut catalog, 11, &a, now + TIMEOUT);
    assert_ne!(late["ticket"], retry["ticket"]);
    assert!(!catalog.closing(11) && !catalog.closing(22));
    catalog.cancel_quit();
    assert_eq!(receive(&a.replies)["cancelled"], true);
    assert!(a.services.live() && b.services.live());
}

#[test]
fn duplicate_native_owners_and_ninth_main_are_refused_without_retiring_any_existing_window() {
    let mut catalog = Catalog::default();
    let first = crate::host_services::Port::new(Arc::new(Offline));
    catalog
        .insert(1, HostChannel::default(), first.clone())
        .unwrap();
    assert!(
        catalog
            .insert(2, HostChannel::default(), first.clone())
            .is_err()
    );
    for id in 2..=crate::window_state::MAX_WINDOWS {
        catalog
            .insert(
                id,
                HostChannel::default(),
                crate::host_services::Port::new(Arc::new(Offline)),
            )
            .unwrap();
    }
    assert!(
        catalog
            .insert(
                9,
                HostChannel::default(),
                crate::host_services::Port::new(Arc::new(Offline))
            )
            .is_err()
    );
    assert!(first.live());
}

fn capture(catalog: &mut Catalog, id: usize, key: &str, epoch: u64) {
    let services = catalog.services(id).unwrap();
    services.publish(
        &json!({"hostID":"fixture-host","lease":format!("lease-{epoch}")}),
        "https://fixture.invalid",
        "fixture-native-token",
        "fixture-authorization",
        false,
    );
    let captured = services
        .reader()
        .window_record(key, crate::window_persistence::tests::record(key).geometry);
    catalog.update_capture(id, captured);
}
fn drive_until(catalog: &mut Catalog, mut done: impl FnMut(&Catalog) -> bool) {
    crate::window_persistence::tests::wait(|| {
        catalog.drive_persistence();
        done(catalog)
    });
}

#[test]
fn real_disk_quit_barrier_holds_both_engines_until_ack_and_fences_all_before_teardown() {
    use crate::window_persistence::tests::{DiskFixture, wait};
    use std::sync::atomic::Ordering;
    let disk = DiskFixture::new(None);
    let a = fixture("primary", true);
    let b = fixture("secondary", true);
    let mut catalog = Catalog::default();
    catalog.install_persistence(disk.port());
    catalog
        .insert(22, a.host.clone(), a.services.clone())
        .unwrap();
    catalog
        .insert(11, b.host.clone(), b.services.clone())
        .unwrap();
    capture(&mut catalog, 22, "primary", 1);
    capture(&mut catalog, 11, "secondary", 1);
    disk.mode.store(3, Ordering::Release);
    let now = Instant::now();
    catalog.request_quit(now);
    vote(&mut catalog, 22, &a, now);
    vote(&mut catalog, 11, &b, now);
    catalog.drive_persistence();
    wait(|| disk.entered.load(Ordering::Acquire));
    assert!(!catalog.quitting() && !catalog.closing(22));
    assert!(a.services.live() && b.services.live());
    assert!(a.replies.try_recv().is_err() && b.replies.try_recv().is_err());
    assert!(
        catalog
            .insert(33, HostChannel::default(), b.services.clone())
            .is_err()
    );
    disk.release.store(true, Ordering::Release);
    drive_until(&mut catalog, |c| c.quitting());
    assert_eq!(receive(&a.replies)["ok"], true);
    assert_eq!(receive(&b.replies)["ok"], true);
    assert!(!a.services.live() && !b.services.live());
    let saved = disk.port().status().unwrap().snapshot.unwrap();
    assert_eq!(
        saved
            .windows
            .iter()
            .map(|w| w.window_key.as_str())
            .collect::<Vec<_>>(),
        ["primary", "secondary"],
        "registry order, not HWND order"
    );
    catalog.remove(22);
    catalog.remove(11);
    assert_eq!(
        disk.port().status().unwrap().snapshot.unwrap(),
        saved,
        "quit never persists shrinking catalog"
    );
}

#[test]
fn close_disk_failure_or_late_epoch_never_tears_down_and_explicit_retry_commits_remaining_catalog()
{
    use crate::window_persistence::tests::{DiskFixture, wait};
    use std::sync::atomic::Ordering;
    let disk = DiskFixture::new(None);
    let a = fixture("primary", true);
    let b = fixture("secondary", true);
    let mut catalog = Catalog::default();
    catalog.install_persistence(disk.port());
    catalog
        .insert(11, a.host.clone(), a.services.clone())
        .unwrap();
    catalog
        .insert(22, b.host.clone(), b.services.clone())
        .unwrap();
    capture(&mut catalog, 11, "primary", 1);
    capture(&mut catalog, 22, "secondary", 1);
    let now = Instant::now();
    disk.mode.store(1, Ordering::Release);
    catalog.request_close(11, now);
    vote(&mut catalog, 11, &a, now);
    drive_until(&mut catalog, |c| c.commit.is_none());
    assert_eq!(receive(&a.replies)["cancelled"], true);
    assert!(!catalog.closing(11) && a.services.live() && b.services.live());
    disk.mode.store(3, Ordering::Release);
    catalog.request_close(11, now);
    vote(&mut catalog, 11, &a, now);
    catalog.drive_persistence();
    wait(|| disk.entered.load(Ordering::Acquire));
    // Same stable Host/geometry after a lease retirement is NOT the captured authority.
    a.services.invalidate();
    a.services.publish(
        &json!({"hostID":"fixture-host","lease":"lease-1"}),
        "https://fixture.invalid",
        "fixture-native-token",
        "fixture-authorization",
        false,
    );
    disk.release.store(true, Ordering::Release);
    drive_until(&mut catalog, |c| c.commit.is_none());
    assert_eq!(receive(&a.replies)["cancelled"], true);
    assert!(!catalog.closing(11) && a.services.live());
    capture(&mut catalog, 11, "primary", 2);
    catalog.request_close(11, now);
    vote(&mut catalog, 11, &a, now);
    drive_until(&mut catalog, |c| c.closing(11));
    assert_eq!(receive(&a.replies)["ok"], true);
    catalog.remove(11);
    wait(|| {
        disk.port()
            .status()
            .unwrap()
            .snapshot
            .is_some_and(|s| s.windows.len() == 1 && s.windows[0].window_key == "secondary")
    });
    assert!(b.services.live());
    b.host.send("test.ping", json!(99)).unwrap();
    assert_eq!(receive(&b.events)["ping"], 99);
}

#[test]
fn pending_disk_close_timeout_rejects_old_reply_and_incomplete_catalog_is_never_filtered() {
    use crate::window_persistence::tests::{DiskFixture, wait};
    use std::sync::atomic::Ordering;
    let disk = DiskFixture::new(None);
    let a = fixture("primary", true);
    let b = fixture("secondary", true);
    let mut catalog = Catalog::default();
    catalog.install_persistence(disk.port());
    catalog
        .insert(11, a.host.clone(), a.services.clone())
        .unwrap();
    catalog
        .insert(22, b.host.clone(), b.services.clone())
        .unwrap();
    capture(&mut catalog, 11, "primary", 1);
    catalog.update_capture(
        22,
        Ok(crate::host_services::WindowCapture {
            record: None,
            epoch: 1,
        }),
    );
    let now = Instant::now();
    catalog.request_quit(now);
    vote(&mut catalog, 11, &a, now);
    vote(&mut catalog, 22, &b, now);
    catalog.drive_persistence();
    assert_eq!(receive(&a.replies)["cancelled"], true);
    assert_eq!(receive(&b.replies)["cancelled"], true);
    assert_eq!(disk.writes.load(Ordering::Acquire), 0);
    capture(&mut catalog, 22, "secondary", 1);
    disk.mode.store(3, Ordering::Release);
    catalog.request_close(11, now);
    vote(&mut catalog, 11, &a, now);
    catalog.drive_persistence();
    wait(|| disk.entered.load(Ordering::Acquire));
    catalog.expire(now + TIMEOUT);
    assert_eq!(receive(&a.replies)["cancelled"], true);
    disk.release.store(true, Ordering::Release);
    wait(|| disk.port().status().unwrap().snapshot.is_some());
    catalog.drive_persistence();
    assert!(!catalog.closing(11) && a.services.live() && b.services.live());
}
