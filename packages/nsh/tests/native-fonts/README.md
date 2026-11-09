# 固定 Web 字体动态注册 UIKit fixture

生产范围为 Web `fontOptions.ts` 的全部 8 UI + 8 mono Fontsource 字体、47 个 Latin normal face；默认 system/system-mono 不下载。版本与 SHA 位于 `ios/NativeFontCatalog.swift`。Web URL 原本浮动到 npm latest，Native 固定本轮同一响应的 `x-jsd-version` 与字节；未来 CDN latest 变化不代表该固定快照自动升级。升级须核对整个 face 集合及字节，不按 family 名推测版本。

`NativeFontRegistry` 只读白名单内带版本的 jsDelivr URL，20s request / 45s resource timeout、每 face 精确长度且至多 1 MiB、全 registry 两 reader、同 source key single-flight。没有 Host catalog/file API、凭据、Relay 或系统字体安装。只有显式 UI/mono 选择触发读取；任意 theme family 不构造 URL。注册输入文件为进程临时文件；没有 durable disk cache。进程注册缓存最多 47 face，key 含 ID/version/weight/subset/style/SHA。

实际字体 family 由 SHA 校验后的 CoreText descriptor 解析。例如 Web CSS 的 Geist Sans 对应内部 Geist，Fira Code 对应 Fira Code Light。投影使用该真实 family 加系统 fallback，NSH 正式 `font-sans/font-mono` token 覆盖缺省 Text/Input、font-mono、TextView code、Diff/Editor；显式 Chat/Skills 样式继续消费同一 projection。未核验的 renderer family 明确 unsupported，不通过 `UIFont.familyNames` 冒充已加载。注册冲突失败，不能因相同 PSName/family 接受别的字节。

仓库 bundled JetBrains Mono 是 2.304，当前 Web Fontsource 5.3.0 内部字体是 2.211。用户显式选择该 mono 时读取原 Web WOFF2；只有已核验 SHA、URL 和 PSName 的应用内置三个 normal face 可在 process scope 退役后替换。其他 process/system 的同名注册均拒绝。默认 renderer 可用原 bundled face；这不是显式选择 Web mono 2.211 的验收。Native family stack 保留真实系统 fallback；已下载字体与 bundled renderer 的完整 family-list identity 不同。

字体 owner 不持有 palette。共享 single-flight 只读取/校验字节，不持有注册权；退休任务可填充最多 47 face 的 verified byte cache，但每次 process 注册（尤其 bundled 同名替换）必须重新核验该 consumer 的 live selection/revision。已有 face 按自身 URL、SHA、PSName 逐个复用；一次 face 失效不使其它自有 face 变成冲突，rollback 只撤销本次新增/替换。`AppearanceBridge` 的完成回调只在仍有效的 selection ticket / reset revision / selected Host 上，将字体 token 合入**当前**外观 contract；不会捕获旧 palette。JS 再核验 current sourceHost/generation/revision/ticket。重试只调用 `appearance.fonts.retry`，早于 retry 响应的完成事件会在新 ticket 安装后采用。加载失败保留对应角色 prior，status=failed；未知 family status=unsupported。反馈使用十语言固定文案，不展示原始名字或错误/URL。

## 构建（不占用设备）

```sh
NSH_BIN=/existing/nsh/bin/nsh node packages/nsh/scripts/build-native-fonts-uikit.mjs --sdk-only
NSH_BIN=/existing/nsh/bin/nsh NSH_FONT_FIXTURE_DIRECTORY=/existing/verified-web-woff2 \
  node packages/nsh/scripts/build-native-fonts-uikit.mjs
```

fixture directory 提供生产 catalog 全部 47 个 `*-latin-*-normal.woff2`；builder 按生产 catalog SHA 与长度检查。字体只复制到本次 `.nsh/native-fonts/<buildID>/NativeFontsFixture.app/fixture-fonts`，不写仓库资产、不下载、不更改原 NSH distribution。生产应用不打包这些新增字体，仍只在显式选择时读取。包使用唯一 bundleID、真实 SDK、生产 NativeAppearanceSync/AppearanceBridge/NativeFontOwner/NativeFontRegistry。只有 CDN byte reader 注入离线响应；设置 GET 为严格 captured receipt 的 synthetic Host。

## main 独占设备验收

1. 使用构建结果 JSON 中的 app、bundleID 安装并启动；worker 不执行这些命令。
2. 首组及每个首次选择的字体，均要求其所有 face 的 `UIFont(name: PSName)` 不可用，Info.plist 没有 `UIAppFonts`；若预先存在直接失败，不能把旧系统字体当动态成功。
3. 等待首组状态 `ready · verified`；byte reader 只读当组选中 face，仍经过生产 SHA/descriptor/注册。真实 UILabel probe 的 UIFont、原 NSH Input 的继承 UI font、font-mono multiline、实际 Skills editor 样式的 UIFont 都读回 familyName/fontName。
4. 点击 `Next font pair`，每组等 `verified` 再继续，共八组（初始 Inter/Fira Code，最后 Manrope/Iosevka）。八组覆盖全部 16 字体；每组写 Documents/font-audit-0.json 至 font-audit-7.json，font-audit.json 为最新。`valid=true` 要求 prior unavailable、累计读取数匹配选中源、label 与三个真实 editor 的 fontName 均等于 registry 对应 regular PSName。八组累计读取 47 face；再次循环应使用原进程 cache，不新增读取。保留 build manifest、八份 audit 与同状态截图。
5. NSH Text 在当前 SDK 用 CoreText 自绘，不是 UILabel。fixture 原样显示继承 Text 与 font-mono Text；audit 明确 `textCTRunReadback=false`，UILabel 是独立 UIKit probe，不能冒充读取了 NSH Text 内部 CTRun。真实文字字形对帧、粗体/各 face 的 UI 选择、动态切换/IME/选区仍须按完整范围补测。

## 无设备回归

```sh
NSH_FONT_FIXTURE_DIRECTORY=/existing/verified-web-woff2 \
  ./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/native-fonts.test.ts packages/nsh/native-font-projection.test.ts packages/nsh/appearance.test.ts
```

提供全部 47 Web 原始 WOFF2 时，macOS CoreText 回归逐 face 注册并读回真实 family/PSName，验证去重、拒绝预先同名注册、cache 后同名注册替换的身份失效、后续 face collision 回滚及 bundled 2.304→Web 2.211 的受控替换。不提供字节目录时仅这五项外部字节回归显式 skip，其余 owner deferred/failure/retry/Host/revision/noop/malformed 与 JS projection 回归正常执行。macOS 结果和 iOS SDK compile 均不代替 UIKit 实测；fixture 注入字节也不证明设备真实 CDN 连通。
