# Preview actions and device exports

These are **Yuri** host contracts declared through official `Contract.define`. They do not require a plugin `main`, do not grant filesystem access, and remain separate from OpenCode's experimental IPC.

## Exact structural contracts

```ts
import { Contract } from '@opencode/plugin/gui'

export type Snapshot = { html: string; width: number; height: number }
export type Progress = { stage: 'preparing' | 'capturing' | 'rendering' | 'encoding' | 'saving'; completed?: number; total?: number }
type Options = { signal?: AbortSignal; onProgress?: (value: Progress) => void }
type Limits = { maxHTMLBytes: number; maxWidth: number; maxHeight: number; maxPixels: number }
type Result = { status: 'saved' | 'cancelled' }
export type Surface = {
  readonly element: HTMLElement
  readonly signal: AbortSignal
  snapshot(options?: Options): Promise<Snapshot>
}
export interface PreviewActionsAPI {
  readonly version: 1
  register(input: {
    element: HTMLElement
    capture(options: Options): Promise<Snapshot>
    render(surface: Surface): HTMLElement
  }): () => void
}
export interface PDFAPI {
  version: 1; limits: Limits
  exportPDF(input: { snapshot: Snapshot; filename: string; pageSize?: 'a4' | 'letter' }, options?: Options): Promise<Result>
}
export interface LongImageAPI {
  version: 1; limits: Limits
  exportLongImage(input: { snapshot: Snapshot; filename: string }, options?: Options): Promise<Result>
}
export const PreviewActions = Contract.define<PreviewActionsAPI, 'yuri.previewActions'>('yuri.previewActions')
export const ExportPDF = Contract.define<PDFAPI, 'yuri.exportPDF'>('yuri.exportPDF')
export const ExportLongImage = Contract.define<LongImageAPI, 'yuri.exportLongImage'>('yuri.exportLongImage')
```

The `capturing` stage belongs to preview capture; device export reports preparing/rendering/encoding/saving. Keep the two export capabilities separate: a device may expose one without the other.

## Registration and action flow

Inside the owning Panel's Solid render/component, follow `ctx.use(PreviewActions)` with `createKeyed`. While active and `version === 1`, call `register({ element, capture, render })` and register its returned disposer with `onCleanup`. Registering in `setup`, from an async callback without the owning context, or against another panel's element is invalid.

`render(surface)` creates the plugin-owned toolbar DOM; Yuri places it beside source controls on desktop and in the mobile preview title row. At click time:

1. Read the corresponding export live accessor; hide PDF/PNG actions unless its status is active and version is 1. Keep HTML save independent.
2. Combine `surface.signal` and the action's cancellation signal. Call `surface.snapshot({ signal, onProgress })`; it invokes this instance's latest `capture` and excludes the toolbar.
3. Build static, self-contained HTML with inline styles and data images. Serialize current input values, filters and expanded state; remove executable scripts/external dependencies. Use actual nonzero width/height, not stale initial dimensions. For iframe content, implement a source/frame/revision-checked snapshot message protocol; the host cannot read arbitrary cross-origin DOM for you.
4. Check the returned HTML UTF-8 bytes, width, height and width×height against the export capability's `limits`. Re-read the live accessor after capture and require the same provider generation before calling it.
5. Call `exportPDF({ snapshot, filename, pageSize: 'a4' }, options)` or `exportLongImage({ snapshot, filename }, options)`. Treat saved/cancelled distinctly; surface failure to the user without retrying an already completed save. `EXPORT_UNSUPPORTED` withdraws that action; other failures remain retryable.

Unmount, source-mode switch, retry, disable, replacement and runtime switch dispose the toolbar and abort capture/export. Do not cache the document HTML during toolbar registration. A page/file snapshot belongs to the mounted instance, not to the global active tab.

## Runtime matrix

| Capability | Electron | iOS / Android Capacitor | Web / hosted mobile / VS Code |
| --- | --- | --- | --- |
| Preview action placement | Yes | Yes | Yes |
| PDF / long image | Probe each capability | Probe each capability | Inactive unless the runtime explicitly provides it |
| Connection to local, remote or Relay Host | Current device capabilities, independent of Host location | Same | Same |
| `ctx.system.save({ name, content })` | Browser download path | Native file picker for UTF-8 content | Browser download |

Unlike native plugin `main`, current-device exports can be available in remote/Relay sessions. Never use the Host's filesystem or shell to imitate saving on the user's device. HTML export preserves rerunnable source only when deliberately implemented by the plugin; it is a different artifact from the static native-export snapshot.

## Case study: Eficy

See `src/gui.tsx`, `src/preview-actions.ts`, `src/export-contract.ts`, `src/export-types.ts` and `src/export-toolbar.ts` of https://github.com/yee94/opencode-eficy. Eficy implements iframe capture and an inline toolbar fallback for older hosts without `yuri.previewActions`. That fallback is an integration choice: add compatibility behavior only for hosts the plugin intends to support.

## Verification

For each requested export format, verify current-state capture, saved/cancelled/failed outcomes, limits, capability withdrawal, and cancellation when its view closes. Test multiple mounted previews to confirm each action captures its own content. Native save verification requires the target device; a browser-only test proves only the capture/toolbar contract.
