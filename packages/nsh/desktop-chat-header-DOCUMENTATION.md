# Desktop Chat Header：冻结接线 API

本 slice 仅新增 `desktop-chat-header*`，不修改 application、手机 header、state、desktop、Host 或其他 worker。main 替换唯一 `desktopChatHeader` consumer；标题/选择器、左侧 Search/Sidebar、系统窗口按钮继续归原 root，不重复渲染。

## 冻结 API（本轮实现中，不代表生产已接线）

入口 `NativeDesktopChatHeaderActions`（`desktop-chat-header.tsx`）：

```ts
type Props = {
  scope: unknown;                       // 稳定 exact route + Host authority + lease identity
  current: () => boolean;               // 仅 authority，不混模态；原 root 必须再检查
  active: boolean;                      // 交互许可；false 保持挂载与 metadata
  operation?: () => { current(): boolean } | null;
  metadata?: ChatHeaderMetadata;         // 原 owner / 主 Chat projection；此组件零 GET
  sessionTitle: string;                 // 只读 AX 上下文，不再画第二标题选择器
  status?: { workStatusSelected: boolean; panelOpen: boolean; contextOpen: boolean; browserOpen: boolean };
  actions?: DesktopChatHeaderActions;   // 见 core，available + run(intent) 返回明确 status
  host?: { label: string; icon?: IconName; showButton?: boolean };
  openInApps?: { applicable: boolean; selectedID?: string; apps: { id: string; label: string; icon?: string }[]; scanning?: boolean; stale?: boolean };
  github?: { connected: boolean; login?: string; avatar?: string; accounts?: { id: string; label: string; login?: string; avatar?: string; current?: boolean }[] };
  services?: { instance?: () => JSX.Element; mcp?: () => JSX.Element };
  shortcutLabels?: Partial<Record<'mini-chat' | 'terminal' | 'browser' | 'services' | 'usage', string>>;
  onResult: (action: DesktopChatHeaderAction, result: DesktopChatHeaderResult) => void;
};
```

`DesktopChatHeaderActions` 是 partial action→`{available,run(intent)}`。intent 带 captured scope/value/current；业务 consumer **须在真正导航/写之前及 await 后复验 intent.current() 和原 owner current**。无 void/boolean 假 ACK；只允许 accepted / unsupported / failed / unknown，core 退休返回 stale。throw/畸形回执为 unknown，不乐观改状态，不重试。`onResult` 由 root 写入原内容区反馈，不挤占 header。端口对象同 scope 保持稳定；getter 可读最新 available。若替换端口，在途旧 port 退休。

组件所有 popup 共用局部呈现状态，使用 NSH 0.4 Menu/Popover/Tooltip（ContextMenu 不是左键菜单，不滥用）。自身无 Chat、目录、catalog、transport、Storage。active/后台/operation 失效关闭 popup、废弃在途 action，**不清 metadata、不销毁数据 owner**。scope 应不可变且仅 authority/route 真变化才换，不用标题、busy、draft、模态作 key。同身份恢复不重挂组件。

## Web 实际入口与 main 接线

依据当前 Web `components/layout/Header.tsx`：desktop `sessionOverflowMenu` 仅 Mini Chat、实例/用量、Terminal、Browser；直接栏为 subtle context ring、WorkStatusToggle、OpenInAppButton、DesktopCurrentHostButton、Files panel toggle、已连接 GitHub。标题选择器独立；`TitlebarLeftControls` 独占 Search/Sidebar/OS menu。无 header 模型 picker、Files/Changes/新会话/自动朗读/远程桌面手机菜单。

