# Canonical padding consumers

本批消费者从唯一 `nativeAppearance.current` 读取已确认的 Host `padding`。
`appearanceFromSettings` 对缺省取 100，校验有限 number 与 50–200 范围，并按 Host sanitizer 取整；不强制 UI 的步长 5。
失败保留此前有效 appearance，切 Host 清除旧投影，迟到响应受原 appearance sync generation fence 拒绝。
没有新增 GET、Storage、timer、Swift appearance schema 或输入事件工作。

Web 来源：`useUIStore.applyPadding` 的 `sqrt(padding/100)`、`design-system.css` 的 spacing scale、`mobile.css` 的 project-shell 与 36px 触区规则、`scripts/postcss-dpt-font-size.mjs` 的 rem/px 分离。
Projects 的 `pageInset=18` 与 `groupGap=10` 是固定量：`--yuri-mobile-page-inline-inset: 1.125rem` 经 `px-[var(...)]` 消费，project-shell 的 `--yuri-mobile-project-group-gap: 0.625rem` 经 `gap: var(...)` 消费。PostCSS 不重写这两个 custom property，也不展开 `var(...)`；它们没有显式 `--padding-scale`。`pageGap` 来自 `gap-5` 的 `--spacing-5`，仍按 `20 * sqrt(padding/100)` 缩放。
触屏基线为 `.scratch/nsh/web-mobile-touch-5188/appearance.txt`，不能使用旧 desktop gate 402 结果。

| 实际消费者 | 随 density 的量 | 保留独立 owner / 固定量 |
| --- | --- | --- |
| `projects.tsx` 首页根、项目与置顶卡 | pageGap/底部留白、header 高度/inset/gap、icon/glyph、groups inset/top/bottom、菜单右 margin | pageInset 18pt、groupGap 10pt、24pt 外圆角、16pt 内圆角、字体、实际 Tab bottomInset、拖排测量与手势 |
| 首页工作树 | header 最小高度、trigger 横/纵 padding 与 gap | 字体、分隔线、原回调/展开/删除语义、实际拖排几何 |
| 首页 session row | row 最小高度、主按钮左右/纵 padding、gap | 字体、session ID、collection order、选中/阻塞/活动来源 |
| `SettingsGroup/Input/Choice/Toggle` | section gap、label inset、card padding/gap、field padding/高度、Select popup/item 留白、toggle 行 gap/高度 | control 内部字体/选区/IME、Switch track/thumb、圆角；`SettingsInput.inputStyle` 由字体消费者合并；Sheet search 保留 50pt 独立 owner |
| 三类 preference 展示 | label/section、option card、transport/chip、radio 行、preview 外框留白 | 值、radio selection、callback、420ms 唯一 preview clock 与 visibility fence、preview phase 的固定 px 图形 |
| Chat 唯一 inverted List | content 横 padding、row gap | 26pt 既有顶部 inset、实测 composerHeight + 16、primitive row keys、footer 自然测量、loadMore handlers、唯一滚动 writer |
| Chat expanded composer | 外横 padding/top、glass 内横/top/bottom、status padding/gap、actions 行 gap/最小高度、Input rem maxHeight | Input 52px minHeight/10px padding、16pt 字体/24pt lineHeight、同一 Input/ref、键盘/safe-area env、onLayout 唯一高度广播 |
| Chat compact chrome | 横 padding/gap | 44pt 高度、bottom/transform/opacity、同一展开 editor |
| new-session | welcome 横/纵 padding/gap、composer 外/内留白、actions 行 gap/最小高度、Input rem maxHeight | Input/PTY/selection/Agent/model owner、26px chip、env keyboard/safe-area、首次发送与恢复协议 |
| send/stop 三入口 | Web `h-8 w-8` 外框、`h-6 w-6` 圆盘、ghost glyph；实际 hitSlop 至少保证 44pt 有效触区 | 箭头 56%、loading 50%、stop 方块 38%/圆角 20% 比例；send/stop/队列回调与 admission 协议 |

