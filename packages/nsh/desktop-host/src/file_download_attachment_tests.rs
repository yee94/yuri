//! Same HostChannel/Network/production private Stage; no OS chooser, sockets or user data.
use super::tests::{Sink, Task, Temp, capture, real_targets, scope};
use super::*;
use nsh_core::platform::{FetchEvent, HttpHead, HttpRequest};
use nsh_engine::{Bundle, Engine, EngineConfig};
use std::{fs, time::Duration};

const BYTES: &[u8] = &[0, 255, 13, 10, 128, 0];
fn descriptor() -> Value {
    let mut hash = hash::Hash::new().unwrap();
    hash.update(BYTES).unwrap();
    json!({"type":"file","assistantID":"bot.A-1","attachmentID":"att_1","sha256":hash.finish().unwrap(),
        "size":6,"mime":"application/octet-stream","filename":"附件.bin"})
}
#[derive(Clone, Default)]
struct Options {
    fail_first: bool,
    bad_resume: bool,
    mime: Option<String>,
    length: Option<u64>,
    encoding: bool,
    redirect: bool,
    status: Option<u16>,
    corrupt: bool,
    short: bool,
    duplicate_mime: bool,
}
struct Net {
    requests: Arc<Mutex<Vec<HttpRequest>>>,
    options: Options,
}
impl Network for Net {
    fn fetch(
        &self,
        request: HttpRequest,
        mut events: nsh_engine::FetchEvents,
    ) -> Box<dyn nsh_engine::FetchTask> {
        let call = {
            let mut requests = self.requests.lock().unwrap();
            requests.push(request.clone());
            requests.len()
        };
        assert_eq!(request.method, "GET");
        assert_eq!(
            request.url,
            "https://synthetic.invalid/api/yuri/assistants/bot.A-1/contact/attachments/att_1"
        );
        assert!(!request.follow_redirects);
        assert!(matches!(request.body, nsh_core::platform::HttpBody::Empty));
        assert!(
            request
                .headers
                .contains(&("Authorization".into(), "Bearer synthetic-token".into()))
        );
        assert!(
            !request
                .headers
                .iter()
                .any(|(k, _)| k.eq_ignore_ascii_case("cookie"))
        );
        let resume = call > 1 && self.options.fail_first;
        let mut headers = vec![
            (
                "Content-Type".into(),
                self.options
                    .mime
                    .clone()
                    .unwrap_or("application/octet-stream".into()),
            ),
            (
                "Content-Length".into(),
                self.options
                    .length
                    .unwrap_or(if resume { 3 } else { 6 })
                    .to_string(),
            ),
            (
                "ETag".into(),
                if resume && self.options.bad_resume {
                    "\"changed\""
                } else {
                    "\"exact\""
                }
                .into(),
            ),
            // This header is deliberately NOT evidence: corrupt bytes must fail.
            (
                "X-Content-SHA256".into(),
                descriptor()["sha256"].as_str().unwrap().into(),
            ),
        ];
        if resume {
            headers.push(("Content-Range".into(), "bytes 3-5/6".into()));
        }
        if self.options.encoding {
            headers.push(("Content-Encoding".into(), "gzip".into()));
        }
        if self.options.duplicate_mime {
            headers.push(("content-type".into(), "text/html".into()));
        }
        events(FetchEvent::Head(HttpHead {
            status: self
                .options
                .status
                .unwrap_or(if resume { 206 } else { 200 }),
            url: request.url,
            redirected: self.options.redirect,
            headers,
            ..Default::default()
        }));
        if self.options.fail_first && call == 1 {
            events(FetchEvent::Data(BYTES[..3].into()));
            events(FetchEvent::Failed("synthetic disconnect".into()));
        } else {
            let mut bytes = if resume {
                BYTES[3..].to_vec()
            } else {
                BYTES.to_vec()
            };
            if self.options.corrupt {
                bytes[0] ^= 1;
            }
            if self.options.short {
                bytes.pop();
            }
            events(FetchEvent::Data(bytes));
            events(FetchEvent::End);
        }
        Box::new(Task)
    }
}
fn assistant_job(
    root: &Path,
    options: Options,
    unknown: bool,
    fail_seal: bool,
) -> super::tests::JobFixture {
    let (mut job, book, commits, requests) = super::tests::job(root, false, false);
    job.file = Source::AssistantAttachment(
        transport::attachment::Attachment::parse(&descriptor()).unwrap(),
    );
    job.targets = real_targets(commits.clone(), unknown, fail_seal);
    job.network = Arc::new(Net {
        requests: requests.clone(),
        options,
    });
    book.lock()
        .unwrap()
        .rows
        .get_mut("request")
        .unwrap()
        .attachment = Some(descriptor());
    (job, book, commits, requests)
}
#[test]
fn canonical_native_get_checks_actual_hash_and_size_before_private_stage_commit() {
    let temp = Temp::new();
    let dest = temp.0.join("chosen.bin");
    fs::write(&dest, b"prior").unwrap();
    let (job, book, commits, requests) = assistant_job(&temp.0, Options::default(), false, false);
    job.write(&dest);
    assert_eq!(fs::read(&dest).unwrap(), BYTES);
    let receipt = snapshot("request", "window", &book.lock().unwrap().rows["request"]);
    assert_eq!(receipt["state"], "saved");
    assert_eq!(receipt["attachment"], descriptor());
    assert_eq!(receipt["source"], "assistantAttachment");
    for field in ["bytes", "token", "path", "directory", "etag"] {
        assert!(receipt.get(field).is_none());
    }
    assert_eq!(commits.load(Ordering::Acquire), 1);
    assert_eq!(requests.lock().unwrap().len(), 1);
}
#[test]
fn hash_size_mime_encoding_status_redirect_and_duplicate_headers_preserve_prior() {
    for options in [
        Options {
            corrupt: true,
            ..Default::default()
        },
        Options {
            short: true,
            ..Default::default()
        },
        Options {
            length: Some(5),
            ..Default::default()
        },
        Options {
            length: Some(7),
            ..Default::default()
        },
        Options {
            mime: Some("text/html".into()),
            ..Default::default()
        },
        Options {
            encoding: true,
            ..Default::default()
        },
        Options {
            redirect: true,
            ..Default::default()
        },
        Options {
            status: Some(302),
            ..Default::default()
        },
        Options {
            status: Some(401),
            ..Default::default()
        },
        Options {
            duplicate_mime: true,
            ..Default::default()
        },
    ] {
        let temp = Temp::new();
        let dest = temp.0.join("chosen.bin");
        fs::write(&dest, b"prior").unwrap();
        let (job, book, commits, _) = assistant_job(&temp.0, options.clone(), false, false);
        job.write(&dest);
        assert_eq!(fs::read(&dest).unwrap(), b"prior");
        assert_eq!(commits.load(Ordering::Acquire), 0);
        let book = book.lock().unwrap();
        let row = &book.rows["request"];
        assert_eq!(row.state, "error");
        if options.corrupt {
            assert_eq!(row.error.as_deref(), Some("download_integrity_mismatch"));
            assert!(!resumable(row));
        }
    }
}
#[test]
fn retained_prefix_hash_survives_explicit_range_resume_but_changed_validator_cannot_append() {
    for bad_resume in [false, true] {
        let temp = Temp::new();
        let dest = temp.0.join("chosen.bin");
        fs::write(&dest, b"prior").unwrap();
        let (job, book, commits, requests) = assistant_job(
            &temp.0,
            Options {
                fail_first: true,
                bad_resume,
                ..Default::default()
            },
            false,
            false,
        );
        let network = job.network.clone();
        let cancel = job.cancel.clone();
        let stop = job.stop.clone();
        job.write(&dest);
        assert_eq!(fs::read(&dest).unwrap(), b"prior");
        let transfer = {
            let mut b = book.lock().unwrap();
            let row = b.rows.get_mut("request").unwrap();
            assert_eq!(row.checkpoint.received, 3);
            assert!(resumable(row));
            row.transfer.take().unwrap()
        };
        run("request", transfer, network, book.clone(), cancel, stop);
        assert_eq!(commits.load(Ordering::Acquire), usize::from(!bad_resume));
        assert_eq!(
            fs::read(&dest).unwrap(),
            if bad_resume {
                b"prior".as_slice()
            } else {
                BYTES
            }
        );
        let req = requests.lock().unwrap();
        assert_eq!(req.len(), 2);
        assert!(
            req[1]
                .headers
                .contains(&("Range".into(), "bytes=3-".into()))
        );
        assert!(
            req[1]
                .headers
                .contains(&("If-Range".into(), "\"exact\"".into()))
        );
    }
}
#[test]
fn complete_verified_body_retries_only_seal_and_unknown_only_inspects_original_stage() {
    for unknown in [false, true] {
        let temp = Temp::new();
        let dest = temp.0.join("chosen.bin");
        fs::write(&dest, b"prior").unwrap();
        let (job, book, commits, requests) =
            assistant_job(&temp.0, Options::default(), unknown, !unknown);
        let network = job.network.clone();
        let cancel = job.cancel.clone();
        let stop = job.stop.clone();
        job.write(&dest);
        let transfer = {
            let mut b = book.lock().unwrap();
            let row = b.rows.get_mut("request").unwrap();
            assert_eq!(row.state, if unknown { "unknown" } else { "error" });
            assert_eq!(resumable(row), !unknown);
            row.transfer.take().unwrap()
        };
        if unknown {
            inspect("request", transfer, book.clone(), cancel, stop);
        } else {
            run("request", transfer, network, book.clone(), cancel, stop);
        }
        assert_eq!(book.lock().unwrap().rows["request"].state, "saved");
        assert_eq!(fs::read(&dest).unwrap(), BYTES);
        assert_eq!(requests.lock().unwrap().len(), 1);
        assert_eq!(commits.load(Ordering::Acquire), 1);
    }
}
#[test]
fn attachment_cancel_and_retired_capture_never_replace_prior_or_fetch_late_job() {
    for cancel_first in [true, false] {
        let temp = Temp::new();
        let dest = temp.0.join("chosen.bin");
        fs::write(&dest, b"prior").unwrap();
        let (mut job, book, commits, requests) =
            assistant_job(&temp.0, Options::default(), false, false);
        if cancel_first {
            job.cancel.store(true, Ordering::Release);
        } else {
            let active = Arc::new(AtomicBool::new(true));
            job.captured = Some(capture(active.clone())(&scope(), "window").unwrap());
            active.store(false, Ordering::Release);
        }
        job.write(&dest);
        assert_eq!(fs::read(&dest).unwrap(), b"prior");
        assert_eq!(commits.load(Ordering::Acquire), 0);
        assert!(requests.lock().unwrap().is_empty());
        assert_ne!(book.lock().unwrap().rows["request"].state, "saved");
    }
}
#[test]
fn simultaneous_native_owners_keep_their_own_source_hash_and_destination() {
    let a = Temp::new();
    let b = Temp::new();
    let (first, first_book, _, _) = assistant_job(&a.0, Options::default(), false, false);
    let (second, second_book, _, _) = assistant_job(
        &b.0,
        Options {
            corrupt: true,
            ..Default::default()
        },
        false,
        false,
    );
    let first_dest = a.0.join("first");
    let second_dest = b.0.join("second");
    fs::write(&second_dest, b"second-prior").unwrap();
    std::thread::scope(|s| {
        s.spawn(|| first.write(&first_dest));
        s.spawn(|| second.write(&second_dest));
    });
    assert_eq!(fs::read(first_dest).unwrap(), BYTES);
    assert_eq!(fs::read(second_dest).unwrap(), b"second-prior");
    assert_eq!(first_book.lock().unwrap().rows["request"].state, "saved");
    assert_eq!(second_book.lock().unwrap().rows["request"].state, "error");
}
#[test]
fn partial_append_failure_rewinds_unhashed_bytes_then_explicit_retry_hashes_only_confirmed_prefix()
{
    struct FailingAppend {
        inner: Box<dyn Target>,
        first: bool,
    }
    impl Target for FailingAppend {
        fn append(&mut self, bytes: &[u8]) -> Result<()> {
            if self.first {
                self.first = false;
                self.inner.append(&bytes[..2])?;
                return Err("synthetic_partial_append".into());
            }
            self.inner.append(bytes)
        }
        fn rewind(&mut self, n: u64) -> Result<()> {
            self.inner.rewind(n)
        }
        fn seal(&mut self) -> Result<()> {
            self.inner.seal()
        }
        fn commit(&mut self) -> Commit {
            self.inner.commit()
        }
    }
    let temp = Temp::new();
    let dest = temp.0.join("chosen.bin");
    fs::write(&dest, b"prior").unwrap();
    let (mut job, book, commits, requests) =
        assistant_job(&temp.0, Options::default(), false, false);
    let factory = job.targets.clone();
    job.targets = Arc::new(move |selected| {
        Ok(Box::new(FailingAppend {
            inner: factory(selected)?,
            first: true,
        }))
    });
    let network = job.network.clone();
    let cancel = job.cancel.clone();
    let stop = job.stop.clone();
    job.write(&dest);
    assert_eq!(fs::read(&dest).unwrap(), b"prior");
    let transfer = {
        let mut b = book.lock().unwrap();
        let row = b.rows.get_mut("request").unwrap();
        assert_eq!(row.checkpoint.received, 0);
        assert!(resumable(row));
        row.transfer.take().unwrap()
    };
    run("request", transfer, network, book.clone(), cancel, stop);
    assert_eq!(book.lock().unwrap().rows["request"].state, "saved");
    assert_eq!(fs::read(&dest).unwrap(), BYTES);
    assert_eq!(commits.load(Ordering::Acquire), 1);
    assert_eq!(requests.lock().unwrap().len(), 2);
}
#[test]
fn cancellation_after_native_append_fences_queued_end_and_hash_commit() {
    struct CancellingAppend {
        inner: Box<dyn Target>,
        cancel: Arc<AtomicBool>,
    }
    impl Target for CancellingAppend {
        fn append(&mut self, bytes: &[u8]) -> Result<()> {
            self.inner.append(bytes)?;
            self.cancel.store(true, Ordering::Release);
            Ok(())
        }
        fn rewind(&mut self, n: u64) -> Result<()> {
            self.inner.rewind(n)
        }
        fn seal(&mut self) -> Result<()> {
            panic!("cancelled attachment must not seal")
        }
        fn commit(&mut self) -> Commit {
            panic!("cancelled attachment must not commit")
        }
    }
    let temp = Temp::new();
    let dest = temp.0.join("chosen.bin");
    fs::write(&dest, b"prior").unwrap();
    let (mut job, book, commits, requests) =
        assistant_job(&temp.0, Options::default(), false, false);
    let factory = job.targets.clone();
    let cancel = job.cancel.clone();
    job.targets = Arc::new(move |selected| {
        Ok(Box::new(CancellingAppend {
            inner: factory(selected)?,
            cancel: cancel.clone(),
        }))
    });
    job.write(&dest);
    assert_eq!(book.lock().unwrap().rows["request"].state, "cancelled");
    assert_eq!(fs::read(&dest).unwrap(), b"prior");
    assert_eq!(commits.load(Ordering::Acquire), 0);
    assert_eq!(requests.lock().unwrap().len(), 1);
    assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 1);
}
#[test]
fn exact_hostchannel_source_capability_schema_owner_receipt_and_dialog_slot() {
    let temp = Temp::new();
    let dest = temp.0.join("chosen.bin");
    fs::write(&dest, b"prior").unwrap();
    let host = HostChannel::default();
    let (port, inbox) = channel();
    let inbox = Arc::new(Mutex::new(inbox));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let owner = install(
        &host,
        "window",
        Arc::new(Net {
            requests: requests.clone(),
            options: Options::default(),
        }),
        capture(Arc::new(AtomicBool::new(true))),
        port,
    )
    .unwrap();
    let (tx, rx) = mpsc::channel();
    let jobs = inbox.clone();
    let selected = dest.clone();
    host.handle("test.consume", move |call| {
        let job = jobs.lock().unwrap().try_recv().unwrap();
        let selected = selected.clone();
        let reply = call.into_reply().unwrap();
        std::thread::spawn(move || {
            job.write(&selected);
            reply.resolve(json!(true));
        });
    });
    host.handle("test.result", move |mut call| {
        tx.send(call.take_data()).unwrap();
    });
    let source = format!(
        r#"import {{host}} from 'nsh';(async()=>{{
        const check=(v,m)=>{{if(!v)throw Error(m);}};
        const reject=async(v)=>{{let failed=false;try{{await host.call('desktop.files.download.save',v);}}catch{{failed=true;}}check(failed,'must reject');}};
        const old=await host.call('desktop.files.download.capabilities',{{}});
        check(Object.keys(old).sort().join(',')==='maxBytes,save,version,windowID','legacy capability unchanged');
        const cap=await host.call('desktop.files.download.capabilities',{{source:'assistantAttachment'}});
        check(cap.assistantAttachment.supported===true&&cap.assistantAttachment.integrity==='sha256'&&cap.assistantAttachment.maxBytes===26214400,'explicit capability');
        const identity={{ownerID:'owner',requestID:'receipt',windowID:'window',expectedHost:{scope}}};
        const attachment={descriptor};const input={{...identity,source:'assistantAttachment',attachment}};
        for(const bad of [{{...input,path:'/workspace/a'}},{{...input,directory:'/workspace'}},{{...input,url:'https://evil.invalid'}},
            {{...input,source:'file'}},{{...identity,attachment}},{{...input,windowID:'another'}},
            ...['../bot','%61','a/b','a?x',' a','a\\b','é','_a'].map(id=>({{...input,attachment:{{...attachment,assistantID:id}}}})),
            ...['../att','a/b','%61'].map(id=>({{...input,attachment:{{...attachment,attachmentID:id}}}})),
            ...[0,26214401,-1,1.2].map(size=>({{...input,attachment:{{...attachment,size}}}})),
            {{...input,attachment:{{...attachment,sha256:'0'}}}},{{...input,attachment:{{...attachment,filename:'../file'}}}},
            {{...input,attachment:{{...attachment,mime:'text/plain;evil'}}}},{{...input,attachment:{{...attachment,path:'/workspace/x'}}}}])await reject(bad);
        const receipt=await host.call('desktop.files.download.save',input);
        check(receipt.state==='selecting'&&JSON.stringify(receipt.attachment)===JSON.stringify(attachment),'exact immutable receipt');
        await reject({{...input,attachment:{{...attachment,assistantID:'bot.B'}}}});
        await reject({{...input,ownerID:'other',requestID:'other'}});
        for(const bad of [{{...identity,ownerID:'other'}},{{...identity,expectedHost:{{...identity.expectedHost,hostID:'other'}}}},
            {{...identity,attachment:{{...attachment,assistantID:'bot.B'}}}}]){{let failed=false;try{{await host.call('desktop.files.download.status',bad);}}catch{{failed=true;}}check(failed,'receipt authority');}}
        const cancelled=await host.call('desktop.files.download.cancel',identity);check(cancelled.state==='cancelled','cancel queued slot');
        let failed=false;try{{await host.call('desktop.files.download.resume',identity);}}catch{{failed=true;}}check(failed,'no cancelled resume');
        await host.call('test.consume',{{}});
        const next={{...identity,requestID:'next'}};
        const original=JSON.stringify(attachment);
        await host.call('desktop.files.download.save',{{...next,source:'assistantAttachment',attachment}});
        attachment.assistantID='bot.B';attachment.sha256='0'.repeat(64);
        await host.call('test.consume',{{}});
        const saved=await host.call('desktop.files.download.status',next);
        check(saved.state==='saved'&&saved.received===6&&saved.total===6,'native commit');
        check(JSON.stringify(saved.attachment)===original,'input mutation cannot change captured source');
        check(!('bytes' in saved)&&!('path' in saved)&&!('token' in saved),'no JSON bytes or destination');
        host.post('test.result',{{ok:true}});
    }})().catch(error=>host.post('test.result',{{error:String(error)}}));"#,
        scope = scope(),
        descriptor = descriptor()
    );
    let mut bundle = Bundle::source(source);
    bundle.policy.declared =
        Some(nsh_core::access::Capabilities::from_json(&json!({"host":true})).unwrap());
    let mut config = EngineConfig::new(bundle);
    config.host = host;
    let engine = Engine::start(config, || nsh_core::ApproxTextEngine, Sink).unwrap();
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(10)).unwrap(),
        json!({"ok":true})
    );
    assert!(inbox.lock().unwrap().try_recv().is_none());
    assert_eq!(requests.lock().unwrap().len(), 1);
    assert_eq!(fs::read(&dest).unwrap(), BYTES);
    drop(engine);
    drop(owner);
}
