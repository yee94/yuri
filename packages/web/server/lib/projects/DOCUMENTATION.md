# Projects

`registry.js` owns registering existing directories. It reuses `validateDirectoryPath`, deterministic
path-derived IDs and the settings runtime's serialized persistence. The existing
`POST /api/opencode/directory` API, the session-bound project API bridge and assistant business tools share this owner.
The UI directory API still selects the active directory; session/assistant registration does not
change an existing active selection. The first registered project becomes active
through the existing settings invariant.

Registration is not filesystem creation or cloning. Those operations must finish
before registration. Paths are validated and canonicalized before deduplication.
Concurrent registrations apply against the latest settings under the existing
Host/Electron exclusive write lock, preserving unrelated settings and projects
(including temporarily unavailable directories). Existing IDs, ordering, custom
labels and metadata survive repeat registration. Removal matches one local project
ID under the same lock and leaves files, sessions and task storage intact. The
settings writer selects a remaining active project if needed.

Trusted registry operations use the settings owner's functional update form.
It performs a strict read inside the same persistence lock and follows the normal
normalization, migration, atomic write and project-order SSE notification paths.
Unlike full-list UI replacement, this form does not sweep other projects for
missing directories: callers validate the affected resource. Corrupt reads and
failed writes are errors, not empty state or successful registration. No new
database, settings file or client sync protocol is added. The session skill's
`POST /api/yuri/session-skills/projects` bridge adds authenticated `describe`,
`list`, `add` and local `remove` operations without exposing the full settings API; its admission
and result contract live in `../gui-customization/DOCUMENTATION.md`.

`registry.test.js` covers canonical alias deduplication, concurrent append/settings
writes, persistence, offline-project retention, corrupt
reads and failed-write preservation. Assistant HTTP integration is covered in
`../assistants/yuri-project.http.test.js`.

New sessions created from a workspace send `metadata.yuri.workspaceId` in the
OpenCode create request. Host admission installs workspace directory instructions
before the first message for both shared and private local OpenCode, but not for
an unmanaged external server. A later metadata update does not replay admission,
and the working directory alone cannot
disambiguate workspaces that share it.
Settings hydration preserves explicit workspace IDs and ordered member paths,
including empty member lists, alongside ordinary projects at the same path.

The Remote Host Gateway mounts authenticated `POST /api/projects` and `PATCH
/api/projects/:id` local-authority operations using the same registry/settings
lock. `GET /api/projects` excludes remote references. Remote-first registration,
metadata write-through and Hub-only reference removal belong to
`../remote-hosts/`, not this local filesystem registry.