36pt 是本批密集按钮/row 的触区底线；既有 settings field/toggle 保留 44pt 底线。
这些边界不把字体、圆角、固定 px 或实测环境尺寸乘 density，不遍历任意 style number。
`native-density.ts` 是显式纯 tokens，`appearance.tsx` 的 computed 是唯一 canonical snapshot 的派生；Projects 复用原 geometry owner。

工作树分支/目录 Input 区分视觉高度和有效触区：Web `NewWorktreeDialog.tsx` 的分支字段使用 `h-8`，手机 `mobile.css` 的 input/textarea/select 规则施加固定 36px 最小高度；Native `worktreeFormLayout().input` 保留 36pt 视觉下限，通过同一 helper 的 `inputHitSlop` 直接向真实 Input 声明上下各4pt、左右0的扩张，目标有效高度为44pt，不增加布局高度或改动字段回调。NSH 0.4 本地声明 `base.d.ts` 的 `InputProps` 继承 `types.d.ts` 的 `CommonProps` / `HostProps.hitSlop`，该属性不是 InputStyle。50/100/105/200% 下，4pt 单侧扩张小于字段内部 `6*scale` 间距，两侧共8pt小于字段组 `24*scale` 间距，声明的扩张范围不重叠同列相邻控件。`native-density-surfaces.test.ts` 执行生产 formLayout/inputStyle initializer，核验两个实际 Input 的视觉、hitSlop、目标触区算术和原编辑/blur回调；`projects-presentation.test.ts` 保留36pt几何断言，要求 hitSlop 在 Input 本身，label/error/reset 所在 group 没有触摸转发或程序 focus。这些 props/几何证据不证明 UIKit 有效触区已经达到44pt。

真实 UIKit 状态仍为未通过：`.scratch/nsh/uikit-e9cd131b-worktree-edge/{before,action,after,positive-control}.json` 保留旧 SDK 下视觉顶部外2pt点击不产生输入、同 frame 中心点击可正常输入并联动目录的正反证据。原 SDK iOS Input 使用普通 UIView 容器，未消费公开 hitSlop；曾出现的 group `hitSlop + onPress → Input.focus()` 转发覆盖标签、错误及重置按钮所属区域，不等于原 Input 的36+4+4命中合同，也不构成 SDK 修复通过证据，现已移除。独立 SDK 输入修复的静态检查不替代 runtime；必须由 main 将修复 framework 装入新包后复验边缘命中、相邻控件、父容器裁切、Scroll 手势及原键盘/选区行为。恢复直接 Input consumer 在旧 SDK 上仍应如实记为 runtime red，不通过 wrapper focus 绕过。

## 验证边界

`native-density.test.ts` 覆盖 50/100/105/200 的真实几何投影、触区、字体隔离、默认/非法值、失败保 prior、迟到 Host 拒绝；`settings-preferences-fields.test.ts` 对实际展示组件做纯渲染，验证各密度下 option IDs、selected 状态和原始 callback 值。
`native-density-render.test.ts` 对真实 SettingsInput、composer chrome 与 send/stop 做纯渲染，覆盖字体样式接口、edit callback、唯一 onLayout 高度广播、send/stop 状态与有效触区。
聚焦六文件共 73 项通过（上述三文件，加 `appearance-core.test.ts`、`projects-presentation.test.ts`、`history-rows.test.ts`）；`tsc --noEmit -p packages/nsh/tsconfig.json` 与 skill 内设置审计脚本通过。`bun run dead-code` 完成，报告中没有新增 density helper；现存 fixture/导出与 workspace 配置告警保留。
P2 修正后，`native-density.test.ts` 与 `projects-presentation.test.ts` 聚焦 2 文件、12 项通过，NSH tsc 再次通过。四档 50/100/105/200 均验证 pageInset 18pt、groupGap 10pt 固定且 pageGap 继续缩放；来源映射测试读取真实 Web custom property、消费位置、Tailwind token，并执行真实 PostCSS Declaration visitor，验证变量定义及引用都未被改写。
UIKit、UI engine、真实 Host 与性能逐帧测量由主会话统一运行，本批没有执行。
没有证据证明 50% 的长语言行、200% 的窄屏/工作树/模型 chip、密度热更新时倒序 List 阅读锚点及软键盘交接已通过 UIKit 验收。

