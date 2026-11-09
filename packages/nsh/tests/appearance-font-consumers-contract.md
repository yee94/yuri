# NSH 外观字号消费者与装配交接

已实现设备代码字号、Skills 编辑字号和 Host 终端字号的消费者，不代表设置页面及 UIKit 的 1:1 验收完成。手机 Web 可达性以同轮 `.scratch/nsh/web-mobile-verified-402/appearance.txt`、`appearance-metadata.json`、`appearance.png` 为准；不能沿用旧文档中的隐藏结论。

## 冻结接口

- `device-appearance.ts` 的 `deviceAppearance(): { codeFontSize: number; editorFontSize: number; fileEditorKeymap: 'default' | 'vim' } | null`、`deviceAppearanceError(): string`、`loadDeviceAppearance()` 及三个窄 save 端口共用原 singleton、`device-appearance-v1` record 与串行 lane。代码字号 50–200%，默认 100；编辑字号与 Web useUIStore setter 一致，有限数值先 round 再 clamp 到 9–32pt（步长 1），默认 13；keymap 默认为 default。只有成功读取不存在的记录才提供默认值；旧 code-only/code+editor record 合法，成功解码后补缺键默认。每次保存先读取并合并其余两字段，交错保存不丢更新；非法 keymap、读取失败、损坏或写入失败保 prior，不覆盖 unread record。三字段均不进入 Host PUT，也不迁移其它客户端的浏览器存储。
- 设备范围与当前 Web 的 `useUIStore` → `createDeferredSafeJSONStorage` → `getSafeStorage` 一致：同一设备应用中跨 Host 保留。该字段并非 `runtimeScopedStorage` 的 appearance key，不按 Host、URL、lease 分桶，也不把浏览器另一客户端的 localStorage 宣称成已迁移。
- 已由唯一 `NativeAppearanceSync` 加载一次设备值，并在根合入现有 `nativeAppearance.current().codeFontSize`。消息只消费原 appearance 信号，无逐消息 Storage/GET/新 store owner。设置 UI 不再挂第二个加载 root；失败可显式调用 `loadDeviceAppearance()` 重试，显示层不得把 null 当已保存的 100。
- `NativeAppearance.terminalFontSize` 只从成功 canonical Host 快照解析：未设置为 13，合法范围 9–52pt，按 Web setter 四舍五入；非法快照抛错，由原同步保留 prior/error。`NativeAppearance.codeFontSize` 仅为设备投影，不读取 Host 同名字段。
- `NativeTerminalPage` 既有 `fontSize` prop 仍为终端 pt。root 需从同 Host 的有效 appearance 提供 `terminalFontSize`，不能再提供代码角色的字号；Host snapshot 未知时保持未知，不冒充成功默认。当前源码没有生产 `<NativeTerminalPage>` 调用点，本轮没有修改 application/main 装配。
- 现有 `terminal.preview.render` 新增 mutually exclusive 的 `{ fontPreferences: { fontSize, fontFamily } }` 分支。TS 仅在现存 surface ready/active/current 时发送；Swift 核验 current、有限数值、非 Boolean、9–52 范围、family 长度后调用原 WK document 的 `terminalFontPreferences`。Ghostty 0.4 使用现存 `terminal.options.fontSize/fontFamily`，再 fit；不重建文档、PTY、Input 或 terminal，不写输入 value/selection/IME。
- Font oracle 后续 P2 修复：字体变化不依赖容器 ResizeObserver，直接复用既有 `resize()`（fit 后发布实际 terminal.cols/rows）；同值提前返回，零额外 fit/通知。触摸 scrollPixels 在每次计算中从当前 `terminal.options.fontSize` 派生行高，不再捕获初始化 config.size。原 TS/Swift 的 active/current/owner/scope admission 保留，未新增 terminal route。

## 真实消费者

