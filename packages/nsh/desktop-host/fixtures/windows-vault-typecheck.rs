//! Metadata-only check of the actual Win32 FFI backend on a non-Windows build machine.
//! Run rustc --crate-type lib --emit metadata with the already-built serde_json rlib.
//! This never links or executes a Windows DLL and is not a Windows target/SDK check.
#![allow(dead_code)]
#[path = "../src/policy.rs"]
mod policy;
use policy::Result;
#[path = "../src/vault.rs"]
mod vault;
use vault::{id, invalidates_authority};
#[path = "../src/vault_windows_abi.rs"]
mod abi;
#[path = "../src/vault_records.rs"]
mod records;
#[path = "../src/vault_windows.rs"]
mod windows;

fn thread_boundary() {
    fn send<T: Send>() {}
    send::<windows::Store>();
}
