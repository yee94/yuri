# Session retention — main 装配合同与验收

## 交付边界

- `settings-retention.tsx` 导出 `SettingsSessionRetentionSection` 和根级 `createNativeRetentionOwner`；没有复制 Basic Sessions，也没有修改 `application.tsx`、`settings.tsx`、`settings-basics.tsx`。
- `settings-retention-controller.ts` 所有偏好、完整扫描、单次确认 ticket、逐项 mutation 与持久化恢复；不依赖 NSH/React/SDK。
- `settings-retention-core.ts` 所有 wire 校验与 Native 额外活跃保护；`settings-retention-scheduler.ts` 所有单根自动执行租约。
- 正式新增的 18 个语义 key 全部位于 `packages/ui/src/lib/i18n/messages/{en,zh-CN,zh-TW,ja,ko,fr,es,pl,pt-BR,uk}.settings.ts`。组件只调用既有 `t()`，无平行词典或 locale resolver。

## 共享纯策略的必要性与证据

原 `hooks/useSessionAutoCleanup.ts` 的 `buildAutoDeleteCandidates` 是私有函数；直接导入 hook 会引入 React、全局 store、SDK transport。原 `stores/globalSessions.ts` 将纯 visibility 与 SDK loader 放在同一模块。为满足实际复用，提取无 imports 的 `packages/ui/src/lib/session-retention-policy.ts`：

1. Web hook 和 Native 均直接调用同一个 `buildAutoDeleteCandidates`，而非各维护一套算法。
2. Web `globalSessions.ts` 保留 `isVisibleGlobalSession`、`isSystemOwnedSession` 原出口，内部转发同一纯 owner；Native 直接导入纯 owner，不打包 loader。
3. 保留原更新时间优先、全局最近五条、当前/共享保护、严格早于 cutoff 的规则。visibility 保留标题过滤、child 排除、系统 metadata 和 contact-assigned 例外。
4. Native 额外排除全部 current/protected/live ID，并沿 parent 链保护运行中子会话的祖先。delete 还排除任何有 child 的根，以防级联删除。

天数范围不是自行裁剪：现有 Web `SessionRetentionSettings.tsx` 明确 `MIN_DAYS=1`、`MAX_DAYS=365`、默认 30；`useUIStore.setAutoDeleteAfterDays` 和 Host `settings-helpers.js` 同样 clamp 1–365。禁用由独立 `autoDeleteEnabled=false` 表示，不是 0 天。纯模块集中声明这些常量供 Native 使用，默认自动清理关闭、默认动作 archive。

## 根单 owner（main 待接）

```tsx
// 在捕获的 Host root 创建一次；不是每次打开设置时创建。
const retention = createNativeRetentionOwner({
  scope: capturedSavedConnectionID, // 稳定连接身份；不得是 endpoint、token 或临时代际
  current: () => capturedGenerationIsCurrent(),
  active: () => appIsForeground(),
  protectedIDs: () => currentAndExplicitlyProtectedSessionIDs(),
  autoRun: false,
});
```

- `scope` 隔离 Host journal；`current` 必须 fence captured Host/generation，不可只返回 true。重建同一 Host root 后仍用稳定 scope 恢复 journal。
- `active` 只跟随应用前台/连接可用性，不订阅草稿、正文 token 或完整聊天 store。不要让每个 Chat/设置页创建 root。
- `autoRun` **默认 false**；本交付 fixture 显式 false。main 仅在产品装配确认既有用户保存启用语义后为唯一 root 显式开启。此开关也不绕过 `ready`、已保存 `autoDeleteEnabled`、Host 同步、前台与 24 小时设备 cooldown。
- 相同 scope 的第二个仍有效 native owner 会拒绝创建；相同 controller 的第二个 scheduler 也拒绝。销毁解除租约、移除订阅并清除 timer。
- 自动目录读取延后至少 8000ms，关闭/后台无 timer；没有全局 interval。失败后不自动重试，需用户操作或真实前台生命周期恢复。每次只允许一个扫描/执行 flight。
- 自动执行 admission 先回读 Host 已保存偏好；其他客户端已关闭自动清理时不扫描、不执行。main 的既有 Host settings invalidation 可以调用同一 controller 的 `load()`，不创建新 owner。
- root 与 section 的并发冷加载共享同一 Promise，避免 root 已在读取时 section 提前结束而永远停在 unknown。