| 新端口 | main 要接的真实 owner / 现状 |
| --- | --- |
| context | 已有 main workbench context 打开/切换；不可改开手机 metadata popup |
| toggle-panel | 已有 openFiles/panel owner，须保留开关语义；不要每次强制新标签 |
| refresh-usage | 原 ChatHeaderMetadata controller.refreshQuotas(true)，只在明确打开 usage / refresh 时读取，不逐 render/input 读取 |
| quota-mode | 真实偏好 owner 保存后发布 quota snapshot；若无此 owner，显示不可用，不本地假切换 |
| terminal | root 已有 layout.toggleTerminal 与快捷键 owner；消费返回 accepted/unsupported，不能只调用 void 当成功；应检查同步权威布局确已切换 |
| browser | 原工作台已能承载 browser tab，但 Web 的“切换 browser mode / 默认地址”还须 main 接精确 owner；不能为填入口猜 URL 或把系统浏览器当工作台，未接则 disabled + unavailable |
| work-status | Web WorkStatusPanel/overlay 的 native owner 仍须接；缺失时保留禁用按钮与 unavailable Tooltip |
| mini-chat | 新窗口 exact session/draft native capability；没有端口保留 unavailable 菜单项，不猜 Host command |
| open-app / select-app / copy-path / scan-apps | 本机/SSH editor capability 和既有安全路径 owner；`applicable` 来自权威判定，未知留不可用入口，不擅自枚举目录/应用 |
| github-account | 原 GitHub 多账户 owner；无已连接快照不画凭空头像；connected 多账户缺 action 则保留禁用行 |
| services.instance | 注入现有连接/实例内容（根 root owned slot），不构造第二连接引擎；缺 slot 显示 unavailable |
| services.mcp | 注入真实 MCP 状态/操作内容；root 已有 openMcpSettings，但不能拿设置页冒充 Web MCP 运行态面板；缺 slot 保留 unavailable |

root 已有 newSession/openFiles/openChanges/openMcpSettings/refresh/autoRead/remoteDesktop/mainworkbenchcontext；它们继续在各自真实桌面入口使用。不能为“接齐”而塞回 Header 的 mobile menu；尤其 selection 不创建虚构模型 picker。autoRead/title/status 等已由同 Chat 拥有，不另建状态源。sessionTitle 仅作 AX，autoRead 不在 Web 此 header，故不另加切换 props。

main 换 consumer 后要避免保留旧 `desktop-terminal-toggle` / `desktop-context-toggle` 两个独立 32px 按钮再叠加本组件；Terminal 应迁至本菜单、Files panel toggle 应只剩本组件的 28px 位。这里只提出装配要求，不修改 main 文件。新 header 的 `active` 必须是交互态，不能用它控制 `desktopChatHeader` 是否注册/挂载；保留 publisher 和只读 metadata，模态仅传 false。Host/route 真退休才撤下 publisher。

main 若继续使用 `createChatHeaderMetadata`，必须放在 retained Chat/root owner 而非条件 header render slot 下；模态禁交互时保留快照和 controller，在 Host/operation 真退役时 cancel/fence，严禁旧 Host changed 发布到新 scope。也可直接把原 Chat context 主源投影传 metadata，避免重复 GET。该组件不自动调用 metadata 刷新；打开 usage 的首次读取通过已注入 refresh-usage 端口，原 owner 自行去重/缓存。性能预算：额外 50 次输入零 GET、零 catalog/目录枚举、零 metadata remount。

## 证据与未验

布局来源：Web header 48px、gap 4px；··· 32px / 18px 图标；其余 28px / 16px；context 显示 16px、SVG viewBox 18/stroke 2，静态中性灰；OpenInApp/实例 split 48×28；menu min 224，服务 max 432，offset 6/margin 12。NSH 使用实际 native popup 呈现和 token，不仿手机圆底 36px。

### 当前 Web 与固定 NSH 依据

- 只读 Ego 独立 taskspace 138 打开当前 5180；没有输入、发送模型或改 Host。实际停留新草稿，观察到标题选择器 32px、会话菜单 32×32、WorkStatus/Files toggle 均 28×28；Search/Sidebar 在独立左侧区，当前新草稿没有上下文环、模型 picker 不在 header。已结束本 taskspace。此 live 观察不冒充已选会话/菜单交互的截图签收；会话、实例、应用和 GitHub 分支另依当前源码。
- 完整读取当前 Web `Header.tsx` 的 desktop render / overflow / services、`TitlebarLeftControls`、`WorkStatusToggle`、`ContextUsageDisplay`、`OpenInAppButton` 和 `DesktopCurrentHostButton`。current Host/selected app 不从目录或平台猜，应用与账号不主动枚举。
- 固定引擎为 `nsh 0.4.0 (e626a8d)`；本地 NSH 源码只读，使用 `website/elements/{menu,popover}.md`、gallery Tooltip 与生成的 `nsh/base` 类型。Context7 resolve 返回月配额耗尽，未换用不匹配版本的文档。NSH `Button` 没有 onFocus/onBlur，按实际 API 不传；上下文键盘仍拥有完整 AX label 与原生 Tooltip，hover/已选/pending 显示数值。

### 实现边界仍需 main 完成

