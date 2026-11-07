# Projects：延迟删除与实时未读

## 实现边界

- `projects.tsx` 仍拥有既有项目菜单、会话菜单、归档 Undo、工作树动作与顺序。没有新增后端或改变其协议。
- `projects-delete.ts` 是纯延迟删除 journal：先成功读取所有子树 opaque 页面；确认后的 10 秒内只隐藏本地记录，零 DELETE。Undo 不回写服务端，不覆盖这段期间收到的新标题/顺序/置顶状态。记录保留在 journal，即使 bounded index 淘汰了原行也可恢复。
- journal 在页面卸载后仍按 captured Host/epoch 存活；新页面重新订阅同一 journal。切换 Host 后停止旧操作，绝不借新 Host 凭据继续。它是进程内撤销，不声称 App 被杀后仍会提交。
- 到期对子节点优先 DELETE，并验证 `true`，404 视为已不存在。一个失败子节点阻止其所有祖先的级联删除；其它完整分支独立提交。失败记录重新可见且提供显式重试，已成功删除的记录不会重放；没有自动重试破坏性请求。
- `sessionFrom` 保留真实 `time.created` 和共享 `sessionChangeSummary` 的变更计数。Pinned 的默认顺序按创建时间，未置顶 running/unread 的进行中集合按 title-refresh activity 排序，不按 ID 或历史消息猜 live。
- 所有显示文字复用现有十语 key，没有新增或修改字典 key。未读圆点复用已支持的 `ring` 色；UIKit 中与 Web 蓝点精确视觉一致性仍未验收。

## 唯一根 source 与 main 的 viewed 接线

`state.observeRuntime(onChange)` 现拥有唯一持续 attention ingest。保留原 catalog dirty-domains、120ms coalescing、前台与 epoch fence，不新增 socket、poll 或请求。只在前台、非 switching 的 global started/status/终态事件通过 cheap gate 后才读取 `app.sessions`；`createProjectsAttentionSource` 按 scope 与数组引用缓存 ID Map，未知身份、child、chat-channel 事件不产生未读。token/draft 不读取或遍历目录、索引、历史。Projects 自身 runtime listener 不再 ingest 未读，只消费 snapshot/清已读；无 event.id 的 failed/error/idle 别名也按已观察执行周期只计一次，直到 started/busy/retry 的新周期边界。

application 由 main 独占，精确合同：

1. scope key 为 `JSON.stringify([epoch(), app.connection()?.id])`。
2. App 根先且仅挂一次既有 `observeRuntime(onChange)`，其 connection effect 激活当前 scope；随后实际前台、顶层 session Chat 调用 `projectsAttention.setViewedSession(scope, sessionID)`。覆盖、返回、后台或失效时传 `null`。不要用持久化选中项冒充 viewed。
3. main 不再添加第二条 ingest；`observeRuntime` 签名、Projects props 均未新增参数。独立 `projects-native.fixture.tsx` 和 `projects-parity.fixture.tsx` 也挂同一根 observer；后者通过真实 fake-Host `player.hostEvent` 投递，不直接调用 ingest。
4. active-generation 明确由根 observer 激活/退休；Host/epoch 变化及根销毁时退休旧 scope 并清空其身份索引。`projectsAttention.retire(scope)` 可由 main 的 **Host 代际退休** cleanup 幂等调用，不要在普通 foreground/viewed 变化时调用（那些只 setViewedSession(null)）。退休立即拒绝旧 ingest/setViewed 写入并清空旧 snapshot，最后一个 listener 解除后删除 scope；读未知 snapshot 不分配 scope。当前代际即使所有 Projects 页面暂时卸载也保留未读，不使用 LRU。

本 scope 未修改 application/createChat。main 的真实 viewed effect 与 UIKit 生命周期仍需 main 统一验收；纯源测试不能代替这些运行结果。

## 验证

允许的纯验证（不启动 NSH）：

```sh
bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/projects.test.ts packages/nsh/projects-attention.test.ts packages/nsh/state.test.ts packages/nsh/projects-parity-host.test.ts packages/nsh/projects-parity-engine.test.ts
```

生产 Projects 组件 engine cases 已准备，默认 skip，仅由 main 统一调度：

```sh
NSH_PROJECTS_PARITY_ENGINE=1 bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/projects-parity-engine.test.ts
```

`projects-parity-runner.mjs` 先 bundle 纯内存 Host，再为每例创建唯一临时 app/config/Storage namespace；只有临时 config 允许 `projects.fixture.audit` 与无参 `projects.fixture.complete`，后者经 documented `createHost(player).hostEvent` 只投递固定 fixture completion，实际到达相同的根 observer，不是生产能力。生产 `nsh.json` 字节不变。audit 由 fake Host 的实际请求处理器计数，不依赖 engine 的 `host.calls` 记录；拒绝真实网络、Git、进程、文件或不在白名单内的请求。

当前执行证据：113 项纯测试通过，3 项 engine case 默认跳过。新增根 observer 1000-session + 50 token/50 draft events：0 identity lookup、0 index scan、0 request；首个相关事件建一次索引，后续 50 个失败事件仍只保留一次未读且不重扫。实际 200 次 setDraftText 在根 observer 挂载下仍零目录读取和网络增量。另覆盖 scope retirement/最后 listener 回收/200 代无增长/未知身份与 child/无 ID 错误别名去重/foreground/catalog coalescing fence；删除与 Host fixture 原有验收仍保留。

`bun run dead-code` 已执行并检查报告：动态引用的 `projects-parity.fixture.tsx` 被列为 unused（与现有 NSH fixtures 相同，runner 通过生成临时 entry 加载），未删除；报告还有全仓已有的其它候选，未越界处理。`bunx tsc --project packages/nsh/tsconfig.json --noEmit` 未整体通过，诊断均位于共享 UI 的 desktop/i18n/client/persistence/upload 文件，没有本次 Projects 文件诊断；不将其表述为 package type-check 通过。

本 agent 未运行 NSH engine、UIKit、真实 Host、Direct/Relay、真实 DELETE。main 反馈首轮三个 engine 中未读通过；两项删除停在 fixture 返回错误 label（`Delete`，真实菜单和二次确认均为 `Delete session`），未进入业务删除路径。现只修正测试回调并保留/强化二次确认、10 秒零 DELETE、部分失败断言，待 main 串行重跑，不据此改生产删除实现。
