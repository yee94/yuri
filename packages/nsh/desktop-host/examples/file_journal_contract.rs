//! Headless synthetic-only journal tests; never opens an AppKit window or user store.
//! Production: mod file_journal; retain file_journal::install(&host,&data_dir,"primary")?.
//! data_dir is the native app directory, namespace a stable native window ID (not
//! a per-process nonce). No JS path/namespace argument. Install after bridge fallback.
//! Declared capabilities are exactly file_journal::METHODS:
//! - snapshot {} -> {status:"ready",version:number,requestID:string|null,records:{key:raw}}
//! - commit {expectedVersion,requestID,records} -> same envelope, version increments by 1
//! - sync {version,requestID} -> same exact durable version/receipt, NO mutation replay
//!
//! Other replies: {status:"denied"|"unknown",code:stable_code}. Only a sync denial
//! with code=file_journal_not_committed proves that particular mutation did not commit.
//! Docs and operation-v1 records share 20 rows/4MiB UTF-8; exact record schemas reject
//! transport lease/credentials. All authority/directory partitions are retained.
//! Files: data_dir/file-journal-v1/<namespace>/snapshots.bin, fixed bounded two slots.
//! Mac: private 0700/0600, nofollow/openat + flock, fsync/F_FULLFSYNC + directory fsync.
//! Windows: protected user-only DACL, pinned no-reparse parents, exclusive NTFS
//! WRITE_THROUGH fixed file + FlushFileBuffers data/metadata barriers; no atomic rename.
//! This example's actual QuickJS/native/disk test uses only an isolated temporary root.
#![allow(dead_code)]
#[path = "../src/file_journal.rs"]
mod file_journal;
fn main() {}
