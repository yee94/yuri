# 搜索结果 → Native 消息定位

日期：2026-11-07。只新增 `history-focus.ts`、`history-focus.test.ts`、本报告；本轮没有修改 state/main/ios/其他 history 模块，没有运行 NSH CLI、engine UI、App headless、浏览器或设备。生产接线与 UIKit 由 main 独占。

## 精确 API

```ts
const focus = createNativeHistoryFocus({
  current: () => boolean,
  scope: () => string | number,
  hasMessage: (messageID: string) => boolean,
  isHidden: (messageID: string) => boolean,
  more: () => boolean,
  olderLoading: () => boolean,
  historyError: () => string,
  loadOlder: () => Promise<void>,
  reveal: (messageID: string) => boolean,
  changed: (state: NativeHistoryFocusState) => void, // 可省略
});

await focus.focus(messageID);
await focus.retry();
focus.cancel();
focus.state();
```

`state()` / Promise 结果为 readonly `{ status, messageID, error, loads }`：

| status | 含义 |
| --- | --- |
| `idle` | 尚未请求 |
| `loading` | 正在逐页寻找/等待原有 older flight |
| `revealed` | 当前 scope 的 `reveal(id)` 返回 true；仅证明命令已发出，不是 UIKit 落点确认 |
| `error` | `error` 为 `history`（historyError）、`load`（loader throw/未真正等待 flight）、`reveal`（ListRef/映射未准备好或命令 throw）、`invalid-target`（空 ID）；不泄漏原始错误 |
| `not-found` | 未找到且 authority 的 `more()` 已 false；失败不会伪装成此状态 |
| `hidden` | authoritative revert 范围明确隐藏目标，未调用 reveal |
| `cancelled` | 显式取消或 current/scope 已失效，未接着跳到 tail |

`loads` 是本次导航成功等待的分页动作/flight barrier 数，不是服务器总页数或下载百分比；retry 重新计数。controller 不持有消息正文、不按 ID/时间排序，不产生 cursor、不替换已加载内容。

## 主线程接线要求

1. `ProjectsSearchPage.onOpenChat(target, { messageID })` 必须把同一消息 ID 带到目标 Chat；没有 ID 时保留原来的正常打开行为，不能用 tail ID 替代。
2. 等 `chat.messagesResolved()`、页面 active、ListRef 和实际 List rows 准备好后才调用 `focus.focus(id)`。controller 实例在单个 mounted Chat 内创建一次，不逐 render 重建。
3. `current()` 至少包含当前 owner/Host 有效、Chat active、前台、messagesResolved。`scope()` 使用稳定 primitive，包含 Host identity + Host epoch、directory、target kind/id 和 `chat.historyGeneration()`；不能每次返回新对象。
4. `hasMessage` 查 **实际 List `each` 所用的 rows**，匹配每个 row 的 `messages[].id`，不能只匹配 row.key、head 或 tail。assistant 前插后 row.key 可能仍是已挂载 key，不等于目标消息 ID。
5. `isHidden` 是必填 authority seam：根据原始消息数组中目标和 revert boundary 的精确位置判断；不能用 ID 大小推断。boundary 未加载时不能猜 hidden，应继续分页。没有 staged revert 时返回 false。
6. `loadOlder: () => chat.loadOlder()`，不能传 `true`（这是显式导航，retry 必须能清除原有自动失败 gate）。现有 state loader 已保证 opaque cursor、已有 flight 合并、stationary/cycle 报 historyError。注入的 loader 必须真等到页/错误发布；不能 fire-and-forget 或把失败吞成“没有变化”的成功，否则无法正确判定游标进度。
7. `reveal` 是**同步**命令 adapter：当次读取最新 display rows，找到包含 messageID 的 index，确认当前 ListRef 后，仅调用一次 `scrollToIndex`，然后返回 true。Ref/目标未准备好返回 false；不能无声 no-op 后返回成功。callback 不应另起异步任务使用未来 scope 的 Ref。
8. `changed` 只桥到本地 UI signal；main 负责本地化 loading/retry/hidden/not-found 展示。不要因 `changed` 再自动调用 retry。
9. 隐藏、离开、Host/Chat/reset scope 改变以及 cleanup 必须调用 `cancel()`。它立即结束旧导航 Promise/阻止后续 reveal，不中断或回滚已有页请求；新目标仍等待那个 wire flight 再继续串行分页。单靠 current getter 无法发现“隐藏后又恢复、且请求期间没有任何回调”的中间瞬间，因此生命周期 cancel 不能省。
10. 同一 scope 同一 ID 的 `focus()` 是幂等的，包括 loading、error、revealed：反复 render 不增加请求或命令。显式 retry 用 `retry()`；取消后重新 focus 可以开始新导航。新目标替换旧目标，但仍共享单个分页 barrier。不要在新 Host 上自动重放旧的 route intent。

