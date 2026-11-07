# 完整 Context overview：source 接线与验证

## 交付与边界

- `context-usage.tsx` 是完整 `NativeContextUsagePage`，不是 header metadata/quota popup。按真实 `ContextSidebarTab.tsx` 保留会话/模型信息、上下文用量、消息/费用/Session TPS、最后有效 assistant 的 token/cache/TPS、组成条、反序 raw messages 六区块。
- `context-usage-core.ts` 复用 Web 的 turn、token sum、cache 和 TPS helpers。`context-usage.test.ts` 在 VM 中执行真实 Web component 的 `useMemo`，逐字段比较完整数值 view model；另以 `known()` 区分未知值与真实零。组成仍是 Web 的字符/4 估算，不伪称实测 token 分布。
- `context-usage-source.ts` 提供实际 `createChat` 数据到 production component 的 adapter。没有创建平行历史请求、raw map、SSE 或 polling。`model.ts` 仅新增 context 所有的 retained-source 字段；原有 slim fields/API 不变。
- 生产 `ContextUsageRoute` 与 `createChat.observeMessageCommits` 已实现并由纯 production fixture 串联。`state.ts` 仅修改 createChat 内部；未修改 observeRuntime/root attention、`application.tsx`、`chat-header*` 或 Settings。main 仅需导航装配，不能把静态/fixture 绿等同于 UIKit 验收。

## main：十行装配

把 `ContextRoute` 追加到现有 `Route` union。第 7 行**替换** Chat 内现有的 nav→`chat.active` effect，不保留两个 writer；其余 composer/Goal/audio 的 `chat.active` 使用原封不动。第 8–10 行是 NavStack 的 context-usage 分支，不外套 NavPage：

```tsx
import { batch } from 'nsh';
import { ContextUsageRoute } from './context-usage-route';
import { isCurrentHostScope } from './state';
type ContextChat = ReturnType<typeof createChat>;
type ContextRoute = { kind: 'context-usage'; chat: ContextChat; target: ChatTarget; scope: ContextChat['messageScope'] };
const openContextUsage = (chat: ContextChat, target: ChatTarget) => nav.push({ kind: 'context-usage', chat, target, scope: chat.messageScope });
effect(() => { const top = nav.routes().at(-1); batch(() => { chat.syncActive.set(top?.kind === 'context-usage' && top.chat === chat); chat.active.set(top?.kind === 'chat' && top.target === props.target); }); });
<ContextUsageRoute chat={route.chat} target={route.target} scope={route.scope}
  active={nav.routes().at(-1) === route} current={() => isCurrentHostScope(route.scope.generation, route.scope.hostID)}
  appearance={nativeAppearance.current()} />
```

- open 回调必须持有打开搜索前真实 session Chat 实例与原 ChatTarget；先 pop 当前 search，再调用它。不能从 session index/recent/首项目猜 source，也不能重建或替换父 Chat。assistant contact 不是 session overview 数据源。
- `chat.messageScope` 是 createChat 自己捕获的 Host/generation/session/directory，只读且与 route target 二次校验；不是 main 临时补字段。
- **`chat.active` 继续代表 display/interaction；不要在 overview 时把它设为 true。** 仅 `syncActive` 保活现有同步。稳定合并 demand 使上述 batch 进入/退出 overview 不重开原 SSE/4s safety poll，也不启动第二份 transport。
- 原 composer、模型 picker、Goal row/observer、语音/自动朗读等仍收到 false，不需要散布替换几十个消费点。核心 send/command/stop/inbox mutation/Goal 也拒绝非 display 操作。保留已有未完成发送的 receipt/reconcile，不把打开 overview 当作重复发送或 rollback 授权。
- route 自带唯一系统 NavPage、标题和返回/手势；不合成点击 header ring，不增加 Web 没有的 header 按钮。

## 生产 route 与 observer 合同

