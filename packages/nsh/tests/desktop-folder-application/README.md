# Desktop folder production-root slice

`Root.tsx` mounts the unchanged `YuriNativeApp`; its sole wrapper observes successful public `Storage.setItem` receipts. No test routes, synthetic navigation buttons, owners or production Props are injected. Folder actions use the existing hover-revealed accessibility labels from `desktop-sidebar.tsx`.

`Host.js` reuses `desktop-application/NavigationHost.js` and extends only exact synthetic folder/create/selection/prompt/read-receipt and read-only task endpoints. Every request requires the exact synthetic Host/lease and envelope. Unexpected writes and GETs fail; no credentials or real Host/network are accessed. The prompt must match the stable input ID observed from the durable receipt. Native journals remain in memory; this is not disk-journal evidence.

The outer `desktop-folder-application-native.test.ts` creates a unique temporary config/generated/output directory, grants only its additional receipt-observation method, and never writes shared `.nsh/test` output.

## Evidence

Fixed NSH 0.4.0 headless engine, macOS and Windows models, five scenarios each:

- First folder action/typing/Agent selection is local-only; first send persists create → folder unknown → membership POST → causal ACK → model/Agent configuration → actual Chat prompt. Source pending input clears after admission.
- Same-directory retarget twice preserves the existing body and attachment with one composer.
- A draft behind an actual Chat is reactivated before folder retarget, without losing body/attachment.
- Dirty TaskEditor `Cancel` keeps the editor, receipt and attachment unchanged; no remote write.
- Lost membership ACK remains unknown through two real read-only retries, a help modal and cold App recovery; one create, one membership POST, zero prompt/configuration replay. Matching membership GET is not treated as a causal ACK.

Validation: focused Vitest wrapper plus `new-session-folder.test.ts` and `new-session-page.test.ts`: 3 files / 38 tests passed; the wrapper contains the 10 real-engine scenarios above.

Not covered: AppKit/Win32 system windows, physical input/hover, visuals, real Host concurrency/network/crashes, native credential storage, native disk durability and unknown-membership manual recovery UX. No production bug was found in this slice.
