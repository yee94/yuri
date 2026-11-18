# Projects

Manage project registrations through the **bound project API helper** in this
session's Yuri customization pointer. This is a Host capability, not a GUI plugin
or a desktop deep link. Registration does not create files, clone a repository,
open a conversation or switch an existing active project.

## Resource identity and scope

Resolve ownership before operating on a project/session or composing a navigation link:

1. Discover this caller's capabilities through the bound helper's `describe`, or the contact's granted project tools. For registration, prefer the granted project tool when available. Use the returned operations and their scope; a missing binding or unsupported capability is an explicit limit.
2. For bound-Host resources, use exact IDs and raw directories from this session's context or the relevant `list` / `task-sessions` result. The bound Host is the helper's execution target, not necessarily the computer displaying Yuri. Index results have the completeness limits described below.
3. For remote resources, discover the project or machine through `remote-projects` / `remote-hosts`, then query its sessions with `sessions` or `read-session`. Keep the returned `target:{hubId,hostId,instanceId}` with each resource's raw directory and session ID:

   | Field | Meaning |
   |---|---|
   | `hubId` | The Hub whose authorized connections this caller is using. |
   | `hostId` | A connection identity within that Hub, not a universal machine ID. |
   | `instanceId` | The target Yuri instance's identity, independent of which connection reaches it. |

   Different Hubs can use different connection IDs for the same instance. A worker on the target instance need not know another Hub's connection ID. Use identities actually returned to this caller; names, addresses, equal paths and session-ID structure are not ownership evidence.
4. Preserve the complete reference for operations that accept it. Each operation or navigation route independently defines which fields it accepts; discovering an identity does not enable another protocol or grant access. For links, serialize only the fields documented in [deep links](deep-links.md).

When ownership is unknown or ambiguous, report what is missing and use authorized discovery or ask for clarification. A failed lookup stays unconfirmed; changing the target or creating a replacement resource is a separate user decision.

## Local project registration

1. Resolve the user-requested directory to an absolute path on the bound Yuri
   Host. Reuse a known directory; directory creation/cloning is a separate action
   requiring the user's request. Paths in JSON are literal strings, not
   percent-encoded URL parameters.
2. Run this session's exact `Bound project helper` command (`describe`). It returns
   the supported operations and ready-to-run `commands.add` and `commands.list`.
   The helper owns authentication; no credential discovery or browser login is
   needed. If the pointer has no bound project command, report unavailable.
3. Run the returned `add` command unchanged, supplying JSON on stdin:

   ```json
   {"path":"/workspace/my-project","label":"My project"}
   ```

   `path` is required; `label` is optional (up to 80 characters). The Host validates
   the existing directory and canonicalizes its path, then registers it through
   Yuri's shared project registry and serialized settings writer. Repeat calls
   for the same canonical directory reuse the existing project and preserve its
   name, order and metadata.
4. A successful result is `{"project":{"id":"…","path":"…","label":"…"},"created":true}`.
   `created:false` means it was already registered. Both confirm the saved project;
   use the returned canonical `project.path` and report the result briefly. The
   `label` field can be absent. No browser check is required to prove registration.

`list` returns `{"projects":[{"id":"…","path":"…","label":"…"}]}` from the
authoritative settings store. After an interrupted response, list or retry add
with the same path: registration is idempotent. A failure is unconfirmed, never an
empty-success result. Missing paths, files and inaccessible directories fail
without implicit filesystem creation. A `terminal:true` helper error stops this
workflow until a new supported session's bound describe succeeds.

## Local project removal

1. Run the bound `describe` command. Continue only if it returns `commands.remove`.
2. Run `commands.list` and match the user's requested scope to exact project IDs
   on the bound Host. Resolve ambiguous names before writing. Remote projects
   are not in this list and are not supported by this operation.
3. Run `commands.remove` once per selected ID with JSON on stdin:
   `{"projectId":"…"}` (replace the placeholder with the exact listed ID).
   This unregisters the project from Yuri without deleting its directory,
   files, sessions or tasks. It does not navigate an open client.
4. Count only `{"projectId":"…","removed":true}` as a confirmed removal. Report
   failures separately; after an interrupted response, re-list the same Host
   to check whether the ID is still registered before retrying.

