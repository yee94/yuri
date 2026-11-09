# Readonly BTW model label

`desktop-btw-selection.tsx` mirrors the actual Web `BtwComposer.modelControl`
(`packages/ui/src/components/layout/BtwPanel.tsx`): only `NativeModelLogo` and
the model display name. There is no button, Agent/variant label, picker, catalog
owner, request, sender or selection writer. The abandoned picker implementation
and its scenarios were replaced in this slice, not installed elsewhere.

## Main API

```tsx
<NativeDesktopBtwPanel
  // Existing exact store/scope/authority/current and lifetime props stay unchanged.
  renderSelection={slot => <NativeDesktopBtwSelection
    slot={slot}
    label={headerModelLabel()}
    current={exactGuard}
  />}
/>
```

`NativeDesktopBtwSelection` props:

```ts
{
  slot: NativeBtwSelectionSlot;
  label?: { providerID: string; modelID: string; label: string } | null;
  current?: () => boolean;
}
```

`label` is the already-resolved, route/Host-scoped projection from the main Chat's
existing catalog owner, not a catalog/provider collection or a loader. Both model
and provider must match the slot's complete selection snapshot. Mismatched,
absent or blank labels use the same Web `getProviderModelDisplayName(undefined,
modelID)` fallback. The component never combines model/Agent/variant sources or
alters the snapshot. The caller still fences the projection by actual Host/route;
matching IDs alone cannot establish Host authority.

No complete snapshot means no control or placeholder. `current`/`slot.current`
failure hides stale metadata. Pending retains the readonly label, as Web does;
there is no interaction to enable during pending. Hide/show and cleanup do not
clear either composer or BTW state. No global interaction blocker is registered.

## Validation boundary

`desktop-btw-selection-native.test.ts` creates an independent temporary NSH config
and runner; it does not write to the package's shared `.nsh/test`. The real
production Panel/label run on NSH 0.4 macOS and Windows headless platform models:

- readonly/non-pressable rendering, shared humanized fallback and exact label port;
- no Agent/variant UI or picker, no snapshot mutation or extra Host requests;
- 50 edits, hide/show, then another 50 edits: zero label-port reevaluations caused
  by typing and zero catalog requests;
- absent/partial snapshots, wrong provider/model and retired route projections;
- complete Agent/variant snapshot preservation and pending/current draft retention.

These are synthetic fixtures, not AppKit/Win32 visual, real Host or model tests.
