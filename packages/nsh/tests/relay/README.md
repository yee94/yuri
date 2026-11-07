# Native Relay interoperability regression

From the repository root:

```sh
bunx --package vitest@4.1.11 vitest run --config packages/nsh/vitest.config.ts packages/nsh/relay-native.test.ts
```

The test requires macOS, `xcrun swiftc`, and Bun on PATH. Other environments show
an explicit skipped suite with the missing platform/toolchain in its name. Once
those tools are available, compilation and runtime failures are test failures.
There are no NSH, Simulator, external Relay, credentials, or extra dependencies.

Vitest compiles the production `ios/RelayTunnel.swift` with `Runner.swift` in Swift
5 mode, starts the loopback Bun fixture on a random port, and runs six scenarios:

- Eight simultaneous 300 KB requests share one channel, cross the 64 KiB frame
  budget, and receive interleaved byte-identical responses with distinct bodies.
- SSE headers precede data; chunks split inside UTF-8 and retain exact bytes.
- Cancelling a live SSE delivers `StreamAbort`; another request and the shared
  connection survive. Synchronization waits for actual data, not a startup sleep.
- Replayed ciphertext and a corrupted GCM tag on a **fresh** counter both fail
  closed. The next request establishes a fresh cryptographic session.
- HTTP bearer stays inside encrypted request headers. Missing bearer returns 401;
  the outer WebSocket accepts only public v/role/serverId routing metadata.

The fixture imports the existing JS Host `e2ee.js` and `tunnel-codec.js`; it does
not reproduce crypto, key derivation, frame encoding, or counter validation.
Its HTTP routes and bearer comparison are test fixtures, not the production Host
authorization gate. These tests prove native/JS wire interoperability on macOS,
not iOS networking, deployment routing, or production pairing permissions.

Each runner has a 10-second process deadline; compilation has 45 seconds and
fixture startup 5 seconds. All paths derive from the test location, generated
binaries live in an `os.tmpdir()` task directory, and teardown terminates the
fixture and removes that directory even after failure. No files are generated in
the repository and no keys or credentials are persisted.
