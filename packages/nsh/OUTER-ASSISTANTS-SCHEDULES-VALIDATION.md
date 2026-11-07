# Native Bots / 计划：实现、接线与验证

日期：2026-11-07。本轮仅修改 `assistants*.ts*`、`schedules*.ts*`、独占 fixture 和本记录。未修改 `application.tsx`、`state.ts`、`features.tsx`、`settings*`、`chat*` 或 `ios/*`；没有 git/GitHub、依赖变更、模型或真实 Host 调用。

## 证据边界

- **C**：本轮生产代码与协议接线；组件存在不等于 main 已接上入口。
- **F**：本轮实际运行的纯 Node fixture/unit。NSH UI fixture 已编写但**没有运行**。
- **H / S / D**：真实 Host / UIKit 模拟器 / 真机，本轮全部未测。
- 设备验收窗口内没有运行 `nsh test`、UI Vitest、NSH CLI、浏览器、模拟器、服务器、headless App 或 iOS build。
- 工具目录检索没有找到 spawn/delegate/session-message 工具；没有派出或冒称派出 explore 下层。
- 已读 root AGENTS、NSH README/DOCUMENTATION、实际 Web 页面及协议源码；加载 change/theme/locale/settings/sync/performance/context7 skills。Context7 查询 `/longbridge/nsh` 的 NavPage/系统 Sheet，以及 Vitest 4 的 hoisted mock/resetModules；同时核对安装版 `.nsh/types/nsh/base.d.ts`。

## 本轮实现与逐能力状态

