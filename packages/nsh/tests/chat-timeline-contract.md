# Native Timeline 装配合同

状态：独立 owner/surface 已实现；并行 application owner 已接入 `NativeChatTimeline`、真实 Chat callbacks 与共用 `resumeLatest`（本轮只读核对）。本模块没有修改 application、state、transcript-actions、composer router 或 new-session。下列回调测试与静态检查不代表 `/timeline` 的 UIKit 端到端验收已完成。

## 唯一 owner 与装配

`chat-timeline-owner.ts` 只持有 Sheet 开闭代际、单一 async action gate、关闭后 continuation 与错误。`chat-timeline-model.ts` 直接以现有 `nativeMessageEntry` 适配 authoritative messages，再复用 Web `getFullText`；按 Web `info.role === user` 过滤，保持源顺序和真实 message ID/time，不按 ID/时钟另排，不截条数/正文。用户正文全部参与搜索，大小写与 trim 规则相同。

Chat 装配保持以下 props seam；本次修复没有增加或改变公开 `NativeChatTimelineProps` 字段：

```tsx
import { NativeChatTimeline } from './chat-timeline';

const timelineOpen = signal(false);
const onOpenTimeline = () => {
  if (props.target.kind === 'session' && operations.current()) timelineOpen.set(true);
};

// 保留在 Chat 生命周期内，不能放进被回退隐藏的消息行。
<If when={props.target.kind === 'session'}>
  <NativeChatTimeline
    open={timelineOpen()}
    operation={operations.operation()}
    onOpenChange={value => timelineOpen.set(value)}
    messages={chat.messages}
    messagesResolved={chat.messagesResolved}
    focusedMessageID={() => focusState()?.messageID ?? props.messageID ?? null}
    more={chat.more}
    olderLoading={chat.olderLoading}
    historyError={chat.historyError}
    loadOlder={chat.loadOlder}
    focusMessage={messageFocus.focus}
    resumeLatest={resumeLatest}
    messageOptions={history.props}
  />
</If>
```

`resumeLatest` 需由 application owner 将现有 `compact-latest` 按钮的动作提取为同一个函数，再让原按钮与此 prop 共用。当前实际动作是 `current() && chat.active()` 准入、`chrome.expand()`、`transcriptRef()?.scrollToIndex({ index: 0, animated: true, viewPosition: 1 })`；后续原生 `onLoadMoreAtStart` 继续交 `historyScroll` 刷新最新域。不得在 Timeline 复制滚动逻辑或另建 ref。`focusedMessageID` 应优先注入 Chat 当前已有的真实 focused-message authority；示例使用当前可见的显式 `focusState`/route message ID，未知时由 Timeline 默认选择最后一条 user 消息，不捏造可见行定位。Timeline 的 List ref 只定位 Timeline 自己的选中行；消息跳转唯一调用 `messageFocus.focus`，只在返回 `revealed` 时关闭，其余状态保留 Sheet 与失败提示，允许再次点击重试。

`messages` 必须注入 `chat.messages` 的完整已加载 authority，不能用 body rows、每 turn 的摘要 head/tail 或人为 slice 替代。没有读取的 opaque 历史页仍由“加载更早”按钮逐页读取，不宣称全 Host 历史已下载。失败保留已有行与错误，显式按钮可重试；未知 `messagesResolved` 显示 loading，不当成功空记录。

## 命令 router owner seam

向现有 Chat composer/router options 注入同一个 `onOpenTimeline: () => void`；本模块没有改动这些并行 owner。

- 本地 `/timeline` 候选的选择仅插入命令，不在候选点击或 Tab 时打开，不发送 Host 命令。
- submit 识别本地 `/timeline` 后调用 `onOpenTimeline`，正文与附件完整保留，返回路由 owner 已有的 handled 结果。
- `/timeline` 不绑定 sessionSwitcher，不创建新会话，不执行模型请求；是否准入仍由原 router 和 Chat operation 决定。
- 新会话没有当前 session Timeline authority，不能借同名 Host command 冒充本地能力；由 router owner按现有新会话本地命令合同处理。

## 系统 Sheet 与写入