- `context-usage-route.tsx` 装配实际 route owner。`context-usage-route-core.ts` 的 Chat/commit types 从真实 createChat API 导出，不复制一个假 Chat 接口。
- route 前台时先订阅 commit，再读当前 session metadata 和当前目录 catalog；其 `read` 只接受路径、默认走 native GET。已有 Chat 仍拥有唯一消息 authority，无平行消息读取/SSE/polling。
- 每次恢复只做一次 loaded-window snapshot；若已有 metadata，恢复本身不重读 metadata。之后实际 Chat GET 的正常 commit 仍可更新该 snapshot。后台/覆盖页 unsubscribe，退役 metadata 结果丢弃；关闭自动 dispose adapter、projection owner 和订阅。main 不另写 cleanup 或 source effect。
- Retry 只读：重读 session/catalog；仅在 `messageReadError` 非空时委托原 `chat.load(false, ['messages'])` GET lane，不复制消息 URL、不重试写动作，也不重复 pending initial hydration。旧的 load-older UI 错误不覆盖一次已成功更新的 loaded-window authority。
- 初始未 resolved/读取失败保持 unknown；真实成功空才显示 0。有效已加载 prior 可以在打开后继续显示，并附带最近 message read 的错误；metadata 刷新失败保 prior。Host fence 失效时不再展示旧 scope 内容。
- 统计 owner 同步处理每个 snapshot/patch；Native page 通过 `projection` 只读 owner/revision，不创建第二个 owner。这样同个 signal batch 的多次 commit 不会丢失前一个 patch。
- `appearanceFromSettings` 从真实解析出的当前 Host 主题（含自定义/固定模式）提供 JS-only `contextUsageTokens`，使用真正的 `primary.base/status.warning`；保留 NSH 中性按钮 primary，不猜默认主题，不扩张 Swift override 白名单。root authority 未知时不虚构图表颜色。语言使用 `nsh.locale()` +正式 `language`，时间/TPS 偏好复用传入根 appearance。

`observeMessageCommits(listener)` 不触发请求、不立即合成通知，返回幂等 unsubscribe。通知是同步 writer commit，不是新事件源：

```ts
type ContextMessageCommit =
  | { kind: 'snapshot'; error?: string }
  | { kind: 'patch'; messages: readonly Message[] };
```

- GET/prepend、revert/reset/clear、exact materialization 发 snapshot；成功通知晚于 rows/resolved/read-error 的原子更新。失败发带 error 的 snapshot tip，原消息引用和数值不清空。无变化的 session metadata/status read 不触发历史重建。
- `publishStream` 在现有 replacement traversal 内收集实际采用的 touched records，一批只通知一次；没有第二次历史 diff/scan。`hasGap` 未采用的新 row 不通知；重复 flush 的未变化 rows 不重复通知。
- 零监听不分配 patch array，走原 replacement callback，不增加 per-row observer 判断；draft 不在输入中。监听回调抛错隔离，不阻断原 writer/其余 listener。隐藏/后台不通知；Host 退役/cleanup 清空所有监听。
- `messages` 保留原 signal、set/update 与有界 no-op 引用语义，未 monkey-patch setter。不能再在 main 用 `effect(() => snapshot(chat.messages()))` 绕回 token 频率全历史扫描。
- `context-usage-route.test.ts` 用 dependency-tracked signals + strict fixture GET 执行真实 createChat、实际 writer、实际 route core；不是手写 commit/source 代替生产链。

## 数据真实性