| 能力 | C：当前实现 | F | H / S / D |
| --- | --- | --- | --- |
| Bots 列表、置顶、未读、滑动编辑/删除 | `assistants.tsx` 保留已有真实列表；修复 snapshot.enabled=false 仍画旧列表、前台恢复不立即读取、漏掉带 yuri 前缀的 contact-turn 与 stream-ready；已确认删除/置顶先应用返回值，失败刷新不复活已删除行 | contacts 排序/preview/权限、revision、批量已读、swipe 纯逻辑通过 | 全部未测 |
| 独立 Bot 设置集合 | 新增 `assistants-settings.tsx`，导出 `AssistantSettings`；行打开配置而非聊天，支持创建、能力状态、加载/错误/重试、权威空集合、Host fence、前台及返回恢复 | 纯类型检查通过；新 UI fixture 待 main 串行运行 | 全部未测；main 入口仍需接线 |
| 创建/编辑/头像/模型/项目/提示词 | 继续复用真实 `BotEditor`，不另造编辑器 | 本轮未运行编辑器 UI | 全部未测；`features.tsx` 缺口见下 |
| 详情关联计划 | `assistants-details.tsx` / `assistantScheduledTasks` 正规化 projectID→projectId，按 Web 启用优先/名称排序；未解析条目不是空成功，保留旧有效项并给重试；回到详情立即重读；主接口失败时按 Web 使用 contact schedule cards + global tasks 回退，不猜同名/同 taskID | 正规化、排序、部分失败、成功空集合、旧 Host fallback 与跨项目身份通过 | 全部未测 |
| 微信/企微/飞书/钉钉 | 沿用真实渠道协议、官方 SVG、微信二维码和验证码、发现 owner、断开、重连与带 revision 的迁移；补刷新失败的显式重试、轮询失败续接、前后台隔离、发现与迁移互斥、迁移/断开后字段重置、迁移来源按 clientID 过滤、验证码成功清理、微信 reply_unavailable 错误 | QR 纯逻辑通过；渠道交互新 UI fixture 未运行 | 全部未测，不宣称实际平台连接成功 |
| 清空聊天记录 | `clearAssistantHistory` 调真实 `POST /contact/reset`，严格核验 assistantID/reset/historyCleared/generation；详情可接受本地化 `historyActions` 文案显示真实确认/错误/重试/成功，不借用删除 Bot 的文案，不自动重试有损请求 | 核心路径、坏确认、未知结果不自动重试通过；UI fixture 未运行 | 全部未测；生产文案/props 由 main 接入后才有按钮 |
| Bot 删除 | 维持 expectedRevision + 原生 destructive 确认；清空历史与删除 Bot 分离 | revision/失败/权限纯逻辑通过，已有 UI suite 本轮未运行 | 全部未测 |
| 计划列表/搜索/过滤 | `schedules.tsx` 加入本地名称/排期搜索，无搜索 HTTP；全部/启用/暂停，按 Web 启用优先/名称排序；行显示所属项目；无项目禁建；创建主动作改中性实体 | 排序和不变原集合通过；搜索 UI fixture 已补、未运行 | 全部未测 |
| 计划详情/编辑入口 | 系统 NavPage、headerBackTitle=""、项目实际目录、排期/时区/状态/提示词/模型/Agent/variant；从 Bot 详情进入时保留已知有效任务只读快照，不把初次加载/部分失败当删除；确认删除后可通过 onDeleted 返回 | 类型检查通过；现有详情 UI fixture 未运行 | 全部未测；编辑器细节仍需 main |
| 暂停/继续、即时运行/删除 | 真正 PATCH/POST/DELETE；即时运行在核心拒绝 paused/running，不仅依赖按钮；logical failure 不可当成功；项目写串行、跨项目不相互阻塞 | 成功/失败/坏响应/Host切换/卸载/串行/同步未完成通过 | 全部未测 |
| 历史/更多/错误恢复 | 真正 opaque cursor 分页、按 projectId+taskId 过滤、失败保留旧页与同 cursor 重试；实时首屏刷新有重叠时保留已经加载的旧页，无重叠不隐瞒 gap；运行中本地耗时更新只在前台运行 | 分页、坏 DTO、逻辑失败、去重、刷新竞态、旧页保留、暂停/恢复通过 | 全部未测 |
| 历史会话目录正确性 | 仅使用历史 run.directory；缺目录不猜当前项目目录，避免打开错误工作树。即时运行返回 sessionId 时使用发起时确认的项目目录 | 记录目录优先、缺失不导航通过 | 全部未测 |
| 部分项目失败与恢复 | 全局列表保留失败项目旧有效快照，不接受该项目随失败返回的不完整行；已加载完整项目照常可用；明确 warning+Retry | 部分失败/逻辑失败/坏数据/重复身份通过 | 全部未测 |
| 前台、后台与被覆盖页 | Home/Settings/Details 增加/保留 active；计划 controller.suspend 只作废在途读取、不丢数据、不取消已发出的写；恢复立即 GET；stream-ready/reconnected 补偿；旧 Host/generation 不提交 | controller suspend/旧响应/恢复、editor-write fence通过 | 全部未测；必须 main 传真实 active |
| 计划页 Bot 创建提示入口 | 可选 onOpenAssistant：读取真实 snapshot，选 pinned 或第一个 Bot，打开真实 contact | 类型检查通过；UI未测 | 全部未测；main 待接 |

## main 必须完成的精确接线

### Settings → 真正 Bot 配置集合

无需新增路由协议，可以直接复用已有 `{ kind: 'settings', route: { page: 'assistants' } }`：

```tsx
import { AssistantHome, AssistantDetails, AssistantSettings } from './assistants';

const settingsCallbacks = {
  // 保留原来的其他 callback
  onAssistants: () => nav.push({ kind: 'settings', route: { page: 'assistants' } }),
};

// 放在 generic SettingsPage 分支之前；组件自己拥有 NavPage，不再套第二层 header。
if (route.kind === 'settings' && route.route.page === 'assistants') {
  return <AssistantSettings
    active={nav.routes().at(-1) === route}
    onCreate={() => nav.push({ kind: 'bot-editor' })}
    onEdit={bot => nav.push({ kind: 'assistant-details', bot })}
  />;
}
```

