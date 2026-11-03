# Message channel brand marks

Bundled SVG marks used only by the per-Bot message channel entries. Every file
comes from the platform owner's own site and keeps that platform's official
geometry and colors. Do not redraw, trace, recolor, or approximate these marks.
Surrounding UI uses semantic theme tokens.

| File | Official source | Usage rights |
| --- | --- | --- |
| `wechat.svg` | [WeChat Newsroom footer logo](https://sgnewres.wechat.com/t/ofs-wechat/newsroom-web/res/_next/static/media/wechat-with-color.7a890de8.svg), linked from <https://newsroom.wechat.com/> | WeChat / Tencent brand asset. All rights reserved. Not CC0 or open source. |
| `wecom.svg` | [WeCom official site image sprite](https://wwcdn.weixin.qq.com/node/wwnl/wwnl/style/images/officialImages$h6afc438.svg), the 31×26 icon at `x=96 y=240` used by `.ww_officialImg_LogoSingle` on <https://work.weixin.qq.com/> | WeCom / Tencent brand asset. All rights reserved. Not CC0 or open source. |
| `feishu.svg` | [Feishu Open Platform logo/favicon](https://lf-package-cn.feishucdn.com/obj/feishu-static/lark/open/website/favicon-logo.svg), declared as the site icon on <https://open.feishu.cn/> | Feishu / ByteDance brand asset. All rights reserved. Not CC0 or open source. |
| `dingtalk.svg` | [DingTalk Open Platform favicon](https://img.alicdn.com/imgextra/i3/O1CN01WMvMRG1ks3Ixc9x1v_!!6000000004738-55-tps-32-32.svg), declared as the site icon on <https://open.dingtalk.com/> | DingTalk / Alibaba Group brand asset. All rights reserved. Not CC0 or open source. |

## Source handling

- The official assets are normalized to a `viewBox` root with `role="img"` and an
  `aria-label`; intrinsic `width`/`height` are omitted so the consuming `img` can
  size the mark without distortion.
- `wecom.svg` is the official icon-only drawing extracted from the site sprite.
  Its paths and fills are unchanged.
- `dingtalk.svg` removes the source file's redundant internal clip mask and
  deprecated `xlink` reference. The official path, transform, and fill are
  unchanged.
- `feishu.svg` keeps the official white rounded tile from the app icon.
- No file contains scripts, raster images, external references, or hard-coded
  theme colors. Brand colors are the official platform colors only.

These marks identify the corresponding messaging platforms. Their inclusion does
not grant a license and must not be presented as Yuri-owned artwork or as an
endorsement by the platform owners. Earlier versions of these files used
third-party icon sets (Simple Icons, TDesign Icons, IconPark, Ant Design Icons);
those are not official brand assets and must not be restored.

Replace a file only with a newer SVG downloaded from the owning platform's
official domain, preserving the source URL above in the same change.
