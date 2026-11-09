# 桌面 Chat 主列布局 slice

本 slice 是原生布局组件及独立实引擎 fixture，不是整包 Chat 1:1 完成声明。本轮修改限于 `desktop-chat-layout*`、`tests/desktop-chat-layout/` 及 `chat-layout-surfaces.tsx` 的窄 Row type passthrough；未改 application、state、drafts、Host、WorkStatus/header owner、sidebar、panel、新会话或现有业务 controls。

## Web 对照

已通过自己的 Ego taskspace 读取获准的开发 Web 页面，看到真实登录态并只选择一个现有会话查看，没有输入、发送、修改会话正文、调用模型或写 Host。页面记录只用于本次尺寸测量，不把真实正文复制进 fixture。已关闭该 taskspace；Ego 提示有升级，未执行升级。

| 区域 | 实际观察 / 当前源码 | 原生布局表达 |
| --- | --- | --- |
| 标题 | Web `role=tablist` 48px；会话切换标题、操作菜单、上下文、工作状态、预览等仍在此栏 | 继续使用 main 的唯一 `desktopChatHeader`/shell，不在主列重复建 header |
| 标准列 | 1068 窗宽时800px列，24px横向内距，实际正文/输入752px；1440仍800/24；1700变960/24，实际912px | `NativeDesktopChatColumn` 为 `width:100% + maxWidth`，不把 window 宽当 pane 宽 |
| 窄窗 | Web 800窗口横向内距16px；主列可受侧栏、工作状态/工作台影响 | window只决定断点；实际父列布局决定宽度，无固定窗口减法 |
| 宽布局 | `typography.css`：1600以下1024、1600以上1152 | 显式 `wide` 参数，调用方传权威偏好，不猜测 |
| 密度 | `typography.css` padding乘 `--padding-scale` | 显式 `paddingScale`，默认1；不另建偏好 owner |
| 输入底距 | form `pb-4`，实际16px，无桌面 safe area/软键盘补偿 | in-flow foot，16pt底距；不是手机浮动胶囊 |
| 输入表面 | Web圆角24、保留1px边框；浅色背景/50%边框/轻阴影，暗色背景＋foreground8%，hover/focus11% | 单表面、局部装饰色层，无glassEffect/blur；不将NSHEditor背景再叠为另一块材质 |
| 输入文本 | 实测52px高，16px top /12px horizontal /8px bottom；原surface内另有4px header inset；最大160 | 原Input使用导出的 `desktopChatEditorStyle`；不再外包原手机px-3 |
| footer | padding 6px vertical、10px horizontal；gap6；普通按钮24；当前Web模型控件行实际29 | 两个原control slots；不复制模型、Agent或sender |
| edge fade | Web `DesktopComposerEdgeFade` 44px，位于foot上方 | 同尺寸本地渐变，无点击命中/无滚动写入；empty分支 `edgeFade=false` |
| 消息间距 | `ChatMessage.tsx`：user/header top24，续段0，terminal bottom32，working4，notice6/6 | `NativeDesktopChatRow` 的显式 role/header/continued/working，替代一刀切List gap20 |
| 已有会话空态 | `ChatEmptyState.tsx`：140px低透明品牌图、24px gap、普通说明文字 | `NativeDesktopChatEmptyState`，不使用新草稿的大标题；品牌是空态装饰，不是消息头像 |

源码依据：`packages/ui/src/styles/typography.css`，`ChatContainer.tsx`（in-flow foot / fade / empty / loading-error分支），`ChatInput.tsx`（`COMPOSER_TEXT_LAYOUT_CLASS`、`footerPaddingClass`、desktop footer、`chatInputRadius`），`ChatMessage.tsx`，`ChatEmptyState.tsx`，`composer/DOCUMENTATION.md#input-responsiveness-contract`。

NSH只读依据为用户指定0.4源码基线：`website/elements/input.md` 与 `crates/nsh-platform-macos/src/text_input.rs`。后者明确输入按core content box定位，`NSTextView` 使用零textContainerInset、零lineFragmentPadding、`drawsBackground=false`；因此本slice把文本内距给真正Input，父表面只拥有边框/圆角/底色。没有猜测Editor、nativeAPI或新bridge契约。