## 第二批实际消费者与 Web 映射

第二批已接入前述 ProjectDetail、业务 Sheet、NativeSelect、Settings 外层与 Bot/Task 共用表单。`settingsPreferenceFields.padding.consumer` 现在是 `appearance`，表示存在实际 canonical appearance 消费链，不再显示全局 unconnected。这个分类不代表 UIKit、IME、触控或全部画面已通过验收。

本地 SDK 依据为 `.nsh/types/nsh/index.d.ts` 的 `token()`/theme 声明与 `ios/AppearanceBridge.swift` 的 override 白名单；本批没有找到运行期重新编译 Tailwind spacing 的公开接口证据。因此使用现有 `nativeDensity` 的显式命名 tokens，不修改 Swift schema，不假设 setThemeOverrides 会改写已编译 spacing。

| 消费者 | 已接入的命名几何 | Web 来源与固定边界 |
| --- | --- | --- |
| Settings 首页 `settings.tsx` | `pages.settingsHome` | page inset 固定 18；Native 当前顶部基准固定 16pt，不随 density 缩放。`SettingsView` 根顶部来自 `calc(safe-area + 1rem)`，不是裸 rem；`mobile.css` collapsing-header 规则还将根 padding-top 覆盖为 0，header 自有固定 calc/custom geometry。本批不重构 header/safe-area。底部 `calc(dock + 2.5rem + safe-area)` 不额外乘 scale，实测 bottomInset 独立保留 |
| notifications、usage、quota、preferences、magic、git、about、archive、collections、basics | `pages.settings` | `mobile.css` detail-card 的 `padding: .75rem 0 calc(dock + 1.5rem)`：顶部 12×scale，底部 calc 的 24 固定；外层 custom page inset 18 固定；Settings section-stack custom gap 20 固定 |
| Projects/Providers 设置页 | `pages.settingsEntity` | 两个 Web 页面自身的 `p-3` 保留：外层 18 + 内层 12×scale；顶部/底部 12×scale；不把没有 page-content 覆盖的实体页误套为零内横 inset |
| Settings collection rename/directory/KV、skill editor、provider model editor、MCP import | `pages.sheetSimple/sheetPicker/sheetEditor` | 对应现有 `p-5 gap-3/4 pb-10` spacing utilities；只加 contentStyle，原 Save/receipt、ref/onScroll、target 与 reader 原样保留 |
| Voice ASR 测试页 | `pages.voiceTest` | 原 `p-5 gap-5`；formSheet、原生导航、采集 owner 与固定 mic 图形独立 |
| ProjectDetail、工作树模式/字段/分组、session rows 与业务重试/取消 | `pages.projectDetail`、`forms.card/stack/inline/quiet/session/worktree`、`settings.field` | `p-4 gap-4`、`p-3 gap-2`、`px-3 py-2/3` 等明确 rem utilities；不缩小 44/36 触区下限；保留根 Scroll 租约、实测 drag geometry、session IDs 和 controller |
| 各业务 NativeSheet | `nativeSheetSpacing` 的有限表 | 只识别既有 `p-2/3/4/5`、`px-3/5`、`py-2/3`、`pb-4`、`gap-1/2/3/4`。表值对应 `design-system.css --spacing-*`；不读取或变换 arbitrary style numbers。原 inline style 最后覆盖，系统 top 12、detents/height/keyboard/filter、呈现代际与关闭回调保持原 owner |
| NativeSelect 与共用 Sheet search | `select.content/header/group/item/compactItem/label`、同一有限 class 表 | `p-4 gap-3`、`px-3 py-2`、`gap-2`；选项保留 36/44 下限；search 保留 50pt、清除 44pt、17pt 字体。只改展示，原 query/ranking、List/ref/key、selection、IME 与 keyboard admission 不重建 |
| Bot 与 Task read/edit 表单 | `pages.settings/editor`、`forms.group/groupLabel/action/readAction/taskRow`、`settings.card/field` | 复用实际 Settings 自定义 section/title inset 固定 8、页面固定 18；Input/TimeField 的 rem padding 与 multiline rem minHeight 显式缩放；文本/字体、Switch track/thumb、日期系统控件与 mutation/readback/dirty owner 不变 |
| Bot 渠道页与详情附属区 | `pages.channels/sheetSimple`、`forms.group/readAction/taskRow` | 既有 `gap-4 pb-8`、dialog `p-5 gap-4`、卡片 `p-4 gap-3` 与动作 `p-3`；配对/连接协议与二维码像素大小不变 |
| Task history 与模型 picker | `pages.taskHistory/modelPicker`、`forms.historyCard` | 既有 `px-3 pb-6 gap-3`、`px-2 pb-6 gap-2`、history row `p-4 gap-2`；reader 捕获、重试只读、List keys 与原回调不变 |
| Bot/计划目录附属滚动内容 | `pages.assistantCatalog/scheduledHistory/scheduledTasks` | Bot catalog 的 Web `gap: .875rem` 按 14×scale；固定 18pt page inset 与实际 bottomInset 分离；计划现有 rem 顶部/行间距与 pb-8 分开；不更改列表顺序或 keyExtractor |

