# Projects

Register an existing directory through the **bound project API helper** in this
session's Yuri customization pointer. This is a Host capability, not a GUI plugin
or a desktop deep link. Registration does not create files, clone a repository,
open a conversation or switch an existing active project.

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