| 场景 | 端口与本轮实现 | 仍需验收 |
| --- | --- | --- |
| Chat user/assistant/Thought Markdown | `nativeTranscriptMarkdownStyles` 同时提供 `styles.code`（行内）与 NSH 0.4 真实 `styles.codeBlockCode`（fenced code）；后者行高随代码字号缩放 | UIKit 的长行横滚、copy、连选、200% 代码和历史阅读位置 |
| RawToolText、tool task Markdown | 复用同一 markdown styles，覆盖 literal codeBlock 与 task 内 fenced code | UIKit 工具展开/切换 |
| Shell command/output literal Text | 现有 code role，20pt 行高按 code scale 缩放 | UIKit 选区/长输出 |
| Changes 历史与 workspace Diff | 原 `DiffView.fontSize/fontFamily` 消费 code role；20pt 行高改为同倍率，layout/remount key 不变 | UIKit unified/split、目标行、阅读位置 |
| Resource 普通 source / rich Markdown | `resources.tsx` 唯一 TextView 的 `styles={nativeCodeTextViewStyles()}`，source codeBlock 与 rich Markdown 的行内/fenced code 共用根字号；正文、图片与链接 handler 保留 | UIKit 200% 横滚、选区；既有 exact targetLine 源码 List 未改 |
| 插件 runtime failure codeBlock | `settings-plugin-runtime.tsx` 的 `nativeCodeTextViewStyles()`，保留 error 展开/收起、复制及原 text-sm/body class | UIKit error 选区/展开 |
| 历史导入 receipt JSON | `history-import.tsx` 的 `nativeCodeTextViewStyles()`；保留完整 JSON、text-xs/body class 与其余结果 metadata | UIKit JSON 选区/长行 |
| application Task prompt | 原 Task TextView 仅新增同一 code styles，不覆盖正文 | UIKit prompt Markdown |
| application compaction summary/error | 原 card TextView 仅新增同一 code styles，summary/error source 优先级不变 | UIKit compaction 内容 |
| application 通用 Markdown route/README | 原 route TextView 仅新增同一 code styles，不改 route/content、NavPage 或正文 | UIKit README 代码/选区/阅读位置 |
| Tour 插件 README | `setup-tour.tsx` 唯一 TextView 消费同一 code styles；保留原正文、links="report" 与 readmeLink handler | UIKit README code 选区/阅读位置 |
| 只读 skill supporting file | `settings-skill-files.tsx` 唯一只读 Markdown TextView 消费同一 helper；可编辑 SettingsInput 不改角色 | UIKit skill code 选区 |
| 只读 collection 字段 | `settings-collections.tsx` 的 readOnly field Markdown 消费同一 helper；字段 title/readonly 与正文不变 | UIKit 字段内容/代码 |
| Skills instructions / supporting file 编辑 | `native-editor-style.ts` 读取原 deviceAppearance 与 canonical mono family，经原 SettingsInput 的 inputStyle 更新原 multiline Input；直接使用 editor pt 和 1.5 倍行高，独立于 code 百分比、UI 字号及 density leading | UIKit 选区、IME、焦点、动态字形与阅读位置；实际移动 FilesSurface 只读，桌面 FilesEditor/Vim 不属于 mobile 缺口 |
| 计划执行 prompt | `schedules.tsx` 唯一执行 prompt TextView 消费同一 helper；原 text-sm class、模型/Agent/variant metadata 不变 | UIKit 执行详情 |
| 归档正文与 Thought | `settings-archive.tsx` 两处 Markdown TextView 消费同一 helper；正文 foreground 与 Thought muted-foreground 分别保留 | UIKit 归档代码、选区/阅读位置 |
| GUI CSS projection | `nativeFullThemeCSS` 使用同一根投影的设备 code scale | GUI mount/style 更新仍由原 GUI owner 验收 |
| Terminal WK | 初始化 prop + ready 后原地 fontPreferences；同值 JS 不 fit | 生产 root 未装配；UIKit/真实 Ghostty canvas 与 resize/selection 未验 |

共享 `nativeCodeTextViewStyles(): TextViewStyles` 定义在 `appearance.tsx`，只返回 `code` / `codeBlockCode` 两个 parts；不选择 assistant/user 正文 role，不设置 root、paragraph、metadata 或 body color。`nativeTranscriptMarkdownStyles` 组合它并继续拥有自己原本的正文、列表和 compact leading。每个消费者只读取现有根 appearance，不创建 Storage/GET/effect/store owner。

后续全量扫描已完成当前 `packages/nsh` 的生产 TSX TextView 盘点：18 处代码消费者全部消费同一根 code size，另 1 处明确的 ASR literal TextView 保留纯文本；当前没有留下待其它 owner 接入的生产 TextView code 分支。该结论是代码消费覆盖，不是 UIKit 1:1 验收完成。fixture/test app、生成 `.nsh` 产物及普通 Input 不计生产代码呈现；原生 Diff、Shell literal Text 和资源精确源码行是独立非 TextView 消费者，见上表。

动态 JSX 扫描回归包含 TextView 的 import alias/namespace 识别，未来新增/更名调用点必须显式进入矩阵，不能静默漏过。当前精确清单如下：