- `AssistantHome.onEdit` 继续进入 `assistant-details`，不能连接到 chat；`AssistantHome.onOpenChat` 才进入 contact。
- `AssistantDetails.onOpenTask(item)` 已带正式 `projectId`，直接 push `{kind:'task', item}`；不要再次把 projectId 覆盖成可能缺失的 projectID。
- `AssistantDetails.onOpenChat` 直接交 `openChat`；`onDone` 保持 `nav.pop()`。
- 主 Tab：`AssistantHome active={nav.routes().length === 1 && app.tab() === 1}`；`ScheduledHome active={nav.routes().length === 1 && app.tab() === 2}`。不要只看 tab，因为编辑器覆盖后 tab 值不变。
- `AssistantDetails`、`ScheduledTaskDetail`、`AssistantSettings` 传 `active={nav.routes().at(-1) === route}`。
- `ScheduledHome onOpenAssistant={openChat}` 接上计划页的 Bot 入口。
- `ScheduledTaskDetail onDeleted={() => nav.pop()}`：组件仅在当前前台且完整成功快照确认任务不存在时通知一次；部分失败不触发。编辑器删除后回到此详情也会收敛返回。
- 这些模块自带 NavPage 的不再添加内容自绘 Back/header；root Tab 保留唯一 header owner。

### 清空历史文案与回调

`AssistantDetails.historyActions` 结构：

```tsx
historyActions={{
  clearLabel: t('assistants.contact.clearHistory'),
  confirmDescription: t('assistants.contact.clearHistoryConfirm'),
  clearedLabel: t('assistants.contact.historyCleared'),
}}
```

上面三个是**待 main 添加**的共享词典 key，当前不能直接引用；本轮没有越界改所有语言字典。可选 `onHistoryCleared(assistantID, generation)` 用于 main 自己的页面同步通知，不能把它当作新的会话或 Bot 删除；真实聊天仍须按服务端 generation 重读，不本地伪造清空成功。

可使用以下完整翻译（依次为 clearHistory / clearHistoryConfirm / historyCleared）：

| locale | 按钮 | 确认说明 | 成功 |
| --- | --- | --- | --- |
| en | Clear chat history | Delete this bot’s chat history? This cannot be undone. The bot and its configuration will remain. | Chat history cleared |
| zh-CN | 清空聊天记录 | 确定清空此 Bot 的聊天记录吗？此操作无法撤销，Bot 及其配置会保留。 | 聊天记录已清空 |
| zh-TW | 清空聊天記錄 | 確定清空此 Bot 的聊天記錄嗎？此操作無法復原，Bot 及其設定會保留。 | 聊天記錄已清空 |
| ja | チャット履歴を消去 | この Bot のチャット履歴を消去しますか？この操作は取り消せません。Bot と設定は保持されます。 | チャット履歴を消去しました |
| ko | 채팅 기록 비우기 | 이 Bot의 채팅 기록을 비우시겠습니까? 이 작업은 되돌릴 수 없습니다. Bot과 설정은 유지됩니다. | 채팅 기록을 비웠습니다 |
| fr | Effacer l’historique de discussion | Effacer l’historique de discussion de ce bot ? Cette action est irréversible. Le bot et sa configuration seront conservés. | Historique de discussion effacé |
| es | Borrar el historial del chat | ¿Quieres borrar el historial del chat de este bot? Esta acción no se puede deshacer. El bot y su configuración se conservarán. | Historial del chat borrado |
| pl | Wyczyść historię czatu | Czy wyczyścić historię czatu tego bota? Tej operacji nie można cofnąć. Bot i jego konfiguracja zostaną zachowane. | Historia czatu została wyczyszczona |
| pt-BR | Limpar histórico da conversa | Limpar o histórico de conversa deste bot? Esta ação não pode ser desfeita. O bot e sua configuração serão mantidos. | Histórico da conversa limpo |
| uk | Очистити історію чату | Очистити історію чату цього бота? Цю дію неможливо скасувати. Бот і його налаштування залишаться. | Історію чату очищено |

