---
name: yuri-customization
description: Yuri project registration and removal, task and session lifecycle (archive / settled), session import, remote hosts and sessions, resource identity and deep links, connection and configuration management, and GUI customization.
---

# Yuri customization

Load only the matching reference. Bound helpers expose the operations available
to the current caller through `describe`; the references do not grant access.

- [Projects](references/projects.md): project registration and removal, task and session lifecycle (task-view 「归档」 / "settled", local and Remote Project sessions), remote hosts and sessions.
- [Session import](references/history-import.md): importing normalized historical conversations into the bound Host.
- [Resource identity and scope](references/projects.md#resource-identity-and-scope) and [deep links](references/deep-links.md).
- [Remote connections](references/remote-connections.md): SSH, configuration sync and Relay pairing.
- GUI customization: plugin capabilities and workflow below.

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

## Boundaries

- `Style` can affect the whole document. A GUI plugin is trusted JavaScript, not a sandbox. Prefer tokens and narrow, stable selectors; arbitrary CSS can hide controls or trigger network requests.
- Yuri themes and branding are host-consumed custom registries, declared with official `Registry.define`; they are not official OpenCode built-ins. Other hosts may ignore them.
- Enabled plugins apply their appearance contributions automatically; [appearance](references/appearance.md) defines priority and fallback. Saved base theme preferences remain separate.
- macOS customization means the running Dock icon only. Keep signed `.app` resources, Finder/Launchpad icons, bundle identifiers and update origins unchanged.
- Native `main` runs only for trusted local Electron connections. Remote/Relay, Web, VS Code and mobile cannot execute local Node/Electron code. Use supported window APIs there; never bypass the native gate.
- Pre-JavaScript startup screens retain Yuri's built-in branding. Plugins load after the usable shell; never delay startup to apply a skin.

## Open-source reference

When the matching reference does not cover an operation and Yuri may expose an
API for it, research the repository before concluding it is unavailable. Use
the tag matching the installed Yuri version when known (`main` for development
builds). Verify the interface, supported runtime and required authorization in
the owning docs, implementation or tests. Use the verified API to help the user
when it is accessible to the current caller and the requested action is
authorized. Source visibility does not grant access to internal routes or replace
a required bound helper. If no supported interface can be verified, report that
limit. GUI source can clarify extension behavior; customization still belongs in
the plugin.

https://github.com/yee94/yuri
