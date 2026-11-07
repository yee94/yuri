# Native history / scroll 核心交付

日期：2026-11-07。此页只记录本子任务证据；**没有完成 UIKit 不跳动验收，也没有运行 App.tsx headless、浏览器、模拟器、真实 Host、凭据或模型服务**。未修改 application.tsx、ios/main.swift、chat-header.tsx、model.ts 或根 PARITY/CHAT/DOCUMENTATION。工作树存在其他并发任务。

## 源码证据与 ownership

- Web 协议：`packages/ui/src/sync/session-projection-api.ts`；会话 `limit=20`，初次 `order=desc`，后续 opaque `cursor`，cursor 请求不附加 order。短 **raw** 页才 exhausted；过滤后的 system-only 空页不等于历史已空。
- Web 保序：`packages/ui/src/sync/transcript-order.ts`，incoming 顺序权威，ID 只标识，不作时间排序。本轮 history helper 复用此纯函数。
- Web 手势：chat `DOCUMENTATION.md` 的 Mobile history gesture budget / iOS history read-position restoration；每个向旧端手势最多一页，不由布局/请求完成重新授权。
- 本机 NSH 0.4 `.nsh/types/nsh/index.d.ts` / `types.d.ts` 与 Context7 `/longbridge/nsh` 的 lists / scrolling-and-lists 文档：`inverted` + newest-first 展示数组，`onLoadMore` 是旧端（物理顶部）；`onLoadMoreAtStart` 是最新端（物理底部）。**必须安装 start listener** 才启用离底后的 keyed-visible-row preservation。没有这个 listener，inverted 的旧兼容行为仅保底距。
- 当前生产的旧页还只是 List 外按钮，start listener 只有 messages 刷新；主线程必须完成下述接线。
- 本子会话未暴露 task/spawn 工具；已检索工具目录，无法实际派出要求的 explore 孙代理。没有用付费 CLI/model 冒充派遣。

## 已实现的核心合同

### state.ts

1. `loadOlder(automatic = false)` / 兼容的 `load(true)`：旧页请求等待正在进行的刷新；同时到来的多个 older 共享一个等待/请求，不丢失，也不重复拉下一页。反方向的刷新继续由原有 pending domains 合并。
2. `olderLoading` 包含等待刷新期间，供 UI/手势守卫使用。旧页只读 messages，不顺带刷新 status/inbox/permission/form。
3. `historyError` 独立保留旧页失败；失败不改消息、cursor、more。普通成功 poll 不清除此错误。`loadOlder(true)` 遇错误不再自动请求；用户显式 `loadOlder()` 或 `load(true)` 清错、使用同一 cursor 重试。旧页错误不写全局 error，避免突然增加全局错误条改变 transcript viewport。
4. stationary / 循环 cursor 明确失败；完整 system-only 页每次操作只推进一页，不自行循环补页。
5. 无变化的 GET 保留 message 与数组引用；旧页重叠不回写已收到的 live 内容。新 live 仍使用原来的 32ms batch，未变化的历史不换对象。
6. 第一次 GET 前已有 live row，或空会话之后出现满页时，仍初始化真正的 oldest cursor，不因 `messages.length` 被 live 改变而漏掉分页。
7. tail 不相交时最多额外读五页。仍未连回旧窗口则仅暂存候选，`hasGap=true`，**不发布缺页窗口**；后续显式刷新/正常安全 poll 接续候选 cursor。候选必须与新 tail 相交才能复用；否则重启有限扫描，不能跳过中间新增记录。gap 期间新 live row 保留在原 streaming overlay，补齐前不追加到旧窗口；已显示行仍能更新。桥接锚点只来自已成功 GET 覆盖的 ID，不把 GET 进行中刚发布的 live row 当已补齐旧缺口的证明。
8. 已加载 oldest cursor 与 latest catchup cursor 独立。Host generation、activation、history revision、contact generation/revision 与原有 streaming fence 继续生效；commit/repair 清除候选。候选只存当前 Chat 一个范围，旧 Chat 关闭后不跨 Host 复用。

### history-messages.ts / history-rows.ts / history-scroll.ts

