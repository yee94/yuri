# Assistant wallpaper

`telegram-pattern.svg` is the unmodified, separately licensed wallpaper artwork
from [Telegram Web K](https://github.com/morethanwords/tweb),
`public/assets/img/pattern.svg`, retrieved 2026-11-11.

Upstream copyright belongs to Telegram Web K's contributors. This artwork is
distributed under the upstream GNU GPL v3 license; see `LICENSE`. The editable
SVG is its source form. No Telegram application code is included. Yuri's layout
and CSS are independently implemented against Yuri's existing UI components.

Web uses the SVG as a CSS mask. NSH's `assistants-workspace.tsx` uses the same
original as a tinted native Image with gradient masks at the same 504 × 1036 tile
size, with 6% opacity on the entire native wallpaper to keep it faint even when
gradient masks differ between platforms. Both follow the active theme without
modifying the artwork or fetching it at runtime. Native fixtures use the
production asset staging path.
