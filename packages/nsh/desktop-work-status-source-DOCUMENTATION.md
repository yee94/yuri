# WorkStatus 原 Chat 只读 source

## 接线端口

主 Chat 数据只从原 `createChat()` 获取：

```ts
chat.workStatus(): DesktopWorkStatusChat
```

这是 NSH signal 支持的稳定快照 getter；读取没有扫描、投影或请求。`tasks` 与同一时刻 `chat.tasks()` 引用相同。组件侧的 `messages` 适配建议由此端口取代。

`desktop-work-status-source.ts` 导出：

```ts
readDesktopWorkStatusChildren(
  operation: PageOperation,
  scope: DesktopWorkStatusScope,
): Promise<readonly DesktopWorkStatusChild[]>

observeDesktopWorkStatusChildren(
  operation: PageOperation,
  scope: DesktopWorkStatusScope,
  children: readonly DesktopWorkStatusChild[],
  changed: (children: readonly DesktopWorkStatusChild[]) => void,
): () => void
```

可见需求下显式读取完整 child 集合，再为该集合订阅 activity。订阅同步交付一次当前快照，关闭 GET→订阅间隙；之后只在该集合的 activity 变化时回调，无变化保留数组及行引用。回调保留 id、parent、directory、title 和顺序，不维护集合成员或刷新标题。只订阅已确认集合内的 exact IDs，不发现其它 children。

调用方在关闭、替换集合、operation 退休或 owner cleanup 时执行返回的幂等 stop；新 operation 重新读取/订阅。旧 operation、Host/lease 或目录不能接收新 owner 的状态。Host 退休/后台会交付一次 unknown 并移除失效订阅。临时关闭不额外创建 Chat、stream、active GET、轮询或全局 catalog。

`state.ts` 拥有上述端口与原 root `sidebarLive`；public barrel 只做导出。原 state 只导入纯 projection leaf 与 child reader leaf，避免 barrel→state→barrel 的运行时循环。

## 数据 authority 与提交边界

| 字段 | 来源与边界 |
| --- | --- |
| `tasks` | 原 `updateTasks()` 写入 seam；复用已有任务投影 |
| `taskFaces` | 同一 seam 在 tool、history、materialization、revert/结构提交时投影；使用既有 Web helper prebundle |
| `activity` | 原 active GET 成功确认，或已接受且匹配原生 `expectedHost` 的 live busy/retry/idle；未确认是 unknown |
| `liveTaskPartIDs` | 原 content reducer 接受的 exact task tool part；成功/失败/idle/reset 清除，不从历史 pending/running 推断 |
| child `activity` | 原 root global event writer 的同一 `sidebarLive` cache；额外 receipt 必须匹配当前原生 Host/lease |
| `backgroundShell` | 当前没有已确认 live aggregate，固定 unavailable，不合成零 |

task part ID 与 `nativeMessageEntry` 相同：显式 ID 优先，否则 type/ordinal/index；无 raw content 的旧记录计入前置 text/reasoning 的 index。source 仅适配 task/subtask，不导入 body renderer，也不保留第二份历史。

child 订阅按 directory+sessionID 索引回调。无关 child 的状态与任意 text/draft 不扫描父历史、不调用 task helper、不通知父 `chat.workStatus()`。重复同态事件不通知。没有原生 `expectedHost` 的状态事件只能将 proof 留为/降为 unknown；显式旧 lease 被拒绝。global disconnect/reconnect 清除旧 proof，后续需真实 scoped live 事件重新确认。

暂停保留 tasks/faces 展示引用，撤销 activity/live IDs；恢复由原 lane 的新确认接续。Host 退休清空旧 source，晚到 history/status GET 不通知替代 Chat。原 Chat 的 stream、GET、安全轮询与发送 owner 不变。

## Child GET 完整性

仅使用 captured `PageOperation` 的 GET。首请求同时携带 `location[directory]` 上下文、真实 `directory` filter、`parentID`；opaque cursor 续页保留原查询合同。每行核对 parentID 和目录，session row 的 `execution` 不构成 live activity。

接受正式 `{data,cursor}` 页面，完整终页可以返回空数组。请求失败、partial、畸形 DTO、范围错、重复行、循环 cursor 或失效 operation 均抛错，不能替换成空集合。最多 5 页、每页 200、共 1000 行；未抵达终页则抛错，不交付截断集合。订阅本身零网络请求。

## Git / project owner

- Header 唯一读取位于 `chat-header-metadata.ts` 的 light Git status；main 通过该 metadata 的 branch、`changedFiles?`、`gitStale?` 接入。缺失文件统计保持 null，不再读 Git。
- 已有 `desktop-git-model.ts:createDesktopGit()` 持有 Git resources 与 `worktreeState()`；`desktop-git-worktree-state.ts` 的 `desktopGitWorktreeState()` / `resolveDesktopGitWorktree()` 区分 attachment、pending、unavailable。它们不是 source 新建 loader 的理由。
- project 只消费已确认 exact catalog path。session attachment 跨启动 authority 尚未确认时保持 unknown，不从 parent path、当前 branch 或目录包含关系猜测。

## 验证边界

- `desktop-work-status-source-state.test.ts`：真实原 `createChat` 接线、精确 live IDs、GET/live revision、旧 lease、Host 退休、暂停恢复；订阅覆盖 GET→observe 间隙、working→idle、无 scope、重复/无关事件、其它目录、断开/重连与 stop。50 draft/text/root child 事件不新增 task 扫描、helper 投影、父通知或请求。
- `desktop-work-status-source-projection.test.ts`：与真实 `nativeMessageEntry` 的 faces/ID 一致性，包括旧无 content 与空 content；no-op 引用稳定。
- `desktop-work-status-source-children.test.ts`：strict DTO、分页、partial、失败、迟到、上限和 unknown/成功空集合区分。
- `desktop-work-status-source-native.test.ts`：真实 NSH Mac/Windows reactive graph 各 3 场景；原 Chat 输入/text、delayed status/owner 退休、原 root live events 驱动 child group working→idle。strict synthetic Host 仅允许声明的 GET/stream，没有真实 Host 写入或模型调用。

上述 native fixture 不是 `YuriNativeApp` actual-root、AppKit/Win32 窗口或视觉验收；这些由主装配 slice 独立验证。

`state.test.ts` 的 root attention 计数覆盖完整原 `observeRuntime` seam：具名 native fixture 携带实际 Location/expectedHost，首次只构建原 attention 身份索引（1000 行一次），sidebar 直接使用权威 directory。50 token/draft 与重复同态 status 不新增扫描、请求或通知。没有 Location 的兼容事件仍需独立目录 fallback：首次额外构建一次，重复事件复用；catalog 引用变化才重建，不能靠放宽原生 scope gate 提供 WorkStatus live proof。`desktop-work-status-source-state.test.ts` 另核对 v2 active GET 的 running membership map、成功空集合、无关 membership 与畸形旧 DTO。

`bun run dead-code` 在加载 Web Vite 配置时因缺少 `vite-plugin-pwa` 中止，未安装依赖绕过。