## Interface and scope

The helper calls `POST /api/yuri/session-skills/projects` with
`{sessionID, operation, input}`, using operations returned by `describe`. It uses the same
loopback service authentication and admitted-session Host binding as the other
built-in session helpers. Only affected project metadata is returned, never full
settings or credentials. Use the bound command rather than reconstructing auth or
calling the route with browser tokens.

The existing UI API `POST /api/opencode/directory` and this bridge share
`projects/registry.js`; the UI API additionally activates the directory. The skill
registers only, preserving an existing active selection (the first project may
become active through normal settings initialization). Existing project-order
notifications distribute the saved registry to connected clients.

New shared-service sessions admitted by a Yuri Host receive the helper whether
the UI is Electron, web or connected mobile. The directory belongs to that Host,
not the phone or another machine. Private/external OpenCode, standalone VS Code,
old sessions and contacts without a bound command gain no API access from reading
this file. Contacts may instead have their own granted `yuri.projects` tools;
those retain their own capability contract. When the helper is unavailable, use
the intended Host's project UI or start a supported session. Keep desktop deep
links for their existing navigation purpose, not as an API authorization fallback.

## Archiving conversations (task archive vs session archive)

Yuri has two different states that the UI labels alike. Pick by what the user sees:

| Term | User wording | Operation | What it changes |
|---|---|---|---|
| **任务归档 / Task archive** (`settle`) | In the task view, 「归档」 / "move to the archived shelf" / "clear my task list" | `settle-session`, `unsettle-session` | Host session index only. Reversible; a session returns to active on new user activity. |
| **会话归档 / Session archive** (`archive`) | Explicit "session-level archive", `archivedAt` | `archive-session`, `unarchive-session` | Session metadata `archivedAt`. The session's own lifecycle state. |

Use these qualified Chinese terms in agent explanations; the task-view UI keeps its existing 「归档」 label (no new 「已搁置」 term).

Default: when the user says 「归档」 about conversations/tasks without further detail, use `settle-session`. Never use `archive-session` for that request; it is not the task-view action. Neither operation deletes content.

1. Run the bound project `describe` command. Continue only when `lifecycleSupported:true`; use the returned commands unchanged. Authentication is owned by the helper: no UI password or browser is required. A missing command or terminal error means stop and request a newly admitted session on an updated Host.
2. Discover exact IDs with `commands["task-sessions"]`, supplying `{}` or `{"directory":"/workspace/my-project"}` on stdin. Results contain up to 50 metadata rows (`sessionID`, `directory`, `title`, `settled`, `pinned`, `activityUpdatedAt`) and `nextCursor`. Follow every returned cursor using the same directory filter **before writing**, then select only the user's scope. `indexedOnly:true` means this is the bound Host's task index, not every historical OpenCode session; `historyComplete:false` means full upstream history is not confirmed. Re-read after a concurrent catalog change; never interpret a failed read as an empty list.
3. Supply JSON on stdin to the chosen write command, one session per call:

   ```json
   {"sessionID":"ses_xxxxxxxx"}
   ```

   `archive-session` / `unarchive-session` also accept an optional absolute `directory` hint. `sessionID` must be an existing OpenCode session ID (`ses…`).
4. Completion: settle returns `{"sessionID":"ses_…","settled":true}`, restore returns `settled:false`. Read `commands["session-state"]` with `{"sessionID":"ses_…"}` to verify the Host projection and archive timestamp, or re-list task rows. State returns `indexed`, `archivedAt`, `settled` and `pinned`; the last two are `null` when no task row is projected. It is Host state, not proof of upstream existence or live UI membership. Live running/pending-request sessions may remain visible as active, and settle preserves pins; it does not abort execution or guarantee an empty task view. New user message/inbox activity clears the settle override; assistant completion alone does not.
   Session archive returns `{"sessionID":"ses_…","archived":true,"archivedAt":123,"index":{"ok":true}}`; restore returns `archived:false,archivedAt:0`. `index.ok:false` confirms metadata persistence but not index repair: report partial success and re-check the same ID before retrying; retain the original `archivedAt` receipt.
