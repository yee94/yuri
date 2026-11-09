# Desktop Context：独立 slice 交接

## 归还所有权

本 slice 已完成代码与独立验证，归还 `desktop-context*.ts*` 及 `tests/desktop-context/` 所有权。没有修改 application、desktop-panel、state、drafts、Host、sidebar、新会话或原 context-usage 模块。生产根接线由 main 所有；本文不是生产 App 或系统窗口签收。

## Web 权威映射

依据当前 `packages/ui/src/components/layout/ContextPanel.tsx` 的 context 分支，它直接挂 `ContextSidebarTab.tsx` 导出的 `ContextPanelContent`。实际内容如下，不按产品名猜功能：

| Web 内容 | Native 内容 |
| --- | --- |
| 会话标题、Provider / Model、创建日期 | `DesktopContextSummary`；metadata 校验 exact session / directory |
| Context 总 token / 模型上限、4pt 用量条、百分比 | 同一 `createContextUsageOwner`；Host root 的 `contextUsageTokens` |
| 消息 / User / Assistant 数量、总费用、可选 Session TPS | 共用已有统计与 TPS，未知不冒充零 |
| 最新有 usage 的 assistant 的 input / output / reasoning / cache read / write / hit / 可选 TPS | 共用 token normalizer、cache rate 与累计 turn TPS |
| User / Assistant / Tool Calls / Other 的 character/4 估算 | 共用已有 overview 的 composition，并明确区分部分 received authority |
| 最新优先的 Raw Messages、parts/user snippet、input/output/TPS、日期 | 原生虚拟 List；全部 raw rows，不截前几条 |
| 各条独立展开、JSON 高亮/软换行/选择/复制、复制成功状态 | NSH 0.4 原生只读 Editor（最多 416pt，内部滚动）；原始 received wire、live overlay 明示 `received/currentContent` |
| 无会话 | 复用现有 `contextSidebar.empty.openSession` |

这份 Web `ContextPanelContent` **没有 todo、changed files、skills、MCP 区块**。它们不能凭名称加进 Context；本模块也没有把 header/quota 的小型 usage popup 冒充完整面板。

## 精确 main 接线 API

`NativeDesktopContext` 是工作台 **content**，没有 NavPage、NavStack、Sheet 或第二 header。请在 `NativeDesktopPanel.context` slot 直接挂载它，替换临时的 `NavStack + ContextUsageRoute`：

```tsx
import { NativeDesktopContext } from './desktop-context';

context={(expected, active) => {
  const route = retainedChatRoute();
  const chat = route ? mountedChats.get(route) ?? null : null;
  const captured = captureHostOperation();
  return <NativeDesktopContext
    scope={expected}
    chat={chat}
    current={() => !!route && !!chat && panelCurrent(expected)
      && mountedChats.get(route) === chat
      && epoch() === chat.messageScope.generation
      && captured.current()}
    active={active()}
    read={path => captured.request(path, 'GET')}
    appearance={nativeAppearance.current()}
  />;
}}
```

- 若 map entry 的建立晚于 slot 构造，main 须在自身原 Chat mount/unmount 边界发布窄 revision，使 `chat` prop 收到真正的 entry；不能为填空创建另一 Chat，也不能改从全量消息请求取数。
- `current` 只表示真实 authority，不能混入模态状态。必须核对 Host lease、connection/origin/authorization（`panelCurrent` + 捕获的原生 operation）、Chat generation 和 map 中的原 owner。
- `active` 表示前台、工作台可见且 Context tab 选中。现有 slot 的 `active()` 在模态中也为 false：这会暂停读源并保留 projection/展开状态，不需要改 panel 接口。
- 若 main 已有独立可见态与交互态，可传 `active={visible}`、`interactive={!modalOpen}`：模态保留原 observer，但禁止 Retry/展开/复制、停滚动并 blur 已展开 Editor。两种路径都没有第二 stream。
- `appearance` 是 `Pick<AppliedNativeAppearance, 'showAssistantTps' | 'timeFormatPreference' | 'contextUsageTokens'> | null`，直接传当前 Host root 的原快照。不另读设置或生成默认主题。
- 可选 `onOwner` 发布只读 Context projection handle，供已有 session/catalog owner 的**真实 metadata 边界**调用 `refresh()`。不要在输入、消息正文 token 或普通父组件重渲染时调用。页面没有新增 polling。
- 已有原 Chat 的历史由 main 自己管理 `active/syncActive`；Context 不改变这些信号，不构造 sender/stream/durable store，也不拉全 messages。
- 原 Chat 不可用时显示本地化 unavailable，而不是另一会话、猜测目录或假空成功；`scope.sessionID === null` 才是无会话状态。