1. Mini Chat / pin：Web 的 Mini Chat 新窗口入口保留禁用的 unavailable 行；本 slice 不调用 rootWindow、不猜 `desktop_open_session_mini_chat_window` 的 Native bridge。rootWindow 只证明拥有当前窗口，不证明能创建第二业务窗口；pin 在原 Mini Chat 窗口，不新增主 Header pin。需要 verified create-window、exact session ownership、生命周期与置顶能力后才可 available=true。
2. 服务 Instance / MCP 依赖根注入真实内容与原 consumer。没有 slot 时 tabs 和 unavailable 仍在，不改成假的连接或配置成功。MCP settings 入口不能代替 Web MCP runtime panel。
3. quota 使用既有 `HeaderQuotaSnapshot` 的完整 bounded rows、provider logo、account heading、reset、failure/stale 状态和 6pt progress bar；模式不本地乐观切换。**旧 snapshot 已把 per-model family 分层压平，未带 Web pace/expected-marker/showPredValues/lastUpdated metadata**，因此这一层仍不是 Web services usage 的完整 1:1。主数据 owner 后续应提供原 quota projection/纯 family metadata，不能从格式化 subtitle 或模糊字符串反猜模型身份；本 slice 不扩建 catalog/transport 来填这个缺口。该缺项不影响真实 rows/error 保留，也不能被算作完整签收。
4. metadata 与 scope 必须由原数据 owner 原子发布并在 captured Host/operation 的 changed 回调复验。组件不具有第二 source，不能替 caller 区分未标 scope 的错误快照；scope 变化时 caller 不能先换 scope 又短暂传入上一 Host metadata。

headless 平台模型与布局数字不等于 AppKit/Win32 视觉/物理键盘签收，真实 Host 能力缺失必须继续标未完成。

### 本轮最终验证

```sh
# NSH_BIN 指向固定 0.4.0 distribution；所有 native 场景使用独立临时 config/入口。
bunx --no-install vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/desktop-chat-header-core.test.ts \
  packages/nsh/desktop-chat-header-native.test.ts \
  packages/nsh/chat-header-metadata.test.ts \
  packages/nsh/chat-header-quota.test.ts
bunx --no-install tsc --noEmit --project packages/nsh/tsconfig.json --pretty false
bun run dead-code
```

- 4 文件 **31/31 通过**。新 core 12 项覆盖缺端口、accepted/unsupported/unknown、throw/畸形回执、精确 scope/value、重复提交、stale finally、Host/current/operation/port/dispose 退休；旧 metadata/quota 回归保留晚到 Host、失败 prior 与有界目录读取规则。
- native wrapper 通过，内部 macOS/Windows 各 **6 个交互场景 + 1 个 mount-frame 场景**（合计 14）：桌面入口/无 mobile 额外项、context 真实/pending/stale、3 tabs、缺 slot、quota 完整 row/error/unknown bar/显式 refresh/无乐观 mode、应用/账号 ID、50 次独立 input 事件零 HTTP/Host call、模态/前后台保 snapshot、operation/current/Host 晚到 action 不提交、locale/420×360 窄窗、Escape/Back。
- mount trace 两平台 root **260×48**（合成 fixture 中全部已知入口）；相对 x 顺序 `menu=0, context=36, work-status=68, app=100, host=152, files=204, GitHub=236`，即精确 4pt gap；菜单32×32、环16×16、status/files28×28、两个split48×28，窄窗服务内容不超过396pt。是真实 NSH renderer 产生的 Frame，不是只断言设计常量。
- 整包 `tsc` **通过**（本轮修复了 NSH Button 事件不支持、literal size 和 nullable `%` 三类错误）。
- `dead-code` **未完成**：仓库既有 `packages/web/vite.config.ts` 加载缺失 `vite-plugin-pwa`，退出2；没有新增/补装依赖。
- 未执行 git/GitHub、真实 Host write、模型/语音付费调用、AppKit/Win32 window launch、Windows target build、同状态视觉对帧、物理键盘/读屏或最终 production root 接线。本轮读取 5180 会正常触发 Web 自身的只读 bootstrap，不含手工业务输入。

## 归还

本 slice 归还 `desktop-chat-header*.ts*` 与 `tests/desktop-chat-header/`。main 可读取上方冻结 API 接 root consumer；本模块自身不修改 owner/Host 合同。生产端口、未接能力与 usage family/pace 缺口必须在主验收账本保留，不能把本轮 headless 通过写成完整桌面签收。
