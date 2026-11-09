//! Native-only publication of the connection actor's committed authority to owned services.
//! No independent Vault, JS credential API, or fallback to another Host.
use crate::{
    browser_view, desktop_tab, diagnostics, documents, file_download, file_journal, notifications,
    policy::{self, Result},
    terminal_host, terminal_transport, terminal_viewport,
};
use nsh_engine::{HostChannel, Network};
use serde_json::Value;
use std::sync::{
    Arc, Mutex, OnceLock, Weak,
    atomic::{AtomicBool, Ordering},
};

#[derive(Clone)]
pub(crate) struct Port {
    writer_close: Arc<OnceLock<Arc<dyn Fn() -> bool + Send + Sync>>>,
    final_close: Arc<AtomicBool>,
    admission: Arc<OnceLock<Arc<AtomicBool>>>,
    browser: browser_view::Port,
    state: Arc<Mutex<State>>,
    network: Arc<dyn Network>,
    notifications: Arc<OnceLock<Arc<notifications::Owner>>>,
    notification_identity: Arc<Mutex<Option<notifications::Identity>>>,
}
#[derive(Clone)]
pub(crate) struct Reader(Weak<Mutex<State>>);
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct WindowCapture {
    pub record: Option<crate::window_state::MainWindow>,
    pub epoch: u64,
}
#[derive(Clone)]
struct Selected {
    scope: Value,
    origin: String,
    token: String,
    authorization: String,
    loopback: bool,
}
struct Terminal {
    registration: terminal_viewport::Registration,
    owner: Arc<terminal_host::Owner>,
}
struct State {
    live: bool,
    selected: Option<Selected>,
    terminal: Option<Terminal>,
    documents: Option<documents::Owner>,
    diagnostics: Option<diagnostics::Owner>,
    window_id: Option<String>,
    runtime_suspended: bool,
    file_journal: Option<file_journal::Owner>,
    journal_retirement: Option<file_journal::Retirement>,
    file_download: Option<file_download::Owner>,
    download_epoch: u64,
    tabs: Option<desktop_tab::Registration>,
    ssh: Option<crate::native_ssh_bridge::Control>,
    ssh_owned: bool,
}
impl Reader {
    pub fn window_capture_current(&self, captured: &WindowCapture) -> bool {
        self.0.upgrade().is_some_and(|state| {
            state.lock().is_ok_and(|state| {
                state.live
                    && !state.runtime_suspended
                    && state.download_epoch == captured.epoch
                    && match (&state.selected, &captured.record) {
                        (None, None) => true,
                        (Some(selected), Some(record)) => {
                            selected.scope["hostID"].as_str() == Some(record.connection_id.as_str())
                        }
                        _ => false,
                    }
            })
        })
    }
    pub fn window_record(
        &self,
        key: &str,
        geometry: crate::window_geometry::Geometry,
    ) -> Result<WindowCapture> {
        let state = self.0.upgrade().ok_or("window_authority_unavailable")?;
        let state = state.lock().map_err(|_| "window_authority_unavailable")?;
        if !state.live || state.runtime_suspended {
            return Err("window_authority_unavailable".into());
        }
        let Some(selected) = &state.selected else {
            return Ok(WindowCapture {
                record: None,
                epoch: state.download_epoch,
            });
        };
        let id = policy::string(&selected.scope, "hostID")?;
        // Same stable NSH runtime identity already used by nativeGuiRuntimeKey in TS;
        // derive only from this actor's committed publication, never origin/lease/JS input.
        let record = crate::window_state::MainWindow {
            window_key: key.into(),
            connection_id: id.into(),
            runtime_key: format!("nsh:{id}"),
            geometry,
        };
        record.validate()?;
        Ok(WindowCapture {
            record: Some(record),
            epoch: state.download_epoch,
        })
    }
    pub fn capture_download(
        &self,
        expected: &Value,
        window: &str,
    ) -> Result<file_download::transport::Captured> {
        let expected = policy::scope(expected)?;
        let state = self.0.upgrade().ok_or("download_scope_stale")?;
        let (selected, epoch) = {
            let state = state.lock().map_err(|_| "download_scope_stale")?;
            if !state.live || state.runtime_suspended || state.window_id.as_deref() != Some(window)
            {
                return Err("download_scope_stale".into());
            }
            (
                state
                    .selected
                    .as_ref()
                    .filter(|s| s.scope == expected)
                    .cloned()
                    .ok_or("download_scope_stale")?,
                state.download_epoch,
            )
        };
        let fence = self.0.clone();
        let captured = selected.clone();
        let window = window.to_owned();
        let captured_window = window.clone();
        let current = Arc::new(move || {
            fence.upgrade().is_some_and(|state| {
                state.lock().is_ok_and(|s| {
                    s.live
                        && !s.runtime_suspended
                        && s.download_epoch == epoch
                        && s.window_id.as_deref() == Some(&captured_window)
                        && s.selected.as_ref().is_some_and(|now| {
                            now.scope == captured.scope
                                && now.origin == captured.origin
                                && now.authorization == captured.authorization
                        })
                })
            })
        });
        file_download::transport::Captured::direct(
            &selected.scope,
            &window,
            &selected.origin,
            &selected.token,
            selected.loopback,
            current,
        )
    }
    pub fn capture_diagnostics(&self) -> Option<diagnostics::Scope> {
        let state = self.0.upgrade()?;
        let state = state.lock().ok()?;
        if !state.live || state.runtime_suspended {
            return None;
        }
        let selected = state.selected.as_ref()?;
        diagnostics::Scope::committed(
            &selected.scope,
            &selected.authorization,
            state.window_id.as_deref()?,
        )
        .ok()
    }
    pub fn current(&self, scope: &Value) -> bool {
        self.0.upgrade().is_some_and(|state| {
            state.lock().is_ok_and(|state| {
                state.live
                    && state
                        .selected
                        .as_ref()
                        .is_some_and(|selected| &selected.scope == scope)
            })
        })
    }
    fn capture(&self, expected: &Value) -> Result<terminal_transport::Captured> {
        let expected = policy::scope(expected)?;
        let state = self.0.upgrade().ok_or("terminal_host_unavailable")?;
        let selected = {
            let state = state.lock().map_err(|_| "terminal_authority_unavailable")?;
            if !state.live {
                return Err("terminal_host_unavailable".into());
            }
            state
                .selected
                .as_ref()
                .filter(|selected| selected.scope == expected)
                .cloned()
                .ok_or("terminal_scope_stale")?
        };
        if selected.token.is_empty() {
            return Err("terminal_device_bearer_required".into());
        }
        let current_state = self.0.clone();
        let scope = selected.scope.clone();
        let authorization = selected.authorization.clone();
        let current = Arc::new(move || {
            current_state.upgrade().is_some_and(|state| {
                state.lock().is_ok_and(|state| {
                    state.live
                        && state.selected.as_ref().is_some_and(|selected| {
                            selected.scope == scope && selected.authorization == authorization
                        })
                })
            })
        });
        terminal_transport::Captured::direct(
            selected.scope,
            &selected.origin,
            &selected.token,
            selected.loopback,
            current,
        )
    }
}
impl Port {
    pub fn install_writer_close_guard(
        &self,
        guard: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<()> {
        self.writer_close
            .set(guard)
            .map_err(|_| "writer_close_already_installed".into())
    }
    pub fn writer_close_ready(&self) -> bool {
        self.writer_close.get().is_none_or(|guard| guard())
    }
    pub fn approve_final_close(&self) {
        self.final_close.store(true, Ordering::Release);
    }
    pub fn final_close_approved(&self) -> bool {
        self.final_close.load(Ordering::Acquire)
    }
    pub fn bind_admission(&self, admission: Arc<AtomicBool>) -> Result<()> {
        self.admission
            .set(admission)
            .map_err(|_| "window_admission_already_installed".into())
    }
    pub fn new(network: Arc<dyn Network>) -> Self {
        Self {
            writer_close: Arc::default(),
            final_close: Arc::new(AtomicBool::new(false)),
            admission: Arc::default(),
            browser: browser_view::Port::new(network.clone()),
            network,
            notifications: Arc::new(OnceLock::new()),
            notification_identity: Arc::new(Mutex::new(None)),
            state: Arc::new(Mutex::new(State {
                live: true,
                selected: None,
                terminal: None,
                documents: None,
                diagnostics: None,
                window_id: None,
                runtime_suspended: false,
                file_journal: None,
                journal_retirement: None,
                file_download: None,
                download_epoch: 0,
                tabs: None,
                ssh: None,
                ssh_owned: true,
            })),
        }
    }
    pub fn browser(&self) -> browser_view::Port {
        self.browser.clone()
    }
    pub fn live(&self) -> bool {
        self.state.lock().is_ok_and(|s| s.live)
    }
    pub fn install_ssh(&self, control: crate::native_ssh_bridge::Control) -> Result<()> {
        self.attach_ssh(control, true)
    }
    pub fn install_shared_ssh(&self, control: crate::native_ssh_bridge::Control) -> Result<()> {
        self.attach_ssh(control, false)
    }
    fn attach_ssh(&self, control: crate::native_ssh_bridge::Control, owned: bool) -> Result<()> {
        let mut state = self.state.lock().map_err(|_| "ssh_install_not_available")?;
        if !state.live || state.ssh.is_some() {
            if owned {
                control.shutdown();
            }
            return Err("ssh_install_not_available".into());
        }
        state.ssh = Some(control);
        state.ssh_owned = owned;
        Ok(())
    }
    pub fn shutdown_complete(&self) -> bool {
        self.state.lock().is_ok_and(|s| {
            (!s.ssh_owned || s.ssh.as_ref().is_none_or(|ssh| ssh.stopped()))
                && s.journal_retirement
                    .as_ref()
                    .is_none_or(|journal| journal.stopped())
        })
    }
    pub fn ssh(&self) -> Option<crate::native_ssh_bridge::Control> {
        self.state.lock().ok().and_then(|s| s.ssh.clone())
    }
    pub fn install_tabs(&self, registration: desktop_tab::Registration) -> Result<()> {
        let mut state = self.state.lock().map_err(|_| "desktop_tab_unavailable")?;
        if !state.live || state.tabs.is_some() {
            return Err("desktop_tab_install_not_available".into());
        }
        registration.set_scope(state.selected.as_ref().map(|s| &s.scope))?;
        state.tabs = Some(registration);
        Ok(())
    }
    pub fn tabs(&self) -> Option<desktop_tab::Registration> {
        self.state.lock().ok().and_then(|s| s.tabs.clone())
    }
    pub fn reader(&self) -> Reader {
        Reader(Arc::downgrade(&self.state))
    }
    pub fn install_notifications(
        &self,
        host: &HostChannel,
        storage: notifications::Store,
        factory: notifications::Factory,
    ) -> Result<notifications::UiInbox> {
        if self.notifications.get().is_some() || !self.state.lock().is_ok_and(|s| s.live) {
            return Err("notification_install_not_available".into());
        }
        let (owner, inbox) = notifications::install(host, storage, factory)?;
        // Installation may wait for storage/driver readiness; never hold State there.
        // Recheck under the publication gate so shutdown cannot miss a late Owner.
        let state = self
            .state
            .lock()
            .map_err(|_| "notification_install_not_available")?;
        if !state.live {
            owner.control().shutdown();
            return Err("notification_install_not_available".into());
        }
        self.notifications
            .set(Arc::new(owner))
            .map_err(|_| "notification_install_not_available")?;
        Ok(inbox)
    }
    pub fn notifications(&self) -> Option<Arc<notifications::Owner>> {
        self.notifications.get().cloned()
    }
    /// Called by native activity delegates; never takes the publication/receipt locks.
    pub fn set_foreground(&self, foreground: bool) {
        if let Some(owner) = self.notifications.get() {
            owner.set_foreground(foreground);
        }
    }
    /// One native identity per single-window services owner; never supplied by JS.
    pub fn window_id(&self) -> Result<String> {
        let mut state = self.state.lock().map_err(|_| "native_window_unavailable")?;
        if !state.live {
            return Err("native_window_unavailable".into());
        }
        if state.window_id.is_none() {
            state.window_id = Some(crate::vault::id()?);
        }
        Ok(state
            .window_id
            .as_ref()
            .expect("native window identity")
            .clone())
    }
    #[cfg(test)]
    pub fn install_diagnostics(
        &self,
        host: &HostChannel,
        port: diagnostics::Port,
        version: Value,
        build: Value,
    ) -> Result<()> {
        self.install_diagnostics_with_preference(host, port, version, build, None)
    }
    pub fn install_diagnostics_with_preference(
        &self,
        host: &HostChannel,
        port: diagnostics::Port,
        version: Value,
        build: Value,
        preference: Option<Box<dyn diagnostics::Preference>>,
    ) -> Result<()> {
        self.window_id()?;
        let reader = self.reader();
        let capture: diagnostics::Capture = Arc::new(move || reader.capture_diagnostics());
        let mut state = self
            .state
            .lock()
            .map_err(|_| "diagnostics_authority_unavailable")?;
        if !state.live || state.diagnostics.is_some() {
            return Err("diagnostics_install_not_available".into());
        }
        state.diagnostics = Some(match preference {
            None => diagnostics::install(host, capture, port, version, build),
            Some(preference) => diagnostics::install_with_preference(
                host,
                capture,
                port,
                version,
                build,
                Some(preference),
            ),
        });
        Ok(())
    }
    /// Called only for explicit native runtime suspension/resumption, never dialog focus.
    pub fn set_runtime_suspended(&self, suspended: bool) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if !state.live || state.runtime_suspended == suspended {
            return;
        }
        if let Some(diagnostics) = &state.diagnostics {
            diagnostics.invalidate();
        }
        if let Some(download) = &state.file_download {
            download.invalidate();
        }
        state.download_epoch = state.download_epoch.wrapping_add(1);
        state.runtime_suspended = suspended;
    }
    pub fn install_documents(&self, host: &HostChannel, port: documents::Port) -> Result<()> {
        let reader = self.reader();
        let authority: documents::Authority = Arc::new(move |scope| reader.current(scope));
        let mut state = self
            .state
            .lock()
            .map_err(|_| "documents_authority_unavailable")?;
        if !state.live || state.documents.is_some() {
            return Err("documents_install_not_available".into());
        }
        state.documents = Some(documents::install(host, authority, port));
        Ok(())
    }
    pub fn install_file_download(
        &self,
        host: &HostChannel,
        port: file_download::Port,
    ) -> Result<()> {
        let window = self.window_id()?;
        let reader = self.reader();
        let capture: file_download::Capture =
            Arc::new(move |scope, window| reader.capture_download(scope, window));
        let mut state = self
            .state
            .lock()
            .map_err(|_| "download_owner_unavailable")?;
        if !state.live || state.file_download.is_some() {
            return Err("download_install_not_available".into());
        }
        state.file_download = Some(file_download::install(
            host,
            &window,
            self.network.clone(),
            capture,
            port,
        )?);
        Ok(())
    }
    /// Window-scoped durable journal, deliberately independent of selected Host/lease.
    #[cfg(test)]
    pub fn install_file_journal(
        &self,
        host: &HostChannel,
        data_dir: &std::path::Path,
    ) -> Result<()> {
        self.install_window_file_journal(host, data_dir, "primary")
    }
    pub fn install_window_file_journal(
        &self,
        host: &HostChannel,
        data_dir: &std::path::Path,
        window_key: &str,
    ) -> Result<()> {
        let namespace = file_journal::window_namespace(window_key).map_err(str::to_owned)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "file_journal_owner_unavailable")?;
        if !state.live || state.file_journal.is_some() {
            return Err("file_journal_install_not_available".into());
        }
        state.file_journal =
            Some(file_journal::install(host, data_dir, &namespace).map_err(str::to_owned)?);
        Ok(())
    }
    pub fn install_terminal(
        &self,
        host: &HostChannel,
        registration: terminal_viewport::Registration,
        catalog: impl Into<terminal_host::CatalogSource>,
    ) -> Result<()> {
        let reader = self.reader();
        let capture: terminal_host::Capture = Arc::new(move |expected| reader.capture(expected));
        let mut state = self
            .state
            .lock()
            .map_err(|_| "terminal_authority_unavailable")?;
        if !state.live || state.terminal.is_some() {
            return Err("terminal_install_not_available".into());
        }
        registration.set_scope(state.selected.as_ref().map(|selected| &selected.scope))?;
        registration.install_capability(host);
        let owner = Arc::new(terminal_host::install(
            host,
            self.network.clone(),
            capture,
            catalog,
        ));
        state.terminal = Some(Terminal {
            registration,
            owner,
        });
        Ok(())
    }
    /// Only the actor calls this, after successful durable restoration/transition.
    pub fn publish(
        &self,
        scope: &Value,
        origin: &str,
        token: &str,
        authorization: &str,
        loopback: bool,
    ) {
        let changed = self.state.lock().is_ok_and(|state| {
            state.live
                && state.selected.as_ref().is_none_or(|s| {
                    s.scope != *scope || s.authorization != authorization || s.origin != origin
                })
        });
        if !changed {
            if self.state.lock().is_ok_and(|state| state.live) {
                self.publish_notification(scope, authorization);
            }
            return;
        }
        self.clear_notification();
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if !state.live {
            return;
        }
        if state.selected.as_ref().is_none_or(|selected| {
            selected.scope != *scope
                || selected.authorization != authorization
                || selected.origin != origin
        }) && let Some(diagnostics) = &state.diagnostics
        {
            diagnostics.invalidate();
        }
        // Browser/viewport failure never rolls back a committed connection.
        if let Some(download) = &state.file_download {
            download.invalidate();
        }
        state.download_epoch = state.download_epoch.wrapping_add(1);
        let _ = self.browser.authorize(scope, origin, token, loopback);
        state.selected = Some(Selected {
            scope: scope.clone(),
            origin: origin.into(),
            token: token.into(),
            authorization: authorization.into(),
            loopback,
        });
        if let Some(terminal) = &state.terminal {
            let _ = terminal.registration.set_scope(Some(scope));
        }
        if let Some(tabs) = &state.tabs {
            let _ = tabs.set_scope(Some(scope));
        }
        drop(state);
        if changed {
            self.publish_notification(scope, authorization);
        }
    }
    fn publish_notification(&self, scope: &Value, authorization: &str) {
        if let Some(owner) = self.notifications.get() {
            let identity = notifications::Identity {
                host_id: scope["hostID"].as_str().unwrap_or("").into(),
                authorization_id: authorization.into(),
                runtime_lease: scope["lease"].as_str().unwrap_or("").into(),
            };
            if let Ok(mut prior) = self.notification_identity.lock()
                && prior.as_ref() != Some(&identity)
                && owner.publish(Some(identity.clone())).is_ok()
            {
                *prior = Some(identity);
            }
        }
    }
    fn clear_notification(&self) {
        if let Some(owner) = self.notifications.get() {
            if let Ok(mut prior) = self.notification_identity.lock() {
                prior.take();
            }
            let _ = owner.publish(None);
        }
    }
    pub fn invalidate(&self) {
        self.retire(false);
    }
    pub fn shutdown(&self) {
        self.retire(true);
    }
    fn retire(&self, shutdown: bool) {
        if shutdown && let Some(admission) = self.admission.get() {
            admission.store(true, Ordering::Release);
        }
        if shutdown {
            let ssh = self
                .state
                .lock()
                .ok()
                .and_then(|s| if s.ssh_owned { s.ssh.clone() } else { None });
            if let Some(ssh) = ssh {
                ssh.shutdown();
            }
        }
        if let Some(owner) = self.notifications.get() {
            if shutdown {
                owner.control().shutdown();
            } else {
                self.clear_notification();
            }
        }
        let Ok(mut state) = self.state.lock() else {
            self.browser.invalidate();
            return;
        };
        // The document's final local rename shares this gate; retire it before changing authority.
        if let Some(download) = &state.file_download {
            download.invalidate();
        }
        state.download_epoch = state.download_epoch.wrapping_add(1);
        if let Some(diagnostics) = &state.diagnostics {
            diagnostics.invalidate();
        }
        if let Some(documents) = &state.documents {
            documents.invalidate();
        }
        if shutdown {
            state.live = false;
        }
        self.browser.invalidate();
        let selected = state.selected.take();
        if let Some(tabs) = &state.tabs {
            let _ = tabs.set_scope(None);
        }
        let terminal = state.terminal.as_ref().map(|terminal| {
            let _ = terminal.registration.set_scope(None);
            terminal.owner.clone()
        });
        let stopped = if shutdown {
            state.terminal.take()
        } else {
            None
        };
        let stopped_documents = if shutdown {
            state.documents.take()
        } else {
            None
        };
        let stopped_diagnostics = if shutdown {
            state.window_id = None;
            state.diagnostics.take()
        } else {
            None
        };
        let stopped_file_journal = if shutdown {
            if let Some(journal) = &state.file_journal {
                state.journal_retirement = Some(journal.shutdown());
            }
            state.file_journal.take()
        } else {
            None
        };
        let stopped_file_download = if shutdown {
            state.file_download.take()
        } else {
            None
        };
        drop(state);
        // No service mutex is held across session-book locks or Owner destructors.
        if let Some(terminal) = terminal
            && let Some(selected) = selected
        {
            terminal.retire_scope(&selected.scope);
        }
        drop(stopped);
        drop(stopped_documents);
        drop(stopped_diagnostics);
        drop(stopped_file_journal);
        drop(stopped_file_download);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    struct Offline;
    impl Network for Offline {
        fn fetch(
            &self,
            _: nsh_engine::HttpRequest,
            _: nsh_engine::FetchEvents,
        ) -> Box<dyn nsh_engine::FetchTask> {
            panic!("authority publication cannot perform I/O");
        }
    }
    #[test]
    fn shutdown_during_notification_install_rejects_late_owner_without_waiting_for_storage() {
        use std::{sync::mpsc, time::Duration};
        struct PausedStore {
            entered: mpsc::SyncSender<()>,
            resume: mpsc::Receiver<()>,
        }
        impl notifications::store::Store for PausedStore {
            fn load(&mut self) -> Result<Option<Value>> {
                self.entered.send(()).unwrap();
                self.resume.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(None)
            }
            fn commit(&mut self, _: &Value) -> Result<()> {
                panic!("installation must not write receipts");
            }
        }
        let port = Port::new(Arc::new(Offline));
        let installing = port.clone();
        let (entered, ready) = mpsc::sync_channel(1);
        let (resume, paused) = mpsc::sync_channel(1);
        let worker = std::thread::spawn(move || {
            installing.install_notifications(
                &HostChannel::default(),
                Box::new(PausedStore {
                    entered,
                    resume: paused,
                }),
                Box::new(|_| Err("notification_unsupported_identity".into())),
            )
        });
        ready.recv_timeout(Duration::from_secs(5)).unwrap();
        port.shutdown();
        resume.send(()).unwrap();
        assert_eq!(
            worker.join().unwrap().err().as_deref(),
            Some("notification_install_not_available")
        );
        assert!(port.notifications().is_none());
        assert!(port.window_id().is_err());
    }
    #[test]
    fn diagnostic_capture_uses_one_native_window_and_exact_committed_authorization() {
        let port = Port::new(Arc::new(Offline));
        let reader = port.reader();
        let scope = json!({"hostID":"synthetic-diagnostics","lease":"00000000-0000-4000-8000-000000000321"});
        port.publish(
            &scope,
            "https://synthetic.invalid",
            "synthetic-token",
            "auth-first",
            false,
        );
        assert!(
            reader.capture_diagnostics().is_none(),
            "never invent a window from a Host scope"
        );
        let window = port.window_id().unwrap();
        assert_eq!(port.window_id().unwrap(), window);
        let first = diagnostics::Scope::committed(&scope, "auth-first", &window).unwrap();
        assert!(
            reader
                .capture_diagnostics()
                .is_some_and(|scope| scope == first)
        );
        port.set_runtime_suspended(true);
        assert!(reader.capture_diagnostics().is_none());
        port.set_runtime_suspended(false);
        assert!(
            reader
                .capture_diagnostics()
                .is_some_and(|scope| scope == first)
        );
        port.publish(
            &scope,
            "https://synthetic.invalid",
            "synthetic-token-two",
            "auth-second",
            false,
        );
        assert!(
            reader
                .capture_diagnostics()
                .is_some_and(|scope| scope != first)
        );
        let second = diagnostics::Scope::committed(&scope, "auth-second", &window).unwrap();
        assert!(
            reader
                .capture_diagnostics()
                .is_some_and(|scope| scope == second)
        );
        port.shutdown();
        assert!(reader.capture_diagnostics().is_none());
        assert!(port.window_id().is_err());
        let next = Port::new(Arc::new(Offline));
        assert_ne!(next.window_id().unwrap(), window);
    }
    #[test]
    fn native_terminal_capture_checks_lease_and_authorization_and_shutdown_cannot_republish() {
        let port = Port::new(Arc::new(Offline));
        let reader = port.reader();
        let scope = json!({"hostID":"synthetic","lease":"00000000-0000-4000-8000-000000000001"});
        assert!(reader.capture(&scope).is_err());
        port.publish(
            &scope,
            "https://synthetic.invalid",
            "synthetic-bearer",
            "authorization-one",
            false,
        );
        let first = reader.capture(&scope).unwrap();
        assert!(first.valid());
        port.publish(
            &scope,
            "https://synthetic.invalid",
            "synthetic-second",
            "authorization-two",
            false,
        );
        assert!(
            !first.valid(),
            "same host/scope is not enough if native authorization changed"
        );
        let second = reader.capture(&scope).unwrap();
        let registration = terminal_viewport::Registration::default();
        let catalog = std::env::temp_dir().join(format!(
            "synthetic-unused-terminal-{}.json",
            crate::vault::id().unwrap()
        ));
        port.install_terminal(&HostChannel::default(), registration.clone(), catalog)
            .unwrap();
        assert_eq!(
            registration
                .capabilities(&json!({"expectedHost":scope}))
                .unwrap_err(),
            "terminal_native_renderer_unavailable"
        );
        port.invalidate();
        assert!(!second.valid());
        assert!(!reader.current(&scope));
        assert_eq!(
            registration
                .capabilities(&json!({"expectedHost":scope}))
                .unwrap_err(),
            "terminal_scope_stale"
        );
        let mut next = scope.clone();
        next["lease"] = json!("00000000-0000-4000-8000-000000000002");
        port.publish(
            &next,
            "https://synthetic.invalid",
            "synthetic-third",
            "authorization-three",
            false,
        );
        assert!(reader.capture(&scope).is_err());
        let current = reader.capture(&next).unwrap();
        port.shutdown();
        assert!(!current.valid());
        port.publish(
            &next,
            "https://synthetic.invalid",
            "synthetic-fourth",
            "authorization-four",
            false,
        );
        assert!(reader.capture(&next).is_err());
        assert!(port.browser().capture(&next).is_err());
    }
}
