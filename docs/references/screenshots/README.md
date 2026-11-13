# Product screenshots

The root READMEs, website and handbook reuse the approved, sanitized WebP assets
under `site/assets/shots/`. English interface captures use the `en-` prefix;
Chinese captures use the corresponding unprefixed filename. The two desktop
cover screenshots are shared by both languages.

- `workspace-diff.webp`: desktop conversation with code diff review and file tree.
- `workspace-preview.webp`: desktop conversation with an interactive page preview.
- `schedule.webp` / `en-schedule.webp`: desktop Schedule.
- `remote-projects.webp` / `en-remote-projects.webp`: desktop Remote Projects workspace.
- `remote-projects-sidebar.webp` / `en-remote-projects-sidebar.webp`: sidebar close-up showing local and remote host repos.
- `m-home.webp` / `en-m-home.webp`: mobile Projects.
- `m-swipe.webp` / `en-m-swipe.webp`: mobile Project row with the pin/archive
  rail revealed.
- `m-assistants.webp` / `en-m-assistants.webp`: assistant contacts.
- `m-schedule.webp` / `en-m-schedule.webp`: scheduled tasks.
- `m-asr-send.webp` / `en-m-asr-send.webp`: mobile session composer with active voice dictation.

## Current capture set

The desktop covers (2026-11) are user-supplied 3348×1936 captures, converted to
lossless sRGB WebP without resizing or cropping and with embedded metadata removed.
They show a customized workspace, including plugin branding, and are not separate
localized captures. They replace the former `home.webp` / `en-home.webp` pair.

The remaining set contains four theme previews
(`theme-cursor-dark`, `theme-tokyonight-dark`, `theme-vitesse-dark-dark`,
`theme-nord-dark`, plus the English equivalents), 2× Remote Projects captures
(`2880×1800` full window and `520×760` sidebar focus), desktop captures at
`1440×900`, and 3× Retina phone captures at `1170×2532` (`390×844` @ 3×) stored
as sRGB WebP.

Those captures come from the running web UI. Before each shot, visible copy is
rewritten to neutral examples: project and worktree names, session titles,
assistant names and messages, and scheduled task names. Where an internal label
could not be rewritten in place, the row is rebuilt from the application's own
card markup so the layout, icons and controls stay real while the text stays
neutral. Account identity chrome (the header avatar) is hidden.

Update this list and the captions together when the entry points shown change.
Use repository-relative image paths in the root READMEs and `/assets/shots/`
paths in handbook articles.

中文：根目录 README、官网与手册共用 `site/assets/shots/` 中已脱敏的素材，
按语言选图即可。更新图片时同步检查实际入口和配文，不需要另存一套副本。