## main 精确接线

从 `./desktop-chat-layout` 导入：

```ts
NativeDesktopChatLayout
NativeDesktopChatComposer
NativeDesktopChatRow
NativeDesktopChatEmptyState
desktopChatListContentStyle
desktopChatEditorStyle
```

从 `./desktop-chat-layout-core` 导入 `desktopChatContentWidth`，如果需要取几何也可用 `desktopChatGeometry`。

仅在 `platform.desktop` 分支组合；iOS原NavPage、NativeComposerChrome、safeArea、keyboard、compact、List占位与chrome事件完全不变。不要在未选择的平台分支提前构造一份新Input/selection sender。

```tsx
<NativeDesktopChatLayout
  feedback={/* 原speech error / chat.error / pending-send retry */}
  transcript={/* 原同一List及其原loading/empty/error条件，不是新List */}
  historyFeedback={/* 原history.Indicator及focus status/retry */}
  blocking={/* 原BlockingRequests */}
  edgeFade={/* populated/hydrating/error branches的真实布尔值；empty=false */}
  composer={/* 下方同一NativeDesktopChatComposer */}
  statusPanel={/* 原 NativeDesktopWorkStatusPanel；不在此创建 owner */}
  bodyRef={/* 保存原生 ViewRef，用 measure().pagePosition 取 root 坐标 */}
  onBodyLayout={/* 真实 body frame 变化时，委托原 window owner 测量 */}
  overlays={/* 原ChangesSheet/Timeline等 */}
/>
```

`NativeDesktopChatComposer` props 精确如下：

| prop | 接原内容 |
| --- | --- |
| `wide?`, `paddingScale?` | 现有桌面外观偏好，无authority时省略 |
| `reserveRight?` | main 原 WorkStatus layout 的 reserve：inline 210、popup/隐藏 0；只在 outer 生效 |
| `attachments?` | 原附件行/取消handler；不要另复制一份附件集合 |
| `feedback?` | 原NativeDraftFeedback |
| `queue?` | 原NativeChatQueue |
| `goal?` | 原NativeGoalRow |
| `status?` | 原Changes/Tasks的同行容器及statusPopovers owner |
| `inputHeader?` | 已有quote/header内容（若存在） |
| `editor` | 原Input的全部ref、value、IME、selection、referenceKeyboard、onSubmit、onChange；仅desktop应用 `{...nativeChatTextStyle('composer'), ...desktopChatEditorStyle}`，去掉冲突的手机padding/144高类 |
| `recovery?` | 原AttachmentRecovery等 |
| `leadingActions?` | 原附件/permission/Goal chip和counter/听写/shell-exit；按真实Web顺序放原控件 |
| `trailingActions?` | 原NativeComposerSelection和NativeComposerSend，现handler、authority和shortcut发布保持原样 |
| `focused?` | 原editorFocused信号，仅用于表面材质，不另监听输入 |
| `anchorRef?` | `view => composerAnchor.set(view)` |
| `onWidth?` | `width => composerWidth.set(width)`，只发布正native测量，供原候选浮层使用 |
| `overlays?` | 原`/`和`@` Overlay，anchor仍为上面的真实surface ref |

desktop外面不再包NativeComposerChrome、手机px-3/pt-2/keyboardFrame/safeArea inset。不要将compact/editor或同一control构造两次。slots本身不更改modal禁用、Host fence、unknown retry或隐藏状态，全部仍归现control。

原List继续持有唯一ref、`inverted`、`onLoadMoreAtStart`、分页和全部scroll/viewability事件。desktop设置 `contentStyle={desktopChatListContentStyle}`，原header的16pt保留；row外改用 `NativeDesktopChatRow`，其children保留现NativeTurnHeader/NativeTranscriptBody/NativeTurnError/NativeMessageActions。不要把原maxWidth780/横padding12和新column再叠一遍。`header/continued/working`取同一个turn projection的真实header/footer/live authority，不用当前busy猜历史终态。

