# Desktop Commands production-root fixture

`desktop-commands-application-native.test.ts` mounts the actual `YuriNativeApp`
under NSH 0.4.0 headless, running 25 scenarios on each of the macOS and Windows
models (50 total). The synthetic Host does not access credentials, a real model,
network services or physical AppKit/Win32 windows.

## Exact native writer grants

All prompt, compact, create and initial-selection mutations in the Commands and
compact fixtures call the shared `createDesktopWriterHost.assertWrite` before
recording a write or simulating a lost ACK:

- Existing-session prompt and compact require `{kind:'session',id:sessionID}`.
- Session create requires `{kind:'new-session',id:directory}` for the exact source
  directory, not a session ID or another directory.
- Created-session prompt, model and Agent configuration require
  `{kind:'session',id:createdID}`. Neither the original session grant nor the
  still-live new-session source grant authorizes these writes.

The private session fixture shares prompt admission and receipt verification
without rewriting mutation paths. Only read-only GET snapshots reuse the
navigation fixture's original-session routes. Recorded requests and returned
prompt/checkpoint session IDs retain the actual created target. No fixture
acquires a writer grant on behalf of a request.

## Verification

The wrapper also runs 45 direct Host-boundary tests: six mutation producers each
reject unissued, omitted, wrong-target, wrong-kind, released and old-lease grants,
and accept an exact live grant (42 tests); three post-create tests reject reuse
of the still-live directory source grant for prompt/model/Agent. Lease tests
rotate the native scope, then submit the old grant with the current lease, so
static Host checks cannot substitute for grant validation. Rejected requests
must leave the mutation record empty; accepted requests keep their original path.

Latest focused result: 46 Vitest tests passed, including the wrapper's 50 actual
application scenarios. Both edited Host files pass `node --check`.

The independent `local-compact-writer-native.test.ts` was also rerun: its six
headless scenarios currently fail because its `Root.tsx` calls `createChat`
without supplying the desktop `writerGrant` dependency. The stricter compact
Host now rejects those writes. That fixture is outside this change's allowed
files; the production-root compact scenarios pass and the Host guard remains
strict. See [compact contract](../local-compact-writer/README.md).

`bun run dead-code` could not load the web Vite config because
`vite-plugin-pwa` is missing; no clean dead-code result is claimed. Real Host,
model, native-window, physical-input and visual parity remain unverified here.