- `stableHistoryMessages`：内容相同保对象，顺序/对象都未变保数组；successful complete empty 仍能真正清除。
- `mergeHistoryMessages`：重叠权威顺序复用 Web shared rule，disjoint 明确 prepend/append；older overlap 保留当前内容。
- `createNativeHistoryRows()`：每个 mounted Chat 一个实例；只在展示端 newest-first。旧 assistant siblings 加入原 run 时继承已经挂载的 key，但 head/tail 仍是实际消息。split 时 key 跟随它所代表的真实消息，避免重复。未变化的行与整个投影保引用；缓存只持有上一个 displayed snapshot，不累积历史版本。
- `createNativeHistoryScroll(source)`：只管理分页意图、没有 scrollTo/offset writer/timer。drag start 建立单页预算，向旧端进入半屏阈值时同步消耗；布局/惯性/反复 onLoadMore 不补发。手势开始时正在加载则不排队；失败后必须手动重试。`reset()` 清理隐藏/失活预算。

性能合同：输入路径不新增枚举/请求；历史 merge/projection 线性于当前已加载窗口与 incoming 页，不按 ID/时间重排。5000-row fixture 验证同 source 不重投影，以及 append 时未变历史行引用稳定；**没有设备帧时/P95 或 UIKit 大历史内存结论**。

## 主线程生产接线（尚须完成）

```tsx
const projectHistoryRows = createNativeHistoryRows();
const bodyRows = () => projectHistoryRows(chat.visibleMessages());
const historyScroll = createNativeHistoryScroll({
  current: () => current() && chat.active() && lifecycle() === 'active',
  loading: () => chat.loading() || chat.olderLoading(),
  more: chat.more,
  error: chat.historyError,
  loadOlder: chat.loadOlder,
  loadLatest: () => chat.load(false, ['messages']),
});

// 保留 inverted / stable keyExtractor；不再 slice().reverse() 第二次反序。
<List inverted each={bodyRows()} keyExtractor={row => row.key}
  onScrollDragStart={historyScroll.onScrollDragStart}
  onScroll={historyScroll.onScroll}
  onScrollEnd={historyScroll.onScrollEnd}
  onLoadMore={historyScroll.onLoadMore}
  loadMoreThreshold={0.5}
  onLoadMoreAtStart={historyScroll.onLoadMoreAtStart} />
```

- hidden/background/cleanup 时调用 `historyScroll.reset()`，避免恢复后继承未消费的旧手势。不要同时另装一套 auto-follow、maintainVisibleContentPosition 或 rAF 补偿。
- 保留 `onLoadMoreAtStart`，即使不需要网络刷新也不能删除这个 listener；它是 NSH 核心 reading-away 行为的 opt-in。
- 手动 retry 必须使用 `chat.loadOlder()`（无 true），并读 `historyError` / `olderLoading`。不因自动错误永久隐藏 more。主线程负责本地化错误/重试展示；状态控件不能无意改变 transcript 可视高度，需用滚动内 slot 或不挤压 viewport 的承载并实测。
- `hasGap` 必须有明确“同步未补齐/继续同步”状态及 `chat.load(false, ['messages'])` 入口；不要把已经显示旧窗口说成最新完整窗口。安全 poll 会继续补，但 busy 的 live poll 原本不读 messages；此时手动入口尤其必要。
- 其他 transcript 子任务正在给 `nativeBodyRows(messages, previous)` 增加保 key 能力；整合时二选一明确唯一投影 owner，不能在每次 render 新建 projectHistoryRows，不能双重 reverse。若改用对方实现，仍需满足本页 keys/引用回归。

## 实际测试输出摘要

均使用 `packages/nsh/vitest.config.ts`，没有使用 bun test/node --test。

| 时间 | 命令范围 | 实际输出 |
| --- | --- | --- |
| 13:28:51 | 新增 history-state，修复前 | **6 failed / 3 passed**；older 在 refresh flight 中被吞、no-op 引用变更、缺 loadOlder/error gate、错误合并 disjoint tail 等红灯 |
| 13:30:18 | 再增 staged gap + live / staged tail 失去重叠回归 | **2 failed / 9 passed**；明确漏中间消息；修复 anchors / 候选相交守卫后转绿 |
| 13:31:39 | rows/scroll 新测试，模块加入前 | **2 failed suites / 11 passed**（模块不存在）；非 UIKit 行为证据 |
| 13:33:04 | 第一次 GET 前已有 live、older 覆盖已发布 live | **2 failed / 11 passed**；修复 messagesLoaded / older overlap 后转绿 |
| 13:34:49 | 8 files 关联测试 | **1 failed / 107 passed**；唯一失败来自并发 transcript-body-model 新测试要求第二参数保 key，而当时对方实现未完成；未修改其文件 |
| 13:36:50 | history-state/scroll/rows/messages + state + transcript-actions-state + model | **7 files / 97 tests passed**，986ms；随后另补 empty→full-tail 回归，最终结果见交付回复 |
| 13:39:31 | GET 进行中刚发布 live row 的桥接 authority 回归 | **1 failed / 15 passed**；增加已覆盖 authority ID 集合后修复 |
| 13:40:03 | 上述7 files + transcript-body-model | **8 files / 112 tests passed**，1.64s；也确认另一线程的 row-key 回归已经转绿 |

