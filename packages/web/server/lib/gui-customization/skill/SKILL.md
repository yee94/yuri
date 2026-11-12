---
name: yuri-customization
description: Add existing directories as Yuri projects through its API, configure SSH connections, configuration sync and Relay pairing, or customize its GUI through plugins for appearance, pages, widgets, previews, panels and settings.
---

# Yuri customization

For adding an existing directory to Yuri's project list, follow [projects](references/projects.md) using this session's bound project API helper. Registration is separate from creating files, cloning or opening a conversation.

For SSH setup, configuration sync or Relay pairing, first check this session's pointer for its exact bound local desktop helper command. Without that command, report unavailable and stop this branch: a script file or another capability's binding does not enable it. With the command, follow [remote connections](references/remote-connections.md). For UI changes, use the plugin workflow below. Its GUI contracts describe Yuri's supported subset of the experimental OpenCode GUI SDK 2.2.0, not every capability in the newest upstream Desktop.

## Workflow

1. Identify the requested change and target client: Web, Electron, VS Code, hosted mobile, or Capacitor. Separate visual changes from backend behavior. Inspect the user's existing plugin/config before changing it. An explanation request does not authorize installation.
2. Choose the extension point by the requested capability and read its reference:
   - Every plugin-owned view: [CSS variables and styling](references/plugin-styles.md); use the host's existing tokens in plugin-owned CSS to follow Yuri's appearance.
   - Existing UI blocks, backgrounds/transparency, selectors, spacing and built-in style tokens: [UI structure and styles](references/ui-surfaces.md). Start here for CSS changes before inspecting application bundles.
   - Themes, CSS, logos, Dock icons: [appearance](references/appearance.md).
   - Global main-content tabs and titlebar entries: [global pages](references/global-pages.md).
   - Widgets under Changes in the conversation's status column: [work-status widgets](references/work-status.md).
   - Entry/tab icons or icons inside plugin content: [icons](references/icons.md), including direct SVG/data-URI icon strings, supported names, same-document SVG usage and artwork boundaries.
   - Custom file suffixes, parsers, inline/mobile previews and file icons: [file previews](references/file-previews.md).
   - Preview toolbar placement, PDF/PNG/HTML export and iframe snapshot boundaries: [preview actions and exports](references/preview-exports.md).
   - Panels, commands, settings, files, RPC, lifecycle, runtime support: [GUI API](references/gui-api.md).
   - Every implementation: [direct-CJS package, installation, updates and rollback](references/workflow.md); compilation is an optional branch.
3. Default to `package.json` plus a directly authored `gui-experimental.cjs`, using host-provided modules and inline CSS/assets. This needs no dependency install or compilation. Implement only the requested capabilities; use the optional build branch when TS/TSX or dependency bundling is actually needed.
   Yuri's React shell owns the container; the plugin owns its Solid/DOM content. Share visual style through CSS variables and icon references, not host React components or a host-provided Solid component library.
4. Syntax-check the exported CJS file and install within the requested scope, preserving unrelated global OpenCode configuration. A local CJS edit reloads through the existing watcher; project-only configuration does not provide window GUI inventory.
5. Verify each requested capability in the target client, including its failure and cleanup behavior; use the matching reference's verification criteria. Finish with the plugin directory, changed settings, verified behavior, known limits, and how to undo it.

References distinguish host contracts from illustrative templates and case studies. Choose rendering, authentication and file formats for the current requirement; case-study protocols and dependencies belong to those integrations.

## Source fallback

If the references and target UI leave the relevant selector, style owner or extension behavior unclear, inspect the implementation at https://github.com/yee94/yuri. Prefer the tag matching the installed Yuri version; use `main` for development builds. Start from the source-owner paths in [UI structure and styles](references/ui-surfaces.md) or the matching capability reference, and read the owning component/style/host module to resolve the specific uncertainty. Repository source is a lookup fallback; customization still goes in the plugin.

## Boundaries

- `Style` can affect the whole document. A GUI plugin is trusted JavaScript, not a sandbox. Prefer tokens and narrow, stable selectors; arbitrary CSS can hide controls or trigger network requests.
- Yuri themes and branding are host-consumed custom registries, declared with official `Registry.define`; they are not official OpenCode built-ins. Other hosts may ignore them.
- Enabled plugins apply their appearance contributions automatically; [appearance](references/appearance.md) defines priority and fallback. Saved base theme preferences remain separate.
- macOS customization means the running Dock icon only. Keep signed `.app` resources, Finder/Launchpad icons, bundle identifiers and update origins unchanged.
- Native `main` runs only for trusted local Electron connections. Remote/Relay, Web, VS Code and mobile cannot execute local Node/Electron code. Use supported window APIs there; never bypass the native gate.
- Pre-JavaScript startup screens retain Yuri's built-in branding. Plugins load after the usable shell; never delay startup to apply a skin.
