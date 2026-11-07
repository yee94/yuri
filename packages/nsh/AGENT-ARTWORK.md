# Native Agent artwork

## Ownership and identity

`chat-identity-core.ts` retains the four generated `build` / `plan` / `explore` / `general` templates and their per-seed palette fast path. Other identities call `agent-avatar-runtime.generated.js`, built from the unchanged shared `packages/ui/src/lib/agentAvatarDataUri.ts`. Normalization, Bottts Neutral geometry, attribution, deterministic IDs, URI serialization and the shared 128-entry / 1 MiB LRU remain owned by that renderer. Empty identities use its existing `default` seed; arbitrary and special-property names keep their own faces. Invalid plate colors are rejected before either rendering path.

## Embedded runtime boundary

DiceBear core 10.7.0 requires `structuredClone` in validated Style/Options data. Its public constructors do not accept a clone implementation. `scripts/generate-agent-artwork.mjs` bundles the existing renderer and upstream validators, injecting a lexical import of `cloneAgentArtworkData` only inside the pinned modules that use cloning. It never modifies installed packages or runtime globals and does not replace a drawing/selection algorithm.

`agent-avatar-clone.ts` clones the admitted plain-data domain recursively. Unlike JSON serialization it preserves present `undefined`, numeric values (including negative zero), sparse arrays, own enumerable properties and shared/cyclic references. Prototype-sensitive keys are defined as data properties. Non-plain objects, functions and symbols as values are explicitly rejected; this is not a general structured-clone polyfill. Both upstream schema validators remain in the generated runtime.

The generator audits all six upstream clone sites; the renderer's three loaded modules contain five of them. The unused OptionsDescriptor is tree-shaken. Version/site changes fail generation instead of silently expanding the adapter. The generated metadata records source hashes, clone sites, versions, the output digest and the absence of external imports. The JS artifact retains the upstream MIT license and embedded artwork attribution. Web callers retain their original API and dependency path.

## Regeneration and validation

```sh
bun packages/nsh/scripts/generate-agent-artwork.mjs
bun packages/nsh/scripts/generate-agent-artwork.mjs --check
bunx vitest run --config packages/nsh/task-editor-vitest.config.mts \
  packages/nsh/agent-avatar-clone.test.ts \
  packages/nsh/chat-identity-neutral.test.ts \
  packages/nsh/chat-identity-runtime.test.ts \
  packages/nsh/transcript-tools-identity.test.ts \
  packages/nsh/chat-models-runtime.test.ts
```

Tests compare real Native output to Web artwork, retain the no-React/no-DiceBear-import guard, forbid global clone access, inspect the dependency closure and count repeated-read work. A Node VM with absent globals and an NSH static compilation do not prove QuickJS execution or UIKit presentation; main owns those serialized runtime checks.