原List `onLayout` 的正width可以保存在Chat局部resize-only信号（不新增逐行 List/ref/正文测量 owner）；以 `desktopChatContentWidth(actualListWidth, windowSize().width, wide, paddingScale, reserveRight)` 传现 `NativeTranscriptBody.contentWidth`，限制85%用户气泡/Activity头像区域。第五参数可省略，旧四参数调用完全兼容。传**完整原 List 宽度**，不要先减 reserve 后再调用。宽度未知返回undefined，不把临时0当成权威宽度清空内容。这不是新滚动补偿，也不会在输入时扫描历史。

### WorkStatus 几何端口（冻结）

```ts
NativeDesktopChatLayoutProps.statusPanel?: JSX.Element;
NativeDesktopChatLayoutProps.bodyRef?: (view: ViewRef) => void;
NativeDesktopChatLayoutProps.onBodyLayout?: () => void;
DesktopChatColumnProps.reserveRight?: number;
desktopChatContentWidth(paneWidth, viewportWidth, wide?, paddingScale?, reserveRight?): number | undefined;
```

共用 body 是始终挂载的 `desktop-chat-body`：relative、flex-1、min-h/min-w-0，依次容纳原 viewport/transcript、historyFeedback、blocking、原 foot/composer，以及独立 statusPanel sibling。顶层 feedback 在 body 之前，原 overlays 在 body 之外；不会因 statusPanel、reserve 或弹层切换重建 body/List/Input。slot 本身没有 effect、GET、timer、projection 或 WorkStatus/window owner。

main 将原 `NativeDesktopWorkStatusPanel` 放入此 slot，显示/隐藏、fits 和业务准入沿用已有 WorkStatus 合同：inline right14/top8/width196，reserve210；popup width264、reserve0。坐标源必须是：

```ts
const measured = await capturedBodyRef.measure();
// 由原 owner 复验 current、ref 和读取代际，再采用：
const chatBounds = measured && {
  origin: measured.pagePosition,
  size: measured.bounds.size,
};
// Popup: x = chatBounds.origin.x + chatBounds.size.width - 14 - 264
//        y = chatBounds.origin.y + 12
```

NSH 0.4 `ViewRef.measure()` 的 pagePosition 才是所属 surface/modal root 坐标；`onLayout.bounds.origin` 只相对 parent。`bodyRef` 仅转交原 ref，布局模块不调用 measure。`onBodyLayout` 对相同 x/y/width/height 去重，无参数是有意避免误用 parent bounds；不订阅草稿，也不因普通输入发布 callback。body 原 frame 不变而祖先仅平移时，NSH 不保证触发这个局部 onLayout；main 应在真实 window/pane 几何变化入口显式重新测量，不能依赖输入 effect 或假定 header 高48来补坐标。

Row 和 Composer 的**原 full-width outer**各自单次 `paddingRight`；原 List/viewport/contentStyle 无右 padding、不缩宽。内部 `NativeDesktopChatColumn` 不消费 reserve，只在已扣除的父空间内居中，保留 windowSize 的 maxWidth/inset 断点。`NativeChatRow` type 扩展为原 spacing + DesktopChatColumnProps；现有 desktop 分支原样透传，iOS 分支不读这些新增 props。Body/Composer 的既有 iOS 分支同样不读 statusPanel/bodyRef/onBodyLayout/reserve。

`reservedColumn` 只保留 outer 的正 native onLayout width，且仅宽度真实变化才更新局部信号；不发 measure 命令，不接管 List 测量/滚动，也不在每行计算 transcript。首帧未知宽度时 reserve 暂为0，原生宽度到达后采用合法 reserve，不用 windowSize 猜 pane。NaN、负数、无限值，以及大到不能留下 `2*columnInset+1` 的 reserve 均归0；这个规则与纯 contentWidth helper 一致。它只处理错误几何，不自行关闭 main 的 WorkStatus。helper 最小有效 content 为1，正常有效空间先减 reserve，再限 columnMax、减两侧 inset，绝不双减。

隐藏内容应继续由原 Panel 的 presence/visible 边界或 lazy `<If>` gate；slot 不会读取或构造另一份 projection，也不能替调用方撤销在传 JSX 前已发生的 eager 计算。iOS 不读取 slot，隐藏组件没有新挂载机会。

### 明确未由布局修复的既有 controls 差异