`application.tsx` 与 `new-session-page.tsx` 本轮没有修改；`SettingsInput.inputStyle?: TextStyle` 保留。Prefs 本轮业务代码没有改动，只为最外 Scroll 添加 contentStyle、导入 nativeDensity，并将 padding 的独立 metadata 分类接到已有 appearance 消费者。保存、receipt 和 reader 修复由其独立 owner 负责。

本轮列出的层级没有保留“已知未接线但声称已完成”的条目。剩余验证阻断是实际平台证据：UIKit 中系统 Sheet 内容约束、Select 搜索/IME/物理键盘、44/36pt 热区、长语言与 200% 窄屏、密度热更新的阅读锚点、Voice 采集与真实 Host 的保存/恢复。纯渲染、类型和 reader/core 测试不能证明这些平台行为。

第二批最终验证记录（分组存在交集，不相加为总数）：

- density/实际 outer props/Select/Sheet/Prefs metadata/Voice confirm：8 文件、110 项通过。
- 几何与 Bot/Task/picker reader/工作树 controller：11 文件、111 项通过；picker 的原选择失败恢复、捕获 generation/reader fence 已扩展至 50/100/105/200。
- Settings 生产保存/导航/Host scope/前后台恢复：4 文件、132 项通过、4 项既有跳过；只为 fixture 增补只读 nativeDensity stub，没有削弱行为断言。
- skill 内设置审计 44 路径通过；最终 dead-code 完成，报告没有本批 density/Sheet/Select helper，既有 workspace/fixture 告警保留。
- NSH tsc 在本批中途通过；最终两轮被并行资源预览改动阻断：`resource-html-viewer-state.ts` 的 preview/source 类型与 `resource-html-viewer.tsx` 的 common.retry key。未修改这些独立 owner 的源文件。最终合包需重跑 tsc。

没有运行 UI engine、模拟器/设备、真实 Host、Git 或依赖修改。

Settings 首页顶部 P2 修正后：实际 SettingsHome Scroll 在 50/100/105/200 四档均断言 paddingTop 为 16pt；聚焦 `native-density.test.ts` 与 `native-density-surfaces.test.ts` 共 2 文件、24 项通过，最终 NSH tsc 通过。未修改 header/safe-area 或任何旧构建产物。