示意 adapter（放在 main 的 Chat owner 内，名称按现有实现接）：

```ts
const focusState = signal<NativeHistoryFocusState | null>(null);
const focus = createNativeHistoryFocus({
  current: () => current() && chat.active() && lifecycle() === 'active' && chat.messagesResolved(),
  scope: () => JSON.stringify([
    app.connection()?.id, epoch(), props.target.directory,
    props.target.kind, props.target.id, chat.historyGeneration(),
  ]),
  hasMessage: id => bodyRows().some(row => row.messages.some(message => message.id === id)),
  isHidden: id => {
    const boundary = chat.revert()?.messageID;
    if (!boundary) return false;
    const messages = chat.messages();
    const cut = messages.findIndex(message => message.id === boundary);
    const target = messages.findIndex(message => message.id === id);
    return cut >= 0 && target >= cut;
  },
  more: chat.more,
  olderLoading: chat.olderLoading,
  historyError: chat.historyError,
  loadOlder: () => chat.loadOlder(),
  reveal: id => {
    const list = transcriptRef();
    const index = bodyRows().findIndex(row => row.messages.some(message => message.id === id));
    if (!list || index < 0) return false;
    list.scrollToIndex({ index, animated: false, viewPosition: 0.5 });
    return true;
  },
  changed: value => focusState.set(value),
});
```

Native index 使用 **newest-first display array 的 index**，不再做 `length - index - 1`。NSH 0.4 本机 `ListRef.scrollToIndex` 类型及 Context7 `/longbridge/nsh` lists 文档已核对：0/0.5/1 表示 viewport 起点/中间/末端。只保留 List 原命令 owner，没有 offset 写入、测量补偿、rAF 循环或 scrollToEnd fallback。

## 实际验证

- 14:21:44 修复前：focused Vitest **1 failed suite**，模块尚不存在；没有把这个阶段说成行为通过。
- 14:23:13 首轮：**16 tests passed**；source 独立 tsc 通过。
- 14:24:30 最终：**1 file / 20 tests passed**，140ms；source + test 的独立 tsc 通过。
- `bun run dead-code` 已运行并检查：报告有仓库既有 unused exports/types、NSH 28 个 fixture/未接入页面项；没有 history-focus 条目，没有删除其他线程文件，不声称零告警。

```sh
bunx --package vitest@4.1.11 vitest run --config packages/nsh/vitest.config.ts packages/nsh/history-focus.test.ts --reporter=dot
bunx tsc --noEmit --target es2023 --module esnext --moduleResolution bundler --skipLibCheck packages/nsh/history-focus.ts packages/nsh/history-focus.test.ts
```

20 项覆盖：首页直接命中/同目标幂等、125 个 opaque 页后命中且最大并发1、8个 cursor-only 页面、失败保留页和目标、100次重复 focus 不重试、吞成 historyError 与 throw 两种失败、显式 retry、原有错误 gate、真正 exhausted empty/缺失、revert hidden 及分页后 hidden、取消与完成竞态、请求前取消、Host scope/退出 fence、换目标共享 barrier、等待已有 older flight、grouped row 内部 ID 对当前 index、Ref 缺失/命令异常、取消立即结束导航但保留 wire barrier、已可见目标不被无关旧页错误挡住、空 ID 不跳 tail。

## 未关闭的验收范围

- main 的 ProjectsSearch → navigation options → Chat controller 生产接线、ListRef、取消生命周期和本地化 UI 尚未由本任务修改或验证。
- 纯测试证明的是目标身份/索引及命令次数，**不证明 UIKit 已显示到目标**。必须在生产 List 确认数据 splice/提交先于 scrollToIndex 消费；ListRef 已存在不自动证明新页已被 native core 接收。若命令时 rows 尚未 ready，adapter 应明确失败而不是伪报 revealed。
- grouped row 包含多个 assistant message 时，scrollToIndex 定位的是包含目标的真实 row，不保证巨大 row 内部某段文字已落在 viewport 中；该细粒度可见性/必要的展开与高亮仍须 main 的实际 body 和 UIKit 证据收口，不允许用 offset/rAF 补偿或“跳 tail”冒充。
- ≥100 页真实 Host/Relay、设备中断、隐藏/返回、连续换目标、revert 窗口及超高 row 的设备验证未执行，均保留在完整范围。