## Sessions 页面与搜索（main 精确待办）

在现有 Sessions Scroll 中挂载：

```tsx
<SettingsSessionRetentionSection
  controller={retention}
  active={sessionsRouteIsTop && appIsForeground()}
  target={route.target}
  onReveal={navigation.reveal}
/>
```

最小 props 即 `controller`、真实 `active`，以及可选 `target/onReveal`。section 不拥有 Scroll/NavPage/返回导航，也不创建 scheduler。

1. 保留现有 `SettingsDefaults`、`showDeletionDialog`、`smallModelUseDefault`、`smallModelOverride` 及其它 Sessions 配置。不要替换整页。
2. Basic fields 仅移除/跳过 `autoDeleteEnabled`、`autoDeleteAfterDays`、`sessionRetentionAction` 三行，由此 section 唯一呈现和保存。尤其不要留下原 action 的 `local:true` 不可用提示。
3. 延用现有 Sessions 导航入口，无需增加第二个顶级设置页。
4. 搜索 registry 在去除 Basic 的这三条重复项后合并 `retentionSearchItems`：
   - `sessions.autoDeleteEnabled`
   - `sessions.autoDeleteAfterDays`
   - `sessions.sessionRetentionAction`
   - 新增 `sessions.retention-cleanup`
5. 每个 ID 已对应 `SettingsTarget`；由现有页面 Scroll 的实际 measure/reveal 高亮，不估算 offset。候选和动态失败 session 不单独注册搜索项。

## Authority / wire

- 仅 `GET /api/session?limit=500[&cursor=<opaque>]` 无 directory/roots/search/archived filter，从 raw cursor 起点遍历至 `cursor.next` 缺失/null。500 是单页大小，不是全目录上限；过滤空页仍继续。
- 只有 v2 `{data: SessionInfo[], cursor: {...}}` 可证明 exhaustion。legacy array、bounded index、缺 cursor、partial/error、重复 cursor、重复 session 身份或 malformed 行都失败；显示 unknown，不显示假 0、不 admission 清理。
- 活动来自 `GET /api/session/active` 的 `{data: {[id]: {type:'running'}}}`（也支持现有 Native 的直接 map）。读取失败不是空闲；出现不在完整目录中的 live ID 时不猜其祖先。
- 确认前全量扫描；确认后再扫描，仅处理用户同意集合的交集；每项写前回读该 session 身份、metadata/archive/activity 与实时 active map。只接受一份 controller 内签发、单次使用的 plan。
- archive：既有 `PUT /api/yuri/sessions/:id/archive`，body 精确 `{archivedAt, directory}`，核对返回 `{session}` 的 ID、目录和正 archived。
- delete：已安装 `@opencode/client` 生成 wire 为 `DELETE /api/session/:id`，成功 204、无 body；**不附加目录或发明 bulk/idempotency route**。读取 detail 同样不追加新版 SDK 没有的 directory 参数。
- SDK gap 使用现有 Native `request`，Swift 统一认证/连接 fence；组件不解析 endpoint、不接触凭据。

## 偏好与恢复