| 生产文件 | TextView 数量 | 代码消费者/排除理由 |
| --- | ---: | --- |
| `transcript-body.tsx` | 4 | 非折叠 Thought、可折叠 Thought、UserText、普通正文；均组合 nativeTranscriptMarkdownStyles → nativeCodeTextViewStyles |
| `transcript-tools.tsx` | 2 | RawToolText codeBlock、task Markdown；均组合 nativeTranscriptMarkdownStyles |
| `application.tsx` | 3 | Task prompt、compaction summary/error、通用 Markdown route |
| `resources.tsx` | 1 | 同一 TextView 的 source/rich 两分支 |
| `settings-plugin-runtime.tsx` | 1 | error literal codeBlock |
| `history-import.tsx` | 1 | receipt JSON literal codeBlock |
| `setup-tour.tsx` | 1 | 插件 README Markdown |
| `settings-skill-files.tsx` | 1 | 只读 supporting file Markdown |
| `settings-collections.tsx` | 1 | readOnly field Markdown |
| `schedules.tsx` | 1 | 执行 prompt Markdown |
| `settings-archive.tsx` | 2 | message.text、message.reasoning Markdown |
| `settings-voice-test.tsx` | 1 | **纯文本排除**：voiceTestTranscriptDocument 仅生成 paragraph → text；backticks/fences/链接指令不解析，不强行赋 code role |

## 外观字段与移动端合同矩阵

| 字段 | Web 合同/权威 | 本轮 NSH 状态与下一步 |
| --- | --- | --- |
| fontSize | Host 50–200%，初 100；mobile semantic base × UI scale，code 使用独立 scale | 原 `nativeTypographyStyle` 已消费；composer 保持 mobile iOS 16pt floor。Settings 主 owner 接既有 Host 保存/refresh；普通设置文字、全 App 固定字号覆盖范围仍需逐页对帧，不能从 chat helper 推断全部完成 |
| codeFontSize | 设备本地 50–200%，初 100；移动 code base 13pt | 根投影与当前全部 18 处生产 TextView 代码呈现、Diff/Shell/资源精确源码行已消费；Prefs UI 由主分派 owner 接同一 singleton。本轮未改 Prefs/Receipt，UIKit 未验 |
| terminalFontSize | Host 9–52pt，初 13；setter round | canonical 解析与 WK 原地配置完成；主 owner 保存 Host 字段并给实际 terminal route 传 pt。当前生产 terminal route 尚无调用点，不能宣称终端端到端已接通 |
| editorFontSize | 设备本地 9–32pt，初 13，步长 1、round/clamp；Web 桌面 FilesView/SkillsPage 的 CodeMirror theme/reconfigure 消费 | metadata 仅声明 skills-editor：Prefs 本机编辑/Reset/失败重试及两个 Skills Input 已接；移动 FilesSurface 只读，无编辑器/Vim 的额外需求。独立 helper 不新增 root/store/Storage/GET，原 Input 原地更新 fontSize/lineHeight/canonical mono，不改 value/selection/IME 或只读 TextView |
| fileEditorKeymap | 移动共享设置可本机保存 Default/Vim，效果消费者仅桌面 FilesView | Native metadata 为 device-preference，双 Radio 与本机保存/Reset/重开恢复已接；MobileFilesSurface 仍只读 preview，不宣称 Native Vim，不增加编辑或文件写入 |
| padding | Host 50–200%，初 100；`applyPadding`: spacing = sqrt(percent/100)，lineHeight multiplier = 1 + (scale−1)×0.15 | 未实现；需从原 appearance 解析，统一原生 spacing token 与相关 leading，而非只改一个容器 padding。不能简单把百分比线性乘到全部几何，更不能新增 offset writer |
| inputBarOffset | Host 0–100，初 0；Web ChatInput 仅 `isMobile && isCapacitorApp && !nativeIosComposerActive && offset>0 && !mobileTextareaFocused` 写 marginBottom | 未实现；真实 Web 设置可达不等于当前 Web/native composer 一定有位移。主 owner 明确 NSH 原生 composer 的适用合同后在唯一 composer layout owner 消费，保持 UIKit 键盘/safe-area 和唯一列表滚动 owner；禁止另加 offset 补偿 |

## 本轮验证边界

