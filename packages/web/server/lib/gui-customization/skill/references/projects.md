# Add a project

Register an existing directory through the **bound project API helper** in this
session's Yuri customization pointer. This is a Host capability, not a GUI plugin
or a desktop deep link. Registration does not create files, clone a repository,
open a conversation or switch an existing active project.

## Workflow

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
`{sessionID, operation: "describe" | "list" | "add", input}`. It uses the same
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