不需要 main 修改/导出旧 `context-usage.tsx` 的内部呈现。本模块复用 `context-usage-route-core`、source adapter、incremental owner、formatter、normalizer；专有桌面呈现只去掉 route/nav 所有权并增加可见/模态准入。

## 读源与性能合同

`createDesktopContextOwner` 构造时不取数。激活后只允许：

1. 原 Chat 已加载窗口的一次 snapshot；通过原 `observeMessageCommits` 接收 touched batch。snapshot/prepend/revert/exact-fill 等结构边界才重新读取当前窗口；正文 patch 不扫描历史。
2. exact `/api/session/:sessionID?directory=…` 与 `/api/config/catalog/providers?directory=…` 的 typed GET metadata。不会请求 `/message`、新建 SSE/poll/Chat。若原消息 GET 失败，用户明确 Retry 才委托原 `chat.load(false, ['messages'])` lane。

隐藏/后台取消订阅并 fence 在途 metadata；恢复采用当前 loaded window 一次。Host、lease、授权、session、directory 或 generation 变化使旧回调/操作无效。读取失败保留有效 metrics/raw，首次失败仍 unresolved；明确成功空快照才显示零。

规模证据：复用 owner 的既有 5100-record / 200-patch 测试同批通过；本 slice 另测 50 次无关更新及真实原生 Input 50 字输入后，metadata reads、消息 snapshot 读取、订阅与投影 operation counts 都不变。这是操作数证据，不是系统窗口 p95 延迟或真实 Host 性能签收。

## NSH 0.4 证据

只读指定 revision `e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3` 的本地源码/生成类型，依据 `website/elements/{list,editor}.md`、`website/modules/nsh-desktop.md` 与原生 Button/roving 实现。List 的 recycling state 由外层按 message ID 保存；Editor 使用该版本真实支持的 readOnly、softWrap、minRows/maxRows；不传不存在的 Button `accessibilityState` 或 Editor `focusable`。

## 本次验证

```sh
bunx --no-install vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/desktop-context.test.ts \
  packages/nsh/context-usage.test.ts \
  packages/nsh/context-usage-source.test.ts \
  packages/nsh/context-usage-route.test.ts

# NSH_BIN 指向给定的 0.4.0 distribution
bunx --no-install vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/desktop-context-native.test.ts

bunx --no-install tsc --noEmit --project packages/nsh/tsconfig.json --pretty false
bun run dead-code
```

- 核心/复用回归：4 文件 **45/45 通过**；其中新 desktop scope/demand/failure/retirement 测试 7 项。
- Native wrapper：**通过**，内部 macOS/Windows 平台模型各 4 个真实 NSH headless 渲染场景（共 8）。包括完整 metrics/raw、复制原始 wire 与 streaming overlay、模态 disabled、原消息 Retry、失败保快照、空成功、locale/TPS、后台/隐藏/authority 退休、输入零额外扫描。
- `tsc`：当时全包通过；并行修改后 main 应重跑。
- `dead-code`：执行后仍被仓库既有 `packages/web/vite.config.ts` 缺 `vite-plugin-pwa` 阻断；未补装依赖。
- headless 每次生成**独立系统临时目录**的 `nsh.json`、入口与 runner，测试后只删除本次目录；不使用或覆盖 `packages/nsh/.nsh/test`。

**未验**：最终 production `YuriNativeApp` 接线、真实 Host/SSE、AppKit/Win32 系统窗口、物理键盘/读屏、同状态 Web 视觉对帧、Windows target/实机。fixture 注入的是合成原 Chat 只读边界，不是第二生产 Chat；共用 route 的真实 `createChat` 测试是独立核心证据，不能冒充主 App 端到端。