- overview 与真实 Web 一样，统计 **当前已加载消息窗口**，不擅自拉完整数据库/全部 history。
- native records 使用共享 `context-usage-projection.ts` normalizer；原 Web `session-projection-api.ts` 保留 transport/page/reconcile 并 re-export 原 API。legacy `{info,parts}` 与 flat `role+parts` 保留原字段，并校验 message/session/part 身份。
- 无 `contextRaw` 的瘦 Message 明确拒绝；不能用仅有 output/reasoning 的字段填 input/cache/cost。部分数据和 slim activity 保留实际已收到内容，用量未知显示 `—`，不隐藏入口、不捏造 0。真正空成功和真实 0 仍可显示 0。
- raw 展开/复制优先使用 retained received 对象，保留 normalizer 不认识的未来字段。正文有 stream/exact-fill 覆盖时，JSON 使用 `{received, currentContent, liveError?}` 明确区分收到的原记录与当前正文投影；不是一份伪装成完整上游 wire 的合成对象。纯 canonical fixture 才直接展示 `{info,parts}`。没有把 slim 占位 input/output 的默认值冒充收到的原字段。
- `time.created/streamed` 是 TPS authority。shared normalizer 的 `created:0` 空占位在 Native 边界移除，不以 `event.created`、completed、客户端 clock 或轮询间隔替代。session 创建时间只用于 Web 相同的会话/活动时间 fallback，不参与 TPS。
- owner 在 snapshot/结构边界建索引；单消息 patch 只计算该消息与所属 turn。raw JSON 仅展开或复制时生成；List 虚拟行的展开/复制状态归 page owner，按 ID 保存，不落在 recycled row 内。

## 已验证

- focused TypeScript 包含 route/component/source/createChat，own Bun bundle 通过，依赖图 65 sources；只有原 native `runtime.ts` 请求桥，无 application/state 运行时入口、React、浏览器 transport/i18n context、SDK 或 Capacitor runtime。
- context 纯测试：41 passed（含 14 项真实 writer/route fixture 与 3 项 production route assembly/Host palette 检查）；opt-in engine 不执行。
- Web `session-projection-api` / raw preview：53 passed，保持 normalization/page/cursor/reconcile 与旧调用 API。
- 最终含 context/observer/route/appearance/state/Goal/history/model/materialization/turn/auto-read/tasks/transcript-actions/session-switcher 的 focused Native 回归：348 passed，2 opt-in engine cases skipped。
- 5100 records + 200 patches：新增 message visits=200，所属 turn visits≤600，reset=1，未展开 JSON builds=0；source adapter 的现有 ID commit 不重读 loaded window。该 operation guard 不是设备时延测量。
- `bun run dead-code` 已执行并审阅；报告包含大量仓库既有 unused/duplicate 项。字符串装配的 context fixture entry 仍被列 unused，不据此删除；没有把非阻塞报告说成零告警。
- 本轮 NSH/UI 整包 TypeScript 均实跑通过过；最后一轮 UI 仍绿，NSH 整包被其它 owner 的 `settings-retention.tsx:82` 缺少 `settings.yuri.sessionRetention.error.admission` 翻译键阻塞。未越界改 Settings；包含 createChat/route 的聚焦 TypeScript 与 bundle 仍绿。没有追加 shim、exclude 或 skipLibCheck 掩盖错误；main 最终整包检查须在其它 owner 完成后重跑。

复现核心验证：

```sh
node packages/nsh/tests/context-usage-check.mjs
node node_modules/typescript/bin/tsc --noEmit --project packages/nsh/tsconfig.json
bun run --cwd packages/ui type-check
bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/context-usage.test.ts packages/nsh/context-usage-source.test.ts packages/nsh/context-usage-route.test.ts packages/nsh/context-usage-route-surface.test.ts packages/nsh/context-usage-engine.test.ts
bunx vitest run --project @yuriai/ui packages/ui/src/sync/session-projection-api.test.ts packages/ui/src/components/layout/__tests__/rawMessagePreview.test.ts
```

## 未验证

本轮没有运行 NSH bytecode/engine/UIKit/设备、main build、真实 Host/direct/Relay、模型或付费调用；没有 Git、安装依赖或修改全局 shim。原生 JSON Editor 的长内容选择、soft-wrap/高亮、复制反馈、系统 Back/手势、深浅色和十语长文案布局仍需后续授权验收。静态绿及 VM 数值对齐不等于这些门槛已完成。
