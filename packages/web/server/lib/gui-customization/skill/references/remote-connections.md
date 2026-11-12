# Remote connections

Use the **exact bound local desktop helper command** advertised in this session's Yuri customization pointer. A script file by itself, a copied binding or another capability's command is not this entry. If the bound command is absent, stop and report unavailable. Otherwise run its `describe`; proceed to the returned `list`, `setup` and `pair` commands only after describe succeeds. Use those commands unchanged, sending mutation input as JSON on stdin. The helper owns authentication and session binding; passwords and client tokens stay inside Yuri. This is a Host capability, not a GUI plugin.

A helper result with `terminal:true` ends the workflow immediately. HTTP 401/403/501 share one admission gate across all operations; another operation cannot recover access. Report the blocked capability and resume only after a supported session's bound `describe` succeeds. Other failures retain the operation-specific recovery in the helper result.

## SSH setup

1. Confirm the user requested connection/setup and configuration transfer. Run `list` to find existing instances. The initiating session stays on the local desktop; changing the focused window is unnecessary.
2. For each supplied address, pipe JSON to `setup`: `{"sshCommand":"ssh user@host -p 2222","nickname":"Build server"}`. Destinations and ports are supported; existing SSH config aliases and keys remain OpenSSH-owned. To retry a saved instance use `{"id":"<id from list>"}`. Options that execute commands, arbitrary SSH flags and password fields are outside this helper's input contract.
3. Start each target independently, then poll `list` until every requested instance has `running:false`. Setup saves/reuses the instance, installs or aligns the managed Yuri/OpenCode runtime, establishes SSH forwarding and pushes configuration. A repeated active setup shares the same target operation. A failed target does not cancel the others.
4. Report each target separately: `phase:ready` confirms SSH/service readiness, `sync:complete` confirms transfer, and `magpie:ready` confirms gateway health. Warnings and failed/missing checks mean partial completion, not success. Authentication/host-key interaction uses the existing native prompt where available; otherwise the user must prepare their SSH key/agent or saved settings. Keep the other targets progressing.

The local Host is the configuration source, regardless of other windows' selected runtimes. If Magpie is **installed**, setup selects its native configuration/authorization transfer when available, provisions the remote headless CLI and verifies its server gateway. An installed but unconfigured source reports `magpie_source_not_configured`; it does not silently switch to a different credential source. Without Magpie, setup uses OpenCode's credential API. Local-path/file plugins are filtered from SSH configuration copies; registry plugins remain.

Remote Magpie startup reuses a healthy gateway or the `yuri-magpie` tmux session. Automatic startup requires a POSIX target with tmux. No desktop environment is needed. Missing tmux, gateway health failure or sync failure leaves a working SSH connection intact with warnings; retry setup after fixing that target. Configuration/accounts already applied remain and existing sync backup rules apply. External/probe-only SSH instances are not modified by this workflow.

### Reconnection and update acceptance

For managed SSH connections, report these checks separately. Use the bound helper or Settings → Remote instances; the availability gate below still applies.

- **Reconnect:** retry the saved instance ID after disconnecting, and again after restarting the desktop. Each attempt must finish with `running:false` and `phase:ready`; open that remote workspace and verify an authenticated operation against its OpenCode service. A prior ready receipt or a standalone web server's health response does not establish this result.
- **Runtime readiness:** the executable selected by managed SSH startup must load its server dependencies, load native modules in the selected runtime, and reach authenticated service readiness. A CLI version response or successful package installation alone is insufficient. Record the actual runtime/package versions when available; otherwise mark that evidence unavailable.
- **Update:** when a different target version is available, reconnect through the normal managed entry. Verify that version alignment completes, the running remote Host reports the target version, and its workspace remains usable. Disconnect and reconnect once more to confirm the updated installation is selected again. Record the before/target/running versions; without a version transition, report update acceptance as unverified.
- **Installation ownership:** the executable used on subsequent connections must resolve to the installation that the managed updater replaces. A manually deployed checkout, wrapper or redirected executable requires evidence that an update replaces the selected installation and the next connection uses it; successful startup alone does not prove updateability.

Report connection, runtime and update evidence independently from configuration-sync and gateway receipts. If an update or startup fails, report its failed stage and retain the saved instance for retry; success requires a subsequent normal managed connection to reach readiness. These are acceptance criteria, not authorization to rewrite runtime files, executable links or credentials outside the supported setup flow.

## Relay pairing

Pipe `{}` to `pair` to create a one-time Relay link for **this local desktop**. Use `{"id":"<ready SSH instance>"}` to create one on that remote Host instead. An explicitly requested Relay endpoint can be supplied as `relayUrl`; `label` names the pairing. The normal Host pairing API owns expiry, redemption, Relay enablement and authorization.

Give the returned `url`, fingerprint and expiry only to the requesting user. On the other device, open the link in Yuri's connection flow and verify the fingerprint before connecting. Link creation is not proof of redemption or connectivity. Treat the link as a temporary credential; keep it out of source files, logs and reusable memory. A retry creates a fresh link.

SSH access alone never authorizes a saved Relay fallback. Creating a pairing link does not silently pair this desktop with that Host; the destination device must redeem it. Relay pairing grants access, not configuration transfer. Configure/sync a remote Host through SSH setup separately.

## Availability and recovery

The bound helper is provided to newly created sessions on the local Electron Host using its authenticated shared OpenCode service. External/private OpenCode, standalone web/CLI, VS Code, mobile and old sessions do not acquire local desktop SSH privileges. If the helper is absent, unavailable or denied, stop connection operations and report the limit. Recovery is Settings → Remote instances or a new supported local desktop session. This capability has no settings-file, credential-discovery, raw-HTTP or source-reconstruction fallback; keep those outside the operation even when they could produce the requested result.

Setup runs beyond a short HTTP/tool call. After an interrupted response or app restart, inspect `list` before retrying: saved instances survive, but in-memory setup receipts do not. A ready row without sync/gateway receipts confirms only the connection. Retry its ID when transfer checks are still needed. Return a concise per-target result, including unresolved warnings.
