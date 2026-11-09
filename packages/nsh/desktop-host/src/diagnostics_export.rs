//! Export driver is exercised without OS windows or user files in diagnostics_tests.
use super::*;
use std::ffi::c_void;

pub(super) trait Driver {
    #[cfg(test)]
    fn choose(&mut self) -> Result<bool>;
    fn stage(&mut self, bytes: &[u8], current: &dyn Fn() -> bool) -> Result<()>;
    fn commit(&mut self) -> Result<()>;
    fn verify(&mut self, bytes: &[u8]) -> Result<bool>;
}
pub struct Job {
    book: Arc<Mutex<Book>>,
    capture: Capture,
    scope: Scope,
    epoch: u64,
    data: Vec<u8>,
    count: usize,
    reply: Arc<Mutex<Option<HostReply>>>,
    finished: bool,
    cancelled: Arc<AtomicBool>,
}
impl Job {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn new(book: Arc<Mutex<Book>>, capture: Capture, scope: Scope, epoch: u64, data: Vec<u8>, count: usize, reply: Arc<Mutex<Option<HostReply>>>, cancelled: Arc<AtomicBool>) -> Self {
        Self { book, capture, scope, epoch, data, count, reply, finished: false, cancelled }
    }
    fn current(&self) -> bool {
        // Never call the publisher while holding the recorder's commit gate.
        if (self.capture)().as_ref() != Some(&self.scope) { return false; }
        self.book.lock().is_ok_and(|book| self.admitted(&book))
    }
    fn admitted(&self, book: &Book) -> bool {
        !book.stopped && book.enabled && book.epoch == self.epoch
            && book.scope.as_ref() == Some(&self.scope)
            && book.export.as_ref().is_some_and(|r| Arc::ptr_eq(r, &self.reply))
    }
    pub(super) fn finish(&mut self, outcome: &str, error: Option<&str>) {
        let mut book = self.book.lock().unwrap_or_else(|e| e.into_inner());
        let owns = book.export.as_ref().is_some_and(|r| Arc::ptr_eq(r, &self.reply));
        if owns { book.export = None; book.cancelled = None; }
        let mut value = json!({"outcome":outcome,"eventCount":self.count});
        if let Some(error) = error { value["error"] = json!(error); }
        settle(&self.reply, value);
        self.data.clear(); self.finished = true;
    }
    /// UI-thread only. This window identity must match the installed native Scope;
    /// window pointers are owned by Host/UI and are NEVER accepted from JavaScript.
    pub unsafe fn show(mut self, window: *mut c_void, window_id: &str) {
        if self.scope.window_id != window_id || !self.current() {
            self.finish("cancelled", None); return;
        }
        unsafe { native::schedule(self, window); }
    }
    pub(super) unsafe fn present(mut self, window: *mut c_void) {
        // The chooser runs on UI thread; stage/flush/commit runs on a bounded single
        // worker. The export slot remains held until it finishes (including unknown).
        if !self.current() { self.finish("cancelled", None); return; }
        match unsafe { native::choose(window, &self.cancelled) } {
            Ok(None) => self.finish("cancelled", None),
            Err(_) => self.finish("failed", Some("diagnostics_panel_failed")),
            Ok(Some(path)) if self.current() => {
                // No UI pointer is moved to the worker; even parent/stat/grant I/O
                // starts only here, after the explicit system selection.
                let _ = std::thread::Builder::new().name("yuri-diagnostics-export".into()).spawn(move || {
                    if !self.current() { self.finish("cancelled", None); return; }
                    let grant = match files::Grant::selected(&path) {
                        Ok(grant) => grant,
                        Err(_) => { self.finish("failed", Some("diagnostics_invalid_selection")); return; }
                    };
                    let mut driver = FileDriver { grant, staged: None };
                    self.write(&mut driver);
                });
            }
            Ok(Some(_)) => self.finish("cancelled", None),
        }
    }
    #[cfg(test)]
    pub(super) fn drive(mut self, driver: &mut impl Driver) {
        if !self.current() { self.finish("cancelled", None); return; }
        match driver.choose() {
            Ok(true) => self.write(driver),
            Ok(false) => self.finish("cancelled", None),
            Err(_) => self.finish("failed", Some("diagnostics_panel_failed")),
        }
    }
    fn write(mut self, driver: &mut impl Driver) {
        if !self.current() { self.finish("cancelled", None); return; }
        if driver.stage(&self.data, &|| self.current()).is_err() {
            if self.current() { self.finish("failed", Some("diagnostics_stage_failed")); }
            else { self.finish("cancelled", None); }
            return;
        }
        let result = {
            let mut book = self.book.lock().unwrap_or_else(|e| e.into_inner());
            if !self.admitted(&book) { Err("diagnostics_cancelled".into()) }
            else {
                let result = driver.commit();
                // Retirement cannot erase an unknown-write tombstone before publication.
                if result.as_ref().is_err_and(|e| e == "documents_write_unknown") { book.unknown = true; }
                result
            }
        };
        match result {
            Ok(()) => self.finish("shared", None),
            Err(error) if error == "diagnostics_cancelled" => self.finish("cancelled", None),
            Err(error) if error == "documents_write_unknown" => {
                if driver.verify(&self.data).unwrap_or(false) {
                    self.book.lock().unwrap_or_else(|e| e.into_inner()).unknown = false;
                    self.finish("shared", None);
                } else { self.finish("failed", Some("diagnostics_write_unknown")); }
            }
            Err(_) => self.finish("failed", Some("diagnostics_write_failed")),
        }
    }
}
impl Drop for Job {
    fn drop(&mut self) { if !self.finished { self.finish("failed", Some("diagnostics_owner_unavailable")); } }
}
struct FileDriver { grant: files::Grant, staged: Option<files::Stage> }
impl Driver for FileDriver {
    #[cfg(test)]
    fn choose(&mut self) -> Result<bool> { unreachable!("system selection already confirmed") }
    fn stage(&mut self, bytes: &[u8], current: &dyn Fn() -> bool) -> Result<()> {
        self.staged = Some(self.grant.stage(bytes, current)?); Ok(())
    }
    fn commit(&mut self) -> Result<()> { self.grant.commit(self.staged.as_mut().expect("complete stage")) }
    fn verify(&mut self, bytes: &[u8]) -> Result<bool> { self.grant.verify(bytes) }
}
