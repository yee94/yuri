# Quota production operation recovery

`settings-quota-production-recovery.test.ts` executes the actual `quotaOwner`, the actual Settings operation lifetime, the extracted production `captureHostOperation` declaration, and runtime request binders with scheduled in-memory signals. It does not start NSH or replace Native authority tests.

The initial callback regression failed before the change: after same-Host suspension and confirmed foreground adoption, the permanently disposed controller retained `open:false` and `status:null`. The production owner now retains its controller and status/receipt/recovery state, replaces only its explicit operation, and captures each sender and validity fence before awaiting. Cover/background clears credential drafts as required by the existing quota security contract; operation replacement alone preserves the form data and validation result. A retired read/finally cannot release a replacement flight or apply an old ACK. Interrupted mutations keep `read-required` until an authoritative read; neither recovery nor returning via Back replays a write.

Prepared engine scenarios require both `shows()` and `enabled()` for quota inputs. `enabled()` alone was insufficient to establish that a loading page had actually mounted the input. Public Back, Host-global routes without directory, exact scope forwarding, summary read-back and zero rejected requests remain asserted.

The quota route's `active` expression represents the actual top route and captured Host identity. `captureHostOperation` and the quota owner fence old generations and admit a fresh operation only after confirmed same-Host recovery. Main has independently corrected this integration and the Chat keyboard/application effect loop.

The quota Host fixture no longer nests the navigation Host router. It owns one synthetic scope source for snapshots, HTTP, stream admission and cleanup, with read-only domain data in `settings-quota-production-reads.js`. Requests retain their caller-supplied `expectedHost`; no latest scope is injected and no field is stripped to bypass another router. `connection.select` and the test-realm foreground input rotate the synthetic UUID and retire streams; rename preserves it. The foreground input is supplied only by the test driver, never exposed as an application native capability. Background snapshots have `runtimeScope:null`.

Stream and stop use the exact current Native payload keys. A stale stream is rejected and counted. As in `RuntimeBridge.swift`, a well-formed old cleanup stop succeeds only as a no-op when the stored stream's Host/lease does not match; it cannot release a replacement stream. The audit records accepted streams and whether each cleanup actually released one. Pure controls cover current streams on both Hosts, A → B → A lease renewal, foreground renewal, stale rejection counts and malformed payload rejection. The prepared visibility scenario supplies the same foreground input before root foreground snapshot adoption and retains its zero-rejected assertion.

The ordinary quota flow allows only the background history monitor's exact `GET /api/yuri/history-import/jobs`, returning `[]`, with a required current `expectedHost` and no query/body/extra fields. Web `SidebarBackgroundTasks` owns this jobs read; `/job` belongs to the import step. Therefore `/job`, `/scan`, other history routes and all history writes remain rejected. The pure positive control has exactly one jobs read and zero job/scan reads; every prepared engine scenario asserts the zero job/scan budget as well as exact jobs method/path/scope. This deliberately exposes an over-reading root monitor rather than supplying a stub for it.

Pure/static validation from the repository root:

```sh
NSH_QUOTA_PRODUCTION_ENGINE=0 bunx --no-install vitest run --config packages/nsh/vitest.config.ts packages/nsh/settings-quota-production-recovery.test.ts packages/nsh/settings-quota-production.test.ts packages/nsh/settings-quota-credentials-core.test.ts packages/nsh/settings-quota-credentials-fixture-host.test.ts packages/nsh/settings-quota-credentials-locale.test.ts
./node_modules/.bin/tsc --noEmit --project packages/nsh/settings-quota-production.tsconfig.json
```

The static test bundles the real production application graph and all five prepared drivers. Only main runs `NSH_QUOTA_PRODUCTION_ENGINE=1` serially. These checks do not establish UIKit, device, real Host or Native authority correctness.