- Skills editor 字号增量：`device-appearance-core`、`settings-preferences-production`、`settings-preferences-core`、`native-editor-style`、`appearance-code-consumers`、`settings-navigation-production`、`settings-request-scope`、`settings-voice-operation-recovery` 共 8 文件 **175 passed / 4 engine skipped**，显式 `NSH_SETTINGS_NAVIGATION_PRODUCTION_ENGINE=0`；原生 tsc 通过。存储/页面回调先有 16 个失败，两个真实编辑 Input 的生产 JSX style 端口又先有 2 个失败，再实现转绿。覆盖 legacy record、成功读取后默认、round/clamp、两字段串行互保、损坏/读写失败、partial Save、逐字段 ABA/CAS、隐藏/销毁旧回调、未知 Host receipt 隔离、持久恢复及 Reset。原 SettingsInput 的 inputStyle 透传由 density owner 提供，本改动直接复用，不修改它的尺寸/布局；只读 code 盘点 mock 补 computed，其余回归只补新样式模块依赖声明。没有运行 engine、设备、真实 Host 或真实 Storage；UIKit 字形/焦点/选区/IME 仍待验收。此前把桌面 FilesEditor/Vim 列作 mobile 缺口的结论已由真实 MobileFilesSurface 只读合同纠正。
- `device-appearance-core`、`appearance-core`、`transcript-body-markdown`、`terminal-renderer-behavior`、`terminal-static`：5 文件 46 项通过。
- 后续六处 TextView 消费者批次：`appearance-code-consumers`、`transcript-body-markdown`、`device-appearance-core`、`appearance-core` 四文件 31 项通过。新测试将生产源码中的六处原始 JSX 转译为 props，覆盖 resource source/rich 分支在 50/100/200% 的 code/font/leading，保留正文 class/source/selectable/links/handler；另验证 Chat 组合后正文 role、颜色、leading、列表/compact metadata 不变，零新增请求/设备读取/effect。只执行 props 构造和纯样式函数，不挂载 application/业务组件或引擎。
- 最终全量 TextView + font oracle P2 批次：`appearance-code-consumers` 动态发现全部生产 TextView，对 18 处 code consumer 在 user/assistant 两种输入 role、50/100/200% 与资源 source/rich 分支构造实际 JSX props；除 code/codeBlockCode 外的完整 props（含正文 style/class、source、selectable、links、options、copy action 与回调函数体）和其余 styles 均保持不变。实际 Tour onLinkPress 回调仍调用原 readmeLink；ASR backticks/fences 仍为 literal paragraph。此项测试不运行实际组件生命周期或 UIKit。
- 最终六文件纯字号/终端批次（`appearance-code-consumers`、`transcript-body-markdown`、`settings-voice-test`、`terminal-renderer-behavior`、`terminal-font-lifecycle`、`terminal-static`）：**39 项通过**。bootstrap 新测试先实测 RED（字号变化后无 resize、touch 仍 10 行），修复后 GREEN：13→26 在不触发 ResizeObserver 的条件下发送真实 fake-fit 后 40×12，180px 触摸映射从 10 行变为 5 行；相同值零额外 fit/通知，保留输入/IME、回执与输出。route 纯回调回归覆盖正确 resize 转发、旧 owner、后台、旧 lease、invalidated scope 阻止采用，surface 只初始化一次。
- 相关既有六文件纯生产回调回归（`setup-tour-production`、`history-import-production`、`resources-request`、`settings-navigation-production`、`settings-request-scope`、`settings-voice-operation-recovery`）：**119 项通过、4 项 engine 显式跳过**（NSH_SETTINGS_NAVIGATION_PRODUCTION_ENGINE=0）。只补各 fixture 的 appearance helper 窄声明，未改变原作用域/业务断言；未接真实 Host 或 Storage。
- NSH `tsc --noEmit -p packages/nsh/tsconfig.json` 通过。
- `terminal-native.test.ts -t 'iOS SDK typechecks'`：Apple iOS SDK + declaration-only NativeShell stub typecheck 通过，1 项通过、1 项未选中；没有运行引擎或设备。
- 最终 NSH tsc 与 Apple iOS SDK declaration-only typecheck 再次通过。`bun run dead-code` 执行完成（non-blocking），仍有 NSH entry 覆盖不足等既存提示；共享 nativeCodeTextViewStyles 无未消费报告，不据此删除主 owner 模块。
- Context7 实际返回 monthly quota reached。本轮 API 证据为 `.nsh/types/nsh/base.d.ts` 的 codeBlockCode 声明与本机 Ghostty 0.4 `dist/index.d.ts` 的 runtime options 合同；没有宣称在线文档查询成功。
- 无 engine、设备、真实 Host、真实 NSH Storage 或 Git 操作；纯偏好测试只注入内存 get/set。VM 测试执行生产 terminal bootstrap，DOM/terminal 为假对象，不能替代真实 WK/Ghostty 或 UIKit 动态改字号验收。
