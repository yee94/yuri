# UI Auth Module Documentation

## Purpose
This module owns Yuri UI authentication for browser access, including password session auth, WebAuthn passkeys, and trusted-device session handling.

Trusted-device access has one durable credential model: a remote client bearer token stored by `packages/web/server/lib/client-auth/remote-clients.js`. Password, passkey, and Pairing v2 are issuance methods for that credential, not separate credential systems. Issued client tokens are returned once, stored server-side only as hashes, and are later authenticated via `Authorization: Bearer yuri_client_...`.

An expired UI session cookie does not invalidate a current client bearer. Both
`requireAuth` and `/auth/session` accept that client independently, including
SSH-issued and paired credentials. UI-session-only routes retain their separate
gate. Clients must recheck `/auth/session` before interpreting a feature API's
401/403 as a UI logout; Relay pairing admission failure and Relay socket routing
authentication failure are distinct from UI password expiry.

Relay admission additionally requires an active client record with `usesRelay: true`, `authMethod: 'pairing'`, and a pairing ID. `authorizeRelayRequest` enforces this before the tunnel forwards any HTTP/SSE request or WebSocket upgrade, including when the Host has no UI password. SSH/password/passkey credentials, owner cookies, and direct-only pairings do not grant Relay access. URL tokens resolve back to their issuing client and recheck current revocation/expiry and Relay permission. The only pre-credential route is `POST /api/client-auth/pairing/redeem`; its one-time secret validation also requires a Relay-enabled pairing when arriving through Relay. Direct authentication behavior is unchanged.

Pairing v2 is implemented by `packages/web/server/lib/client-auth/pairing.js`. It stores short-lived one-time pairing sessions with hashed secrets, exposes create/cancel/redeem routes under `/api/client-auth/pairing/*`, and redeems a valid pairing secret into the same remote client token used by password/passkey trusted-device flows.

Client deduplication is scoped by device `dedupeKey`, `usesRelay`, and the pairing's canonical `relayUrl`. The create route records the actual advertised Relay candidate (including a default or environment-selected endpoint), and redemption uses this stored scope even when it arrives over LAN. Re-pairing through the same Relay replaces that connection's credential; another Relay or direct-only pairing retains an independent client record, label, credential, and revocation. The endpoint is internal persistence metadata, not a client-supplied redemption override. Legacy records without `relayUrl` remain readable with an unknown Relay scope; new endpoint-specific pairings preserve them rather than guessing which connection to overwrite. No stored credential conversion is needed.

## Entrypoints and structure

Remote desktop uses the exact `/api/remote-desktop/ws` scoped URL-token path, mirrored in the Relay tunnel allowlist. Its own upgrade gate additionally rejects password-less owner cookies and checks origin even when password auth is disabled; see `../remote-desktop/DOCUMENTATION.md`.
- `packages/web/server/lib/ui-auth/ui-auth.js`: UI auth controller runtime, cookie/session issuance, rate limiting, and auth route handlers.
- `packages/web/server/lib/ui-auth/ui-passkeys.js`: passkey store and WebAuthn registration/authentication verification helpers.
- `packages/web/server/lib/client-auth/remote-clients.js`: trusted-device client token storage, bearer authentication, last-used tracking, and revocation.
- `packages/web/server/lib/client-auth/pairing.js`: short-lived Pairing v2 sessions and one-time secret redemption into trusted-device client tokens.

## Public exports (ui-auth.js)
- `isUrlAuthWebSocketPath(pathname)`: true when a WebSocket upgrade may authenticate with `yuri_url_token` (exact terminal/dictation/event/realtime-proxy paths, plus prefix `/api/preview/proxy/` for Preview HMR). Keep in sync with tunnel-host `isTunnelWsPathAllowed`.
- `createUiAuth({ password, cookieName, sessionTtlMs, readSettingsFromDiskMigrated })`: creates UI auth controller with methods:
  - `authorizeRelayRequest(req)`
  - `enabled`
  - `requireAuth(req, res, next)`
  - `handleSessionStatus(req, res)`
  - `handleSessionCreate(req, res)`
  - `handlePasskeyStatus(req, res)`
  - `handlePasskeyRegistrationOptions(req, res)`
  - `handlePasskeyRegistrationVerify(req, res)`
  - `handlePasskeyAuthenticationOptions(req, res)`
  - `handlePasskeyAuthenticationVerify(req, res)`
  - `handlePasskeyList(req, res)`
  - `handlePasskeyRevoke(req, res)`
  - `handleResetAuth(req, res)`
  - `ensureSessionToken(req, res)`
  - `dispose()`

## Public exports (ui-passkeys.js)
- `createUiPasskeys({ passwordBinding, readSettingsFromDiskMigrated, storeFile, rpName, challengeTtlMs })`: creates passkey runtime with methods:
  - `enabled`
  - `getStatus(req)`
  - `listPasskeys(req)`
  - `revokePasskey(req, passkeyId)`
  - `clearAllPasskeys()`
  - `beginRegistration(req, { label })`
  - `finishRegistration(payload)`
  - `beginAuthentication(req)`
  - `finishAuthentication(payload)`
  - `dispose()`