- 与 Web 一样，三个 retention 偏好既在设备持久化，也写 Host `/api/config/settings`；Host 存在合法字段时覆盖设备值，缺省保留设备值/默认值。lastRunAt 仅设备，不发送给 Host。
- 设备 key 为 `yuri.session-retention.preferences`，Host journal 为 `yuri.session-retention.journal:<encoded saved connection ID>`。journal 仅包含所需 session ID/目录/动作/状态，不保存标题、消息或认证信息。
- save 仅发送所拥有的三个字段，不序列化整个 settings。设备写失败不发 Host；Host ACK 后 GET 失败，重试仅 GET，不重复 PUT。读取不一致明确提示，自动清理暂停；用户仍可明确二次确认手动清理。
- 每个 destructive 请求前先持久化 intent。ACK 后写入 ack/completed；刷新失败不将 completed 回退为 failed，不重放 delete。列表和逐项结果保留，未知结果只核验。
- 只有成功的完整 authority 扫描证明 delete 已不存在、或 archive 确实为正归档状态时，才从持久化 journal 退休该完成项。当前 UI 的结果仍保留；此后用户显式恢复归档的会话可在下一次独立确认中重新入选。回读失败绝不退休 tombstone。
- 明确拒绝的写入独立 failed，可单独重试（再次完整资格核验，UI 再次确认）；其他 complete 项不中断。超时/断线/不确定响应保留 uncertain，不盲目重发；GET 404 可结算 delete，正 archive 可结算 archive。
- 草稿输入和语言切换不触发全目录请求。per-item recheck 复用一次构造的候选/parent 索引，不逐项重新扫描/排序历史；10,000 行、100 次 recheck 有读取次数回归。

## 仍存在的真实 API 缺口（不能宣称完整上线验收）

1. 当前 Host `settings-helpers.js` 只接收 enabled/days，缺 `sessionRetentionAction` whitelist。Native 会实际尝试并核验，不伪装已同步；选择 delete 后 Host 丢字段会显示不同步，自动执行暂停。main/Host owner 需补既有 settings 字段与回归，不能用新协议替代。
2. 现有 archive/delete API 没有 compare-and-mutate revision 或全局事务。客户端在 mutation 前已核验 live/child/system/protection，但无法原子阻止最后一次 GET 后其他客户端开始运行、改变 metadata 或创建 child。若验收要求绝对零竞态，Host 必须在既有 mutation owner 增加等价安全 admission；当前交付不声称已解决该后端竞态。
3. 非确定失败没有服务端幂等 receipt；仍存在的 uncertain delete 只能继续核验，不提供不安全的“重新删除”。completed journal 在权威回读成功前保留防重放，不能按时间强行丢弃。
4. Windows legacy array、缺 cursor/能力的旧 Host 明确 unknown。未伪造完整目录、不改用 session-index 替代。

## 允许的验证与 fixture

`settings-retention-fixture.tsx` 挂载真实生产 section；`tests/settings-retention-host.js` 严格纯内存，有 505 条近期会话、跨页候选及 protected/system/child。拒绝未列出的 capability、URL、query、method 和 body，绝不转发真实网络。Storage 也由该 synthetic Host 的 Map 提供。

- 纯测试：`settings-retention-{core,host,scheduler,i18n}.test.ts`。
- Native 独立 TS：设置批准的 `OPENCODE_TMP_DIR` 后运行 `node packages/nsh/tests/settings-retention-check.mjs`。
- 静态独立 bundle：另设已安装的 `NSH_BIN`，运行同脚本 `--bundle`。只 build synthetic entry，输出全在临时目录并清理；检查无 React/SDK/Capacitor 树。
- `settings-retention-engine.test.ts` 仅准备，默认 skip。**本任务禁止启用** `NSH_RETENTION_ENGINE=1`；后续需另获 engine 授权。
- 未运行 NSH engine、UIKit、main build、设备、真实 Host 写入/删除、付费调用或 Git。

静态 bundle 及 TS 不证明 UIKit 的布局、语言切换视觉、真实直连/Relay、Host 全量部署兼容或无竞态删除。以上 gap 仍属于完整验收项，不是移出范围的 MVP 删减。

### 本次实际证据

- Native 纯测试 39 项通过（包括正式十语字典各自的 keys/placeholder 校验）。
- Web `useSessionAutoCleanup.test.ts` + `globalSessions.test.ts` 共 14 项通过，验证纯策略提取后的现有消费者。
- Native 完整 `tsc --noEmit --project packages/nsh/tsconfig.json`、独立 retention TS、UI `type-check` 通过。
- 独立 synthetic static bundle 通过；39 个 source 的边界检查无 React/SDK/Capacitor 运行树。未运行该 bundle。
- Settings design audit 通过。
- `bun run dead-code` 已运行并检查。报告将尚待 main 接线的 section/search 与 synthetic fixture 标为未使用；这些是预期交付入口，不删除。现有其它工作区报告不作越界清理。
