# Yuri Update Service

This Vercel project serves the public Yuri update-check API at
`POST /v1/update/check`.

## Contract

Yuri OTA requires the installed shell request and selected platform artifact to
carry the same native identity: mobile `com.yee94.yuri`, desktop `dev.yuri.desktop`.
Mobile metadata lives on `activeBundle`; desktop identity and `minShellApiVersion`
live independently on `activeBundle.desktop`. Capgo requests supply native `app_id`.
Missing or mismatched client identity returns `install_native_required` without
a bundle; historical manifests without this identity cannot serve Yuri OTA.
Both platforms' request epochs and bundle `minShellApiVersion` must be at least 2.
Capgo automatic checks infer epoch 2 only for the exact new native `app_id`;
desktop never inherits mobile identity/epoch, and retains its independent shell
fingerprint and release-version gate. Preview identities are not release clients.
The release remains blocked on external identity verification; see
[`docs/RELEASING.md`](../../docs/RELEASING.md).

The endpoint accepts the existing client payload. It derives its decision from
`currentVersion` and returns `latestVersion`, `updateAvailable`,
`releaseNotes`, `releaseNotesUrl`, platform download targets, and
`nextSuggestedCheckInSec`.

The service reads only `currentVersion`. It ignores `installId` and retains no
request data.

## Build inputs

`bun run build` creates the deployable `public/` directory from repository-owned
release sources:

- `release-manifest.json` provides the latest published version.
- `CHANGELOG.md` provides release notes.
- `public/update-manifest.json` and `public/CHANGELOG.md` are consumed by the
  Edge Function at request time.

The release workflow updates `release-manifest.json` after GitHub publishes a
**stable** release. Semver prereleases (`X.Y.Z-beta.N`, any version containing
`-`) must never be written into this manifest: `write-release-manifest.mjs`
skips them, and `release.yml` finalize-release skips the publish step for
prereleases. Desktop `/desktop/latest*.yml` is the electron-updater feed
already installed by 2.0.0 and earlier. It reads the matching `full*.yml`
from GitHub `/releases/latest` (which excludes prereleases) and falls back
to `latest*.yml` only when that stable release has not published `full*.yml`
yet. Relative installer URLs are rewritten to that same download directory,
so those clients can install the latest stable shell and then use the shared
OTA check. Every following Vercel
deployment serves that published stable version. GitHub Actions needs
repository `contents: write` permission for this manifest commit.

## Vercel setup

| Setting | Value |
| --- | --- |
| Project name | `yuri-update` |
| Root directory | `deploy/update-service` |
| Build command | `node scripts/build.mjs` |
| Install command | none (no package dependencies) |
| Output directory | `public` |
| Framework preset | Other |

Use the release workflows to publish the optional Vercel mirror with
`YURI_OTA_WRITE_VERCEL=true`. Leave Vercel Git auto-deployment disabled.

Yuri Web, CLI, and VS Code use
the explicitly configured update API through the connected
Yuri Server (with optional `YURI_UPDATE_API_URL` override). Capacitor
mobile clients call the public update API **directly** from the app process,
using verified deployment endpoints. Packaged Desktop builds on macOS,
Windows, and Linux use the shared OTA decision endpoint below. `/desktop/`
remains the legacy electron-updater feed: `latest.yml`, `latest-mac.yml`,
`latest-linux.yml`, and `latest-linux-arm64.yml` are served from the stable
GitHub Latest `full*.yml` counterparts. New release CI does not upload
`latest*.yml`.

`YURI_UPDATE_API_URL` remains available as a compatible JSON API
override for Web, VS Code, and server-side package update checks.

## Tests

```sh
bunx vitest run --project @yuriai/update-service
```

Or `bun run test` from this directory.

## EdgeOne transition compatibility

