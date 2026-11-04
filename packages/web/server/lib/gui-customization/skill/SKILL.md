---
name: yuri-customization
description: Customize Yuri through GUI plugins for appearance, global pages, custom file previews, export actions, panels, commands, and settings.
---

# Yuri customization

Use a standard OpenCode GUI plugin to change the running Yuri UI without modifying Yuri's source or installation. This skill describes Yuri's supported subset of the experimental OpenCode GUI SDK 2.2.0, not every capability in the newest upstream Desktop.

## Workflow

1. Identify the requested change and target client: Web, Electron, VS Code, hosted mobile, or Capacitor. Separate visual changes from backend behavior. Inspect the user's existing plugin/config before changing it. An explanation request does not authorize installation.
2. Choose the extension point by the requested capability and read its reference:
   - Themes, CSS, logos, Dock icons: [appearance](references/appearance.md).
   - Global main-content tabs and titlebar entries: [global pages](references/global-pages.md).
   - Custom file suffixes, parsers, inline/mobile previews and file icons: [file previews](references/file-previews.md).
   - Preview toolbar placement, PDF/PNG/HTML export and iframe snapshot boundaries: [preview actions and exports](references/preview-exports.md).
   - Panels, commands, settings, files, RPC, lifecycle, runtime support: [GUI API](references/gui-api.md).
   - Every implementation: [package, build, install, verification and rollback](references/workflow.md).
3. Build only the requested capabilities in a user-approved plugin directory. Use declarative registries for appearance, window APIs for GUI behavior, and a server or native part only when the required capability needs it. Keep dependencies aligned with the supported SDK contract and emit the GUI as one prebuilt CommonJS file.
4. Build and inspect the actual artifact. Preserve unrelated global OpenCode configuration. Install only when asked, using the plugin package's global config entry; project-only configuration does not provide window GUI inventory.
5. Verify each requested capability in the target client, including its failure and cleanup behavior; use the matching reference's verification criteria. Finish with the plugin directory, changed settings, verified behavior, known limits, and how to undo it.

References distinguish host contracts from illustrative templates and case studies. Choose rendering, authentication and file formats for the current requirement; case-study protocols and dependencies belong to those integrations.

## Boundaries

- `Style` can affect the whole document. A GUI plugin is trusted JavaScript, not a sandbox. Prefer tokens and narrow, stable selectors; arbitrary CSS can hide controls or trigger network requests.
- Yuri themes and branding are host-consumed custom registries, declared with official `Registry.define`; they are not official OpenCode built-ins. Other hosts may ignore them.
- Enabled plugins apply their appearance contributions automatically; [appearance](references/appearance.md) defines priority and fallback. Saved base theme preferences remain separate.
- macOS customization means the running Dock icon only. Keep signed `.app` resources, Finder/Launchpad icons, bundle identifiers and update origins unchanged.
- Native `main` runs only for trusted local Electron connections. Remote/Relay, Web, VS Code and mobile cannot execute local Node/Electron code. Use supported window APIs there; never bypass the native gate.
- Pre-JavaScript startup screens retain Yuri's built-in branding. Plugins load after the usable shell; never delay startup to apply a skin.
