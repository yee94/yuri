# Preview targets and resource graphs

`proxy-runtime.js` owns the existing `/api/preview/targets` registry and
`/api/preview/proxy/:id` HTTP/WS transport. Network targets retain the existing
loopback-origin normalization, resource rewrite, CSP/bridge and redirect behavior.

## Project file target

`POST /api/preview/targets` accepts `{ kind: 'file', directory, path, ttlMs? }`.
`directory` and `path` are absolute physical paths, not serialized Location keys.
Both are canonicalized; the HTML entry must be inside the directory. A Remote
Project's Hub gateway first obtains its registered project/worktree authority and
replaces the submitted root with that authority. A caller cannot grant itself an
arbitrary remote directory. The response is `{ id, kind: 'file', proxyBasePath,
entryPath, previewToken, expiresAt }`; `entryPath` is encoded project-relative path.

File browser URLs use:

```
[Host prefix]/api/preview/proxy/:id/_file/:previewToken/:shortUrlAuthToken/:relativePath
```

All ordinary relative references resolve in the browser: HTML attributes, CSS
`@import`/`url()`, JS static/dynamic imports and fetch, and nested documents retain
the entire target/auth/Host prefix. There is no second static server, global
runtime switch, server-side HTML parser, resource crawler or Relay `srcDoc`
fallback. Existing preview rewriting handles root-relative references; the
existing request bridge recognizes the file envelope for root fetch/Request/URL
inputs. Arbitrary external origins are not rewritten or given Yuri tokens.

`file-preview-path.js` is the shared strict envelope parser. It rejects dot
segments, encoded slash/backslash/control and malformed URI escapes. The only
credential format is the existing short URL token (`yuri_url_` plus 32 base64url
characters). GET/HEAD authentication reads that segment through the normal
ui-auth authorization/revocation gates; the preview token alone is not ordinary
UI authentication. Explicit bearer auth takes precedence. A `-` segment carries
no credential and never bypasses normal authentication.

After Hub authorization, the Remote Host gateway replaces the Hub URL token with
`-` before forwarding over the existing authenticated direct/Relay Host transport.
The Remote's root-resource rewrite emits `REMOTE_PREVIEW_TOKEN_MARKER`, never the
Hub credential; the existing Hub streaming substitution restores a short Hub-side
token. Plain relative URLs need no token serialization in response bodies.
Responses are `no-store`, `no-referrer`, and `nosniff`; the Hub preserves these
policies. Tokens must never enter logs or external-site URLs/referrers.

Every descendant canonicalizes its path again and rejects symlinks outside the
target root. Files are bounded to 100 MiB. Binary assets stream through Express;
text HTML/CSS/JS uses the existing preview rewrite/bridge. Directory resources
resolve `index.html`. Files permit GET/HEAD only; file WebSockets are explicitly
rejected, including when the normal HTTP preview proxy has attached its automatic
upgrade listener. Normal network-preview WebSockets are unchanged.

`DELETE /api/preview/targets/:id` accepts `{ previewToken }` through normal
session/client authorization and origin checks. It is idempotent for an already
missing target. Revocation destroys active responses; expiry checks every request
and terminates active file responses at the deadline. Client disconnect aborts
file reads/streams through the existing transport chain. A failed cleanup after
the captured runtime ends cannot be sent using the next runtime's credentials;
the old server's grant remains bounded by expiry.

## Verification

`file-target.test.js` exercises real production Hub + two Host listeners, real
ui-auth/client revocation, registered directory gateway, every resource kind,
symlink rejection, Host mismatch, target and URL-token expiry, revoke, and 80 MiB
stream cancellation. A separate case uses the real E2EE Relay transport for Host
A, while Host B stays direct. `proxy-runtime.test.js` retains network-preview
regressions. `scripts/remote-project-file-preview-smoke.mjs` exports the same
isolated fixture for browser/platform checks and records a source manifest.

Browser evidence is not Electron main/preload or Capacitor WKWebView evidence.
Those platforms require separate application/gateway/native network checks.