`edgeone.json` and `edge-functions/` serve the preferred domestic OTA entrypoint
and keep the legacy desktop feed available for installed clients. Its build
command writes a complete static distribution to `dist/`, while Vercel builds
`public/`. Both project domains must permit public requests. Legacy installer
feeds continue to reference GitHub release assets. OTA ZIPs live in the GitHub
prerelease `ota-bundles`; EdgeOne keeps local copies, Vercel hosts none (see
below).

## Mobile OTA endpoints

Self-hosted Capgo-style OTA for Capacitor mobile clients.

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/mobile/update/check` | Yuri decision JSON |
| `POST` | `/v1/ota/check` | Capgo self-hosted protocol response |

Both accept CORS preflight (`OPTIONS`) and return `cache-control: no-store`.

### Request body (`/v1/mobile/update/check`)

Required JSON fields:

- `applicationId`: `com.yee94.yuri` for mobile, `dev.yuri.desktop` for desktop, read from the installed native shell

- `channel`: `beta` \| `stable`
- `platform`: `ios` \| `android` \| `desktop`
- `deviceId`: non-empty string (rollout bucketing)
- `nativeVersion`: native marketing version string
- `nativeBuild`: positive integer
- `shellApiVersion`: positive integer
- `currentBundleId`: active OTA bundle id, or `builtin`. On the beta channel this must be the running **web** bundle version, never the iOS marketing version (`1.18.2`). Capgo builtin reports `CFBundleShortVersionString`; the resolver ignores that stripped identity when it matches `nativeVersion`, otherwise every `1.18.2-beta.N` OTA looks like a downgrade. It is also the primary identity for the shell version gate (`minShellReleaseVersion`); beta clients must report the running web package version.
- `installSource`: optional string
- `releaseMajor`: optional non-negative integer (`X` in `X.Y.Z`), explicitly sent by new clients. It must agree with the first parseable identity in `currentBundleId`, then `nativeVersion`. Legacy clients and Capgo requests may omit it; the server derives the same value from those existing fields. A builtin/hash bundle id falls back to the native marketing version; stripping a beta suffix does not change its major.

### Major-version isolation

OTA selection is scoped by **release major × channel**. A 1.x client receives only 1.x bundles on either stable or beta, and a 2.x client receives only 2.x bundles. Beta→stable rollback is permitted only within that major. The running web release identity takes precedence over the native marketing version. An unknown identity or an unpublished major yields `none` without an OTA or native target; it never falls back to another major. Fetch/validation failures still return 503.

New clients also validate the response major and reject mismatched bundles before downloading or reusing cached bundles. This protects them against older update-service deployments that ignore `releaseMajor`. Native Capgo automatic checks use the server-side inferred major. Desktop uses the same resolver with its own artifact and shell gate; Web, hosted mobile and VS Code do not use this OTA path.

Rollout order: deploy this update-service implementation to **both Vercel and EdgeOne before publishing a second major**, then publish using the updated snapshot scripts. Existing clients need no request migration. All subsequent publishing/rollout jobs (including maintenance releases from a 1.x branch) must use the major-aware scripts; older writers drop the catalog. Reverting the service or publishing scripts to a pre-isolation version is not compatible with a multi-major catalog.

### Decision response (`/v1/mobile/update/check`)

```json
{
  "status": "ok",
  "primaryAction": "none | apply_ota | install_native_required",
  "ota": { "state": "current | available | outside_rollout | incompatible", "bundle": { } },
  "native": { "state": "current | available | required", "version": "", "build": 0, "installUrl": "" },
  "nextCheckInSec": 3600,
  "releaseNotes": "optional markdown newer than currentBundleId (not stripped iOS nativeVersion) through OTA releaseVersion or native.version",
  "isChannelRollback": "optional true only for cross-channel beta→stable rollback apply_ota"
}
```

Clients must follow `primaryAction`: `apply_ota` applies the bundle in-app;
`install_native_required` opens `native.installUrl` when present; `none` hides
the update. Do not invent a GitHub URL on the client.

Relative `bundle.url` values are resolved to absolute URLs against the request origin
on EdgeOne. The Vercel entrypoints pass `bundleBaseUrl`, so they return the
`ota-bundles` release asset (`lib/ota-bundle-release.js`) instead; GitHub answers
with a redirect to its storage host. Desktop clients only
check EdgeOne, whose same-origin, no-redirect download contract is unchanged.
When `primaryAction` is `apply_ota` or `install_native_required`, the handler loads
`/CHANGELOG.md` from the same origin as the channel manifest and attaches filtered
`releaseNotes` (same extraction as `/v1/update/check`). The upper bound is the OTA
`releaseVersion` for in-app apply, or `native.version` when the shell must reinstall.
Both Vercel and EdgeOne serve CHANGELOG from their own deployment. EdgeOne copies
the current Vercel CHANGELOG at build time with the live OTA snapshot, not the
potentially stale git-time copy. Update checks never wait for Vercel. Missing or
empty changelog content omits the field.

`isChannelRollback` is present (and `true`) only when all of the following hold:
request `channel` is `stable`, device `currentBundleId` is a prerelease (contains `-`,
e.g. `1.18.4-beta.7`) whose semver ranks above the stable `activeBundle.releaseVersion`,
and the decision is `apply_ota` (intentional cross-channel rollback onto that stable
active). All other responses omit the field. Clients use the flag to treat the apply
as a channel switch rather than a normal upgrade.

### Capgo response (`/v1/ota/check`)

Maps the same resolver decision:

- `apply_ota` → `{ version, url, checksum, session_key?, sessionKey?, is_channel_rollback? }`（Android 解析 `sessionKey`，iOS 解析 `session_key`，加密 bundle 两个键都返回；明文 `checksum` 为纯 64 位 hex，原生插件按字面值比较；跨渠道回退时额外带 `is_channel_rollback: true`）
- `install_native_required` → `{ major: true, breaking: true, message: "native update required" }`
- otherwise → `{ message: "No new version available", version: "", url: "" }`

OTA 只升不降：`currentBundleId` / 带 `-beta.N` 的 `nativeVersion` / 门身份已达到的 `nativeTargets.version` 任一高于 `activeBundle.releaseVersion` 时，不返回 `apply_ota`。例外：请求 `stable` 且设备 `currentBundleId` 为更高的 prerelease 时，允许 `apply_ota` 回退到 stable active，并标记 `isChannelRollback` / Capgo `is_channel_rollback`。同版本不同 `bundleId` 仍可作内容更正。原生壳下限用版本号 `activeBundle.minShellReleaseVersion`（`mode: native` 发布时写入本轮版本）；比较沿用 semver，同 core 的 stripped stable（如 `1.18.3` / `1.19.0`）高于任何同 core prerelease 门（`1.18.3-beta.1` / `1.19.0-beta.37`），因此该身份过门并 `apply_ota`。detectability verifier 的 live old iOS 画像使用语义上真实低于 gate 的 stripped 身份（`versionBelow(stripPrerelease(gate))` 再 strip）；`stripPrerelease(versionBelow(gate))` 对 beta 门会塌成同 core stable。`platforms.*.minNativeBuild` 仅存量兼容，build 号不再参与任何判定。壳内嵌 web（Capgo `builtin`）必须把已烘焙的 `__APP_VERSION__` 当作 `currentBundleId` 上报；仅当 active 为 **stable**（非 prerelease）且门身份（`currentBundleId` 或回退 `nativeVersion`）不低于 `activeBundle.releaseVersion` 时视为已内嵌。beta active 时 iOS 剥离营销版号（如 `1.18.4`）不能证明内嵌了 `1.18.4-beta.N`，不得走 embedded → 仍 `apply_ota`。

Manifest load failure returns `503 { "error": "ota_manifest_unavailable" }` on both endpoints (never a forged no-update).

Capgo clients typically send `platform`, `device_id`, `app_id`, `version_build`, `version_code`, `version_name`, and `defaultChannel`.

### Channel manifest

Static file: `ota/channels/<channel>.json` (seeds: `ota/channels/beta.json` and `ota/channels/stable.json`). Both beta and stable channels are served the same way.

Schema summary (`schemaVersion: 1`):

- `channel`, `generation`
- `activeBundle`: full bundle metadata, or `null` when OTA is enabled but nothing is published yet
  - `applicationId`: `com.yee94.yuri`; historical records may parse without it but are never offered as Yuri OTA
  - `minShellReleaseVersion` (optional): semver `X.Y.Z` / `X.Y.Z-beta.N`；原生壳能力下限，低于此版本 → `install_native_required`。同 core stripped stable 高于 prerelease 门；verifier old-shell 使用真实低于 gate 的版本身份
  - `platforms.ios|android.minNativeBuild` (**deprecated**): 存量 manifest 兼容读取；判定已不使用
- `nativeTargets.ios|android`: optional `{ version, build, status?, installUrl? }`
- `rollbackBundleIds`: 0–2 hex bundle ids
- `activeBundle.desktop` (optional for legacy manifests): `{ applicationId: "dev.yuri.desktop", minShellApiVersion: 2, bundleId, url, size, checksum, shellFingerprint, minShellReleaseVersion }`. The desktop ZIP has the desktop `index.html` and `desktop-ota.json` (`applicationId: "dev.yuri.desktop"`, `shellApiVersion: 2`); mobile's existing bundle may remain Capgo-encrypted. Both artifacts share the parent release version, channel, rollout and generation. A legacy manifest without this field offers no desktop OTA. A desktop record missing its identity or epoch requires a new native install; it never inherits the mobile record's fields.
- `nativeTargets.desktop`: installer release target when the desktop shell, dependencies or shell-shared backend modules are incompatible. Ordinary backend source updates ship with the desktop UI ZIP. The desktop gate compares `nativeVersion`, not `currentBundleId`; current UI identity still controls upgrade/rollback and major isolation.
- `rollbackBundles`: up to two full prior bundle records keyed by `rollbackBundleIds`. Snapshot/rollout mirrors their desktop ZIPs as well as mobile ZIPs. New rollbacks restore original versions, checksums, encryption metadata and shell floors; legacy rollback entries without desktop metadata cannot be used to reconstruct a desktop bundle.
- `majorReleases` (optional): map of other major numbers to complete schema-v1 channel manifests, with no nested `majorReleases`. The root remains the most recently published/modified lane for existing publishing consumers; the resolver selects by client major, never by the root's recency. Root and archived lanes must have distinct majors, the same channel, and same-major native targets/shell floors. Legacy manifests without the map remain readable. An empty legacy seed belongs to major 1.

`assemble-snapshot.mjs` selects previous state by the release's major, so generation, rollback ids, native targets and shell floors are independent per lane. It archives the previous root when switching majors and mirrors all lanes and their active/rollback zip files in both channels. `rollout.mjs --major X` targets a specific lane; omission retains the legacy default of the root lane. The rollout workflow exposes the same `major` input. Invalid catalogs or missing referenced bundles abort snapshot creation before deployment.

Stable publishing also advances the same-major beta lane to the stable bundle unless beta already has a higher release version. Beta keeps its channel identity, independent generation, two most recent rollback records (including their ZIPs), and other major lanes. The promoted bundle shares stable's mobile/desktop artifacts, rollout and shell gates. Full releases synchronize finalized native targets before deployment. Beta publishing never advances stable.

CI uploads ZIPs to the GitHub `ota-bundles` prerelease before publishing the
channel manifests. EdgeOne builds `dist/` from the checked-out manifests and
CHANGELOG, and downloads the ZIPs from GitHub. Vercel, if enabled, receives the
same channel manifests and serves no ZIPs.

Stable finalization and OTA publishing share the `mobile-ota-production` lock.
When a stable release explicitly skips OTA, finalization refreshes EdgeOne with
the new stable version manifest and the existing OTA snapshot.

### Cache rules

| Path | Cache-Control |
| --- | --- |
| `/ota/bundles/(.*)` (EdgeOne full GET; Vercel serves none) | `public, max-age=31536000, immutable` |
| `/ota/bundles/(.*)` (static `Range`) | Provider-native byte-range serving; verified as `206` with exact bytes |
| Legacy proxy partial responses | `no-store` (never edge-cache partial bodies) |
| `/ota/channels/(.*)` | `no-cache, max-age=0` |
| `/ota-distribution.json` | EdgeOne: `no-cache, max-age=0, must-revalidate` |
| `/CHANGELOG.md` | Vercel static: `max-age=300`; EdgeOne: `max-age=0, must-revalidate` |

### Deploying bundles and channels

CI reads the current channel state from EdgeOne and uploads all retained ZIPs
as `<bundleId>.zip` assets of the GitHub prerelease `ota-bundles`. During migration,
if a ZIP is not yet on GitHub, CI copies the existing static ZIP from EdgeOne.
CI commits both channel manifests to `main` via
`scripts/mobile-ota/commit-edgeone-manifests.sh`, then calls the production hook
stored in `YURI_EDGEONE_DEPLOY_HOOK` even if neither manifest changed. A hook
acknowledgment does not establish that deployment succeeded.

EdgeOne builds from the checked-out manifests and CHANGELOG. It fetches only
ZIPs from GitHub Releases, with at most three concurrent downloads; duplicate
references download once and bytes must match the ID, size and available hash.
Missing or corrupt content fails the build before activation. The checked-out
snapshot keeps metadata consistent without a Vercel build-time dependency.
CHANGELOG remains static-only; the dynamic `/ota/*` fallback serves historical
ZIPs from GitHub and is not accepted by the readiness gate.

CI verifies the `/ota-distribution.json` marker, both manifests, all retained
mobile and desktop ZIPs and exact `206` range bytes on EdgeOne. OTA releases also
verify client detectability. If `YURI_OTA_WRITE_VERCEL=true`, CI independently
deploys and verifies the Vercel mirror using the same snapshot. Mirror failures
are reported by their GitHub Actions step and do not fail EdgeOne publication.

`refresh-distribution` preserves the live EdgeOne version, generation, rollout
and native targets and explicitly requests an EdgeOne build. No App rebuild or
new release version is needed. It also republishes Vercel when enabled.

### Automatic service-code deployment

`.github/workflows/update-service.yml` tests update-service code changes pushed
to `main`, then calls the same rollout workflow with `refresh-distribution`.
This reuses the production lock, complete-snapshot deployment and EdgeOne
download/Range gate. It additionally compares the marker's `sourceSha256`
against this checkout's service code/configuration, so an older deployment with
identical OTA assets cannot prematurely pass a service-code rollout. It does
not build an App, change its version or upload an
installer. Manifest-only bot commits are excluded from the push trigger to
avoid recursive deployment. Normal release and rollout workflows already run
the same distribution gate, so routine publishing needs no console login.

One-time EdgeOne setup must point the Git project at `yee94/yuri`, branch
`main`, root `deploy/update-service`. Create a deployment hook for `main` in project settings and save its URL
as the repository Actions secret `YURI_EDGEONE_DEPLOY_HOOK` (inherited by the
reusable rollout workflow). CI uses this hook rather than depending on Git push
callbacks or commit skip directives. Keep Git automatic deployment disabled once
the hook-driven workflows are active, so Actions owns the production lock and
there are no competing Git-triggered builds. A hook acknowledgment is only a
request receipt; the complete download, Range and current-code gates remain the
authority for success. `edgeone.json` overrides console build/output settings.
A retired/backup repository binding
cannot receive current manifest commits; matching proxied OTA versions does
not prove that the project deployed current code. Verify the distribution
marker, not only its manifest version.