NativeSheet 真实 `onOpen` 前不创建正文/消息投影。`onOpen` 后构造虚拟 List，条目使用 primitive source ID，复用原生 `maintainVisibleContentPosition` 处理 prepend，不写 JS offset。搜索和正文均复用 canonical appearance/density、原 Button、SheetSearch 与已有十语言 key；日期/时间与 Web timeline 的 Intl options 一致，独立原生 locale 输入避免导入 browser i18n。

revert/fork 仅调用 `createTranscriptActions(history.props(message))`；原始 `send`、scope、busy、onPending、onChanged、onRevert 与不确定结果处理全部保留。Timeline 给 scope 叠加捕获的 page-operation / Sheet generation fence，不签发新写入 authority。revert 使用既有系统确认。fork 的原 `onOpenChat` 包装为同 scope continuation，只在真实 Sheet dismiss completion 后调用，不能提前推进导航。

确认等待、分页、消息定位、fork/revert 和返回最新共用一个 gate；按钮、Escape、拖关与 backdrop 共同受 pending 保护。page/Host/operation 失效立即关闭并撤销旧回调的采用；原根保留到真实 completion，关闭中 reopen 排队。旧 completion/旧 finally 不能清除新代状态。已发原生请求不宣称物理取消。

每个 `Each` presentation 在构造时捕获固定 generation 与 **同一个 operation 对象**，内容持有该票据的 `interactive`/`close`/`dismiss` 闭包。fork/revert/goto/older/latest 必须先验票，之后才能进入 `owner.run` 和调用实时 `messageOptions`；不能让旧 UI callback 在触发时重新捕获新代 authority。搜索、选择、键盘与原生 `onOpen`/`onOpenChange` 也受该票据约束。真实 `onClose` 继续只带捕获 generation 进入原 owner，以便 operation 退休时仍能完成旧根关闭；旧 completion 无权关闭新代。此修复只加强 surface 的事件接纳，没有改 pure model、owner 的 started-async gate 或父层 props 合同。

## 证据与未完成

- `chat-timeline-model.test.ts` 验证全文尾部匹配、240 条无截断、源顺序/时间、十语言时间格式。
- `chat-timeline-owner.test.ts` 验证 presentation admission、重复动作门、失败/显式重试、pending-close、completion 才导航、重开和旧代完成、退役 async fence。
- `chat-timeline-ui.test.ts` 用生产 TSX 的 lazy props 与真实 `createTranscriptActions`，在 Node/VM 中触发 search/goto/older/fork/revert/latest；没有真实 Host 写入。50 次关闭期间消息变化零 projection。验证正文延迟构造、失败保留行、双击不重发、原 history callbacks、分支 completion 导航和 deferred revert 退役。新增回归保存第一代实际 fork/revert/goto/latest/older/close 及原生关闭 callback，完成关闭、更换 operation、第二代重开后逐个直接调用；相同 message ID 保留，仍须零确认/读取/写入/定位/最新/关闭。验证当前代动作正常，并覆盖同 operation 的 queued reopen、fork completion 才导航与旧 close/completion 拒绝。修复前两项回归实际失败，修复后通过。
- 这些不是 NSH SDK 编译器、UIKit、VoiceOver 或真实设备的证据。仍需主 owner 验证 `/timeline` submit 不改正文/附件、真实 NativeSheet 返回/搜索/关闭、超长变高行与 prepend 阅读位置、pending 时系统拖关及跨 Host/后台/全屏关闭重开。

本轮 P1 修复验证：上述三份测试合计 14 项通过；连同现有 `transcript-actions.test.ts` 与 `history-focus.test.ts` 合计 56 项通过。`tsc -p packages/nsh/tsconfig.json --noEmit` 通过。`bun run dead-code` 已执行并检查，本轮不再列出 `packages/nsh/chat-timeline*` 未使用项（并行 owner 已装配）；未修改其它 owner 的 unused 项。前轮 `bun run --cwd packages/nsh nsh:check` 因环境没有 `nsh` 可执行文件（`spawnSync nsh ENOENT`）未能执行 SDK 编译检查，本轮没有运行 SDK、设备或真实 Host。修复冻结后交原 oracle 复核。
