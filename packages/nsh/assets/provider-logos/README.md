# Native Wafer artwork

`wafer.ai.png` is generated exclusively from the embedded `data:image/png;base64`
payload in `packages/ui/src/assets/provider-logos/wafer.ai.svg`. It retains every
original PNG byte (93×92 pixels); it is not a rasterization, replacement, download,
or new logo. The shared Web SVG and provider/model matching remain unchanged.

NSH 0.4 does not render that SVG's `<image>` element. The native provider adapter
statically imports this single PNG into `Image`, with the existing 16×16 contain
layout and no template tint. Other provider assets retain their current behavior.
The generator accepts only the existing full-viewport 24×24 wrapper, and rejects
additional SVG content or transforms instead of silently discarding them.

Regenerate offline from the repository root:

```sh
node packages/nsh/scripts/generate-provider-raster.mjs
node packages/nsh/scripts/generate-provider-raster.mjs --check
```

`wafer.ai.generated.json` declares the source and output SHA-256, byte length,
dimensions, and generator. `--check` does not write files or access the network.
The focused regression checks the production adapter's Bun asset graph, original
byte identity, and regeneration. It does not run the NSH engine or UIKit.

## UIKit acceptance boundary

In an existing session whose Host quota response includes a `wafer.ai`, `wafer-ai`,
or `wafer` provider group, open `chat-header-metadata` (AX label from
`mobile.header.openMetadataAria`). In `chat-metadata-panel` → `chat-quota-panel`,
visually inspect the 16×16 artwork beside that provider's name in light and dark
mode. The image is deliberately `accessible={false}`, so it is not an individual
AX node; use the provider name and panel IDs to locate its frame. Check that the
original multicolor PNG appears rather than a blank square, a tinted silhouette,
or the `stack` fallback. An absent Wafer quota group cannot verify this fix; the
composer's model picker uses a separate model-brand resolver and is not this
production entrypoint. Static checks alone do not establish UIKit display.