命令：

```sh
bunx --package vitest@4.1.11 vitest run --config packages/nsh/vitest.config.ts packages/nsh/history-state.test.ts packages/nsh/history-scroll.test.ts packages/nsh/history-rows.test.ts packages/nsh/history-messages.test.ts packages/nsh/state.test.ts packages/nsh/transcript-actions-state.test.ts packages/nsh/model.test.ts
bunx tsc --noEmit --project packages/nsh/tsconfig.json
bunx tsc --noEmit --project packages/nsh/tests/history-types.tsconfig.json
bun run dead-code
```

`tsc` 在 13:36:50 前两次包级通过；13:40:03 最新包级检查因并发 header 的 `chat-header-popup.tsx:41` nullable description，以及 UI desktop/i18n/runtime-url 的 Window/JSX/DOM 类型边界报错。没有修改对方文件，也不把早先结果称为当前全包通过。随后使用 `tests/history-types.tsconfig.json`（继承相同 NSH compilerOptions，只限定本轮 history + state 根源文件）专项检查通过。一次不带项目配置的临时窄检查因缺少 `@/*` alias 失败，不作最终证据。

dead-code 已执行，报告仍有仓库未用 exports/types 与 NSH 21 个字符串启动 fixture；没有删除不认识的文件，没有声称零告警。

## 尚未关闭：UIKit / 集成 / 真机

1. 新 history rows/scroll 生产接线、错误与 hasGap 的本地化 UI、原生产 wiring assertions 更新；本子任务不编辑 application.tsx。
2. UIKit 同帧阅读锚点、held finger、惯性、快速反向滚动、短历史跨虚拟化、长文字/图片/工具/Activity 迟到增长、键盘和旋转；倒序开关、纯函数及协议测试不能证明这些通过。
3. 最新端跟随新行/流式高度增长，离底阅读不跳最新端，返回最新端恢复 follow；JS 不加第二 writer，但 NSH core 的实际 iOS 行为仍必须测。
4. contact generation reset / concurrent history mutation 在真实 Host 的回放、断网恢复 >120 新消息、忙碌时 gap 手动追赶；本轮只有合成 session authority，未触真实会话。
5. 持久化阅读位置/跨冷启动恢复、真实生产 Host/公网 Relay/真机、设备内存与输入/绘制延迟不在本轮已验证集合；不是可删减范围。
6. 包级 tsc 的并发 header/UI 边界问题仍需主线程收口。全 raw system-only 窗口与 contact reset 的生产接线还需真实回放：当前 model 只提供过滤后的 messages 与 opaque cursor，没有 raw coverage ID 集合；本轮未越权修改 model.ts。

### 主线程模拟器复测建议（本轮未执行）

- 用隔离 fixture Host 准备 ≥200 行、每页20、固定可见 marker；禁止用真实付费发送来造历史。提供延迟、500、stationary cursor、完整20条 system-only、异步图片/工具展开、持续新增消息开关。
- 录制60fps，同时采集 marker 行屏幕 y、key、native offset、手指/惯性状态和每个 cursor 请求。启动最新端应零 older 请求；每次向旧端 drag 最多一次 cursor 请求；请求失败100次 edge/layout回调仍零自动重试，显式 retry 仍为失败 cursor。
- 阅读中触发前插/流式新增/图片尺寸/Activity 收放，手指按住与松开各测；每种至少3轮。marker 同帧额外位移目标≤1.1pt，任何≥100pt单帧闪跳失败；保留原始视频和逐帧，不只截图结束帧。
- 后台造 >120 行，恢复时确认 hasGap 可见、旧窗口不被不连续新页替换；继续补齐后核对全部ID无重漏，oldest cursor 不改变。再回最新端验证恢复跟随。
- 关联生产 headless / iOS build 只能由主线程串行执行，避免多个 App.tsx entry 同时生成覆盖 `.nsh/test`。本子任务未启动这些命令。