5. `session_not_found`/`not_found` (404) means the selected ID is unavailable, not success. `session_archived` (409) means an existing session-level archive must be restored with `unarchive-session`, not `unsettle-session`. Errors remain unconfirmed and raw credentials/errors are not returned. After an interrupted write, inspect the same IDs before retrying; bulk work reports confirmed counts and per-ID failures.

These operations affect only the **bound Host** and its current runtime. Task state for Remote Projects belongs to this connected Hub, never the remote machine's database. A remote `{target,...}` is not accepted here; session-level archive of a remote worker through this helper is unsupported. Keep the full remote target and use its supported workflow rather than falling back to a same-named local session.

Archive only sessions the user named or clearly scoped, including the current session only when requested. Use the bound helper rather than UI-authenticated HTTP routes, browser cookies, credential discovery or direct SQLite writes. The Host publishes normal index revisions after confirmed task writes.

## Connected remote projects and sessions

Use this branch to add a remote project on an authorized machine or discover, read, create or continue its sessions. Registration uses the remote machine's filesystem, not this session's local filesystem.

1. Run the exact bound project `describe` command. Continue only when `remoteSupported:true`; use its returned commands unchanged. No bound helper or a terminal auth error means stop this branch.
2. Choose the target from authenticated discovery:
   - Existing projects: `commands.remote-projects` returns each project with `target:{hubId,hostId,instanceId}` and its raw `path`.
   - A new remote project: `commands.remote-hosts` returns authorized machines as `{name,source,target}`, including machines with no project yet. Match the user's machine to this result; ask when ambiguous. `failed` and `complete:false` mean discovery is partial, not an empty catalog. Recover a failed connection rather than guessing another target.
   - Keep all three target identities with the path and session ID; identical paths/IDs on different Hosts are separate resources. Use returned identities unchanged, not a hostname or SSH address as an ID.
3. To register an existing remote directory, run `commands.add-remote` with JSON on stdin:

   ```json
   {"target":{"hubId":"<returned hubId>","hostId":"<returned hostId>","instanceId":"<returned instanceId>"},"path":"/workspace/my-project","label":"My remote project"}
   ```

   - Input: `path` is a literal absolute path on that machine (POSIX or Windows); `label` is optional, at most 80 characters. The remote Host validates/canonicalizes and registers it, then the Hub saves its sidebar reference and notifies connected clients.
   - Completion: success returns `{project,created,target}`; `created:false` means the Hub reference already existed. Use the returned canonical `project.path` for session operations. Registration preserves the active project and does not open a session.
   - Recovery: if interrupted or Hub persistence fails, retry the same target/path. The remote project is retained and registration deduplicates it. No local directory check, clone or filesystem creation is part of this operation.
4. Supply JSON on stdin to the session operation requested by the user:
   - `sessions`: `{target,directory,cursor?}` returns up to 20 metadata rows and `nextCursor`.
   - `read-session`: `{target,directory,sessionID,cursor?}` returns session metadata plus a bounded, transient message page. Follow its continuation receipt to read more; do not copy raw tool output into Hub history, files or caches.
   - `create-session`: `{target,directory,sessionID,title?}` creates an empty worker. Generate a new caller-owned session ID once and retain it through recovery. Read that same ID after an interrupted response before attempting another creation.
   - `prompt-session`: `{target,directory,sessionID,messageID,text}` continues that exact worker. Generate a message ID once. `admitted:true` confirms submission, not task completion; use `read-session` for the outcome. After an ambiguous timeout inspect the same session/message ID before any retry; never resend with a new ID automatically.
5. Report only confirmed outcomes. An unavailable/mismatched target fails explicitly and retains the original reference; recover that connection or ask the user, never retry against the local Host or another connection.

Remote session operations require a registered project scope; `add-remote` establishes that scope on an existing authorized connection. These operations do not configure SSH, synchronize credentials, pair Relay, clone, create directories, select the UI project or obtain new machine access. For a machine not yet authorized, first follow the separate [SSH/Relay workflow](remote-connections.md) with its own bound local desktop helper. After setup completes, rediscover the authenticated target through `remote-hosts`; a project helper alone does not grant that connection permission.