### features.tsx 必要改动（本轮没有越权修改）

1. BotEditor 和 TaskEditor 的 NavPage 加 `headerBackTitle=""`；TaskEditor Save 放进系统 headerRight，避免唯一保存动作在长页底部。BotEditor 当前同时有 header Save 和末尾 Save，需 main 按系统 header owner 收敛重复动作。
2. Bot 设置不拥有 agent/mode。对照 Web `AssistantsSettingsPage.tsx:101-113`，PATCH 必须省略两字段；Bot 的 CatalogFields 不应暴露 Web 没有的 Agent 设置。不能因打开设置、切换模型而清除后台持有的 Agent/mode。
3. Bot 模型目录对齐 `draft.workspacePath ?? selected.managedWorkspacePath ?? null`，不能以第一个项目路径替代托管工作区；新增时同时核对 Web 默认模型与首次默认名称。现在 `directory()` 会回落首项目，不是同一配置上下文。
4. TaskEditor 加 `execution.goalEnabled` 的真实开关及保存；Web 当前实现有 goalEnabled，**未发现实际 token budget 字段/UI，不应只因词典有 budget 文案就虚构预算控件**。
5. TaskEditor 保存/删除经确认成功后，在任何全局 refresh 之前调用 `noteScheduledCatalogWrite()`（从 `./schedules-state` 导入）；这样较早页面 GET 不能覆盖刚提交的编辑器结果。此函数只作废旧读，不会再发写请求。
6. Bot/Task 的 dirty 离页确认、取消/返回手势、Web日期/时间选择与 cron 校验/示例/下一次运行预览仍需逐项补齐。当前 Native 是日期/时区文本输入，并非 Web 完整 picker。
7. 模型目录刷新失败应保留上次有效 providers/agents；当前 modelCatalog.load 一开始会清空两数组。目录失败不能伪装成无模型。
8. `schedulerSynced:false` 是已提交，不得再创建/反向切换。保留现有 committed/Done，补明确的同步未完成说明与权威状态恢复。Host 当前没有独立公开 sync/retry endpoint；不得造一个“重新同步”按钮只调用 GET 并宣称成功，更不能自动重跑任务。删除最后一个任务尤其不能重放创建。

## 实际验证

已运行，未使用 NSH engine：

```sh
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/assistants-core.test.ts packages/nsh/schedules-state.test.ts \
  packages/nsh/assistants-swipe.test.ts packages/nsh/assistants-qr.test.ts
# 4 files, 79 tests passed

node --check packages/nsh/tests/assistants-settings-host.js
# passed
```

- 独占入口与两份 test-app 的纯 tsc：通过。临时配置仅 include `assistants.tsx`、`assistants-settings-test-app.tsx`、`schedules-test-app.tsx` 及其真实依赖，继承本包配置，并添加 `DOM.Iterable`；不写仓库配置。
- 全包原始 tsc 曾被共享 `runtime-url.ts` 缺 DOM.Iterable 阻塞；补 CLI lib 后一度通过。最新并行状态下，全包 augmented tsc 被 `chat-header.tsx:109` 的 Button.accessibilityState 类型错误阻塞，本轮未修改该文件，不能声称最新全包通过。
- `bun run dead-code` 已执行并审阅；有仓库既存大量非阻断项，新增 AssistantSettings 当前也因 main 入口未接而被报告未使用，**不能用删除新入口逃避接线**。脚本不代表运行时验证。

main 结束设备独占窗口后才可串行执行：

```sh
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/assistants-ui.test.ts \
  packages/nsh/assistants-settings-ui.test.ts \
  packages/nsh/schedules-ui.test.ts
```

新 `assistants-settings-ui.test.ts` 使用 `assistants-settings-test-app.tsx` 与 `tests/assistants-settings-host.js`，覆盖设置 GET失败→重试、行进配置而非聊天、关联计划实际详情/目录、渠道读取失败→重试、迁移后表单权威字段与保存、清空取消不发请求、500保留按钮→再次明确确认成功、返回集合→创建。新测试与现有 UI 测试本轮全部未运行，不能预填通过。

