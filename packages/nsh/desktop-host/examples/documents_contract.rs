//! Synthetic-only contract tests; no windows, network, connection restore or Vault access.
//!
//! Host owner integration (no component registration is needed):
//! 1. Declare `mod documents` and grant documents::METHODS in the bundle manifest.
//! 2. AFTER bridge fallback registration, create documents::channel(), then
//!    documents::install(&host, Arc::new(move |scope| reader.current(scope)), port).
//!    `reader` is the native committed authority reader, not a JS scope assertion.
//! 3. Retain Owner and pass Inbox to the existing UI owner. On its main thread,
//!    outside borrowed pump state: if let Some(job)=inbox.try_recv() { job.show(window) }.
//!    `window` is the actual NSWindow*/HWND. Serialize with other native dialogs;
//!    documents::is_presenting() exposes this module's real presentation lifetime.
//! 4. Before every Host/lease/window retirement, synchronously Owner::invalidate().
//!    The final rename shares this gate. Drop Owner before stopping the native view.
//!    No callback in the commit gate re-enters the authority publisher's mutex.
//!
//! save: {requestID,ownerID,expectedHost,format:"markdown",filename,content}
//! status/cancel: {requestID,ownerID,expectedHost}. `expectedHost` is the existing
//! exact {hostID,lease}; ownerID and requestID are fresh process-local IDs.
//! Receipts: {requestID,state:"pending"|"saved"|"cancelled"|"error",error?:stable_code}.
//! Unknown save/commit: status ONLY. No receipt or event ever contains a local path/body.
//! Cancellation does not undo a completed/uncertain commit; retiring an uncertain
//! grant drops its native content/path but retains the exact unknown metadata tombstone.
//! No receipt eviction/reuse (128 per installed Owner), one <=8 MiB job/verification,
//! plus a bounded incoming HostChannel value; no app-private fs or credential access.
//!
//! Mac/Windows system dialogs are implemented but intentionally NOT opened by these tests.
//! Windows layout/flag tests are NOT Windows target/linker/runtime evidence.
#![allow(dead_code)]
#[path = "../src/documents.rs"]
mod documents;
#[path = "../src/policy.rs"]
mod policy;
#[path = "../src/vault.rs"]
mod vault;
fn main() {}