测量时原 `NativeComposerSend` 仍是32pt手机触区，而Web桌面按钮24pt；原 `NativeComposerSelection` 为26pt/11pt字体/96pt label限宽。此slice不缩放、裁切或重实现这些control。独立fixture导入的是真正NativeComposerSend，因此当时表面102pt高，与Web99pt有3pt差异。若main扩展现control的显式desktop presentation，fixture仍可消费原control；不要为了102pt测试锁死该差异（测试允许正确99–102范围）。桌面实际控件样式和相应AppKit/Win32验收仍需main收敛。

## 验证

运行：

```sh
NSH_BIN=/path/to/0.4/nsh bunx --no-install vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/desktop-chat-layout-core.test.ts packages/nsh/desktop-chat-layout-native.test.ts
bunx --no-install tsc --noEmit --project packages/nsh/tsconfig.json --pretty false
```

每次测试创建独立系统临时目录、theme绝对引用、App/test entry和NSH输出，不碰共享 `.nsh/test`。无需Host adapter、用户连接/凭据、网络、依赖安装或真实Host写入。

- 纯几何测试：window断点、wide/density、row各状态、真实pane宽、unknown首帧、reserve在maxWidth之前单次扣除、invalid/oversized reserve归0。
- 实际NSH headless：Mac/Win各6场景及1个iOS surface分支场景；原生View/Input/List、生产NativeChatBodyLayout/NativeChatRow/NativeChatComposerLayout、NativeTranscriptBody/NativeTurnHeader/createNativeHistoryRows及真正共享send控件，不是DOM/源字符串mock。
- 测量标准752、≥1600时912、wide1104、右侧400pane打开后360、窄窗508；Input52；resize不重挂Input/List。
- 50次输入事件只更新fixture唯一草稿信号；已挂transcript projection零重算；无网络请求；hover/resize不改变owner。
- 模态readonly/disabled保原稿，恢复后send委托一次；中文paste保留；queue/Goal/附件/失败/重试/阻塞同时存在时footer在流内，List仍有正视口，空态也保原Input。
- 新增1000/1440窗口和408窄pane：reserve 0→210→0，正文与composer在剩余空间共轴，1440下752宽表面左移105，1000下498、780pane下522、408pane下150；完整List宽始终保持740/1180/780/408。极大/NaN/负数/Infinity reserve回0后宽度恢复，Input/List/body的原ref和mount计数均不变。
- 使用合成几何slot测量真实native inline right14/top8/width196与root Overlay宽264/偏移12；body因feedback位移后坐标仍从pagePosition更新，不拿局部bounds.origin冒充root。该slot不模拟业务WorkStatus source或window owner，不将这些断言称作actual-root签收。
- 隐藏和inline可见时各50次input：额外body callback/measure为0、GET为0、row projection重算为0；隐藏slot首次及开关后50次metadata变化均零projection。iOS实际surface分支忽略所有新增端口，reserve变化不改原row/composer宽，body ref/callback/slot projection均为0。

`bun run dead-code` 已尝试，仍被现有工作区缺 `vite-plugin-pwa` 阻断，未补装依赖。完整真实App主根接线、AppKit截图/hover/选区/物理键盘/中文IME/undo-redo和Win32绘制未由此独立fixture验证；headless没有真实绘图，不能声称视觉签收。这里也没有满足输入性能合同的真实设备50次input-to-paint测量，不将零projection重算等同于P95达标。滚动锚点与晚到大Markdown/图片仍由原List专项负责，没有新增JS writer或关闭原缺口。

前一阶段为2个Vitest文件4项通过、native runner含6场景；当时最终全包tsc受并行翻译key缺失阻断，未越界修改。本轮WorkStatus几何追加后，focused为2文件5项（4项pure + 1项包装13个真实NSH场景）通过；最终再加原 `desktop-work-status-core.test.ts` / `desktop-work-status-native.test.ts` 一起回归为 **4文件15项通过**。独立临时tsconfig（含生产fixture、surface passthrough与完整engine test文件）和全包tsc均重新通过。dead-code仍被既有 `vite-plugin-pwa` 缺失阻断，未补依赖。没有修改上游NSH，也没有运行Git/GitHub、真实Host写入或用户数据请求。