## 全量剩余范围（仍在验收范围，不是非 MVP）

1. main 上述生产入口/active/文案接线，以及 features 编辑器全部缺口。
2. Bots 禁用引导的实际图片/分享步骤、原生分享入口与扩展、附件/资源/卡片/联系人聊天完整 Web 能力，均不能因本轮覆盖设置集合就宣布完成；普通 Chat 与 Bot contact 的 ownership 仍不同。
3. 关联计划旧 Host fallback 已实现，但只消费同 Web 首批 contact snapshot 中实际出现的 schedule 卡片，不猜未加载历史；旧 Host 真实 DTO、分页缺口与失败项目专项仍待 H/S/D。原接口错误继续可见，不因回退有部分行就伪称全部成功。
4. 渠道平台的真实登录、扫码/验证码、发现取消的服务端资源生命周期、迁移冲突、断线/重连、投递未知与保密专项未验收。取消 discovery 目前 fencing 掉回包，不声称 Host 已真正取消发现任务。
5. 计划未同步后的真实 scheduler 自恢复、编辑冲突、Host 重启/后台漏事件恢复，需要 main 联调；仅 GET 或 unit 通过不能证明 scheduler 在跑。
6. UIKit 的系统导航/返回手势/Sheet、键盘、safe area、长名单、大字号、各语言、深浅主题、与 Web 同状态逐区视觉对帧；H/S/D 全部仍待验收。

协议/页面对照来源：`mobile/assistant/MobileAssistantTab.tsx`、`MobileAssistantSettingsPage.tsx`、`sections/assistants/AssistantsSettingsPage.tsx`、`AssistantPlatformChannelPanel.tsx`、`AssistantWeixinChannelPanel.tsx`、`session/ScheduledTasksDialog.tsx`、`ScheduledTaskEditorDialog.tsx`、`mobile/scheduled/MobileScheduleAssistantHint.tsx`、`lib/scheduledTasksApi.ts`，以及 Host `assistants/service.js` / `routes.js`、`scheduled-tasks/routes.js`。

main 还需在 `packages/nsh/DOCUMENTATION.md` Ownership 补充 `assistants*.ts*` 与 `schedules*.ts*` 的拥有范围；本轮遵守独占文件边界，没有改共享文档。

## main 首轮串行 UI 红灯回修

main 实际运行发现两项红灯，本子会话仍未运行任何 NSH engine：

1. `assistants-settings-ui.test.ts` 使用了不存在的 `text:Retry`。实际共享英文词典 `assistants.actions.retry` 是 `Try again`。产品文案不变；重试动作增加稳定的 `assistant-settings-retry` testID/本地化 accessibilityLabel，测试先核实际词典文案，再用 ID 点击并继续验证错误→重试→配置集合。
2. `schedules-ui.test.ts` 使用 `app.type(selector, "")` 试图清空。NSH 官方测试语义是 type 在末尾逐字追加，空串不发 onChange，所以 `does-not-match` 留在搜索条件中，后续过滤时仍显示 `No schedules match your search.`。改用 `app.clear("id:scheduled-search")`，明确断言清空前/后的输入值、真实空搜索文案的出现/消失、清空恢复两条任务与零 HTTP，然后继续原有 paused/active/all、菜单、历史、即时运行及删除验收点；没有删除或降低断言。

这两项修复的 UI 结果仍待 main 再次串行运行，不能把静态/纯 TS 检查写成已绿。

回修后实际执行：独占入口纯 tsc 通过；两份 UI test source 的 TypeScript syntax transpilation 通过（不执行生成代码）；原四份纯 Node 单元仍为 79/79 通过。没有执行两份 UI test，也没有改测试 Host 的成功/失败响应来绕过红灯。
