# Bot 创建默认值与 Voice 本地模型：分工交接

日期：2026-11-07。C/F/H/S/D 分别为生产接线、fixture、真实 Host、模拟器、真机。此记录只覆盖本分工，不代表 Native 手机端已 1:1 验收。

## 范围与 authority

- `features.tsx` 仅改 Bot 创建默认值、其加载反馈及 pristine 基线；未改 Task/cron/editor 通用逻辑。`tests/features-fixture.ts` 只登记新增真实 helper 的 import。
- 新增 `features-bot-defaults.ts`、`settings-voice-models-core.ts` / `.tsx` 及本分工纯测试、独立 engine fixture。Voice 通过 `settings-basics.tsx` / `settings-basics-core.ts` 接入。
- 十份现有 `*.settings.ts` 只新增唯一 key `settings.voice.nativeModels.hostStorage`，全部实译；没有平行语言表、没有修改其他 keys。
- 未修改 application/state/appearance/settings-collections/providers/projects/assistants-settings/iOS/cron；没有依赖增补、git/GitHub、真实下载、付费调用、TTS、Host 配置写入或设备操作。
- 工具目录没有 spawn/delegate/session-message 入口，未派出下层 Agent，不冒充独立审计。

### Bot

依据 Web `AssistantsSettingsPage.tsx` 的 `resolveDefaultAssistantModel`、`emptyDraft` 和首 Bot 名称 effect；`useConfigStore.ts` 的 `sanitizeProviderList` / `loadProviders` 保留 catalog provider 顺序，并用 `Object.values(provider.models)` 转数组。Yuri defaults 与 Web `fetchYuriDefaults` 同源读取 `/api/config/settings/bootstrap` schema v1，仅消费并按同样 512 字符规则 trim `defaultModel/defaultVariant`，不拉入含浏览器 URL 解析的整个 bootstrap parser。

1. 先用 Yuri `defaultModel`；仅当前 `modelID` 不存在时才以 OpenCode config model 作为该候选。
2. 候选可解析则取内联 `#variant`，否则 Yuri `defaultVariant`。
3. 候选不可用时，取上层提供的完整当前 provider/model/variant。
4. 最后才复现 Web 的真实 catalog 原顺序首模型兜底；不排序、不借用 provider.default / favorite / recent / 首项目。
5. 仅成功的 assistants snapshot 确认为零 Bot 时填 `Yuri`。已有 Bot 的编辑值不重置。默认值读失败保留输入、显式重试；异步返回不覆盖用户改名或旧 Host 页面。加载默认值本身不产生 unsaved dirty。

OpenCode `GET /api/config` 的 `document.info` 按当前 Web `mergeConfigDocuments` 共享纯函数折叠；`parseModelIdentifier` 也复用 Web。NSH 的窄 SDK-gap 路径保持 `location[directory]`，Swift 继续拥有凭据。Context7 查过 NSH cleanup/effect/Progress 与 OpenCode v2 config；当前仓库 wire/解析源码是实际依据，不套用旧文档的单对象 Config 返回。

### Voice

依据 Web `VoiceSettings.tsx` 的 `LocalModelPicker` / `LocalTtsModelStatus` / Kokoro speakers，以及 Host `dictation/runtime.js`、`service.js`、`local/model-catalog.js`。

| 操作 | 真实协议 |
| --- | --- |
| 状态 | `GET /api/dictation/status?provider=local`，分别消费 `models` 与 `ttsModels` |
| 下载 | `POST /api/dictation/models/:id/download`，无 body |
| 删除 | `DELETE /api/dictation/models/:id`，无 body；先原生确认 |

- 四个 STT 模型、Kokoro、大小、徽标、准确度/速度、安装/下载/进度/错误均有原生呈现；Kokoro 的 11 个 speaker 用真实 `localTtsVoiceId` 保存。
- 选择 STT 或 speaker 只改本地设置草稿；显式 Save 才走既有 Voice settings 写入。不把保存 ID、下载 ACK、catalog 大小当成安装或真实已下载 bytes。
- 下载/删除响应只确认请求；随后 GET 才更新安装状态。GET 失败保留旧快照，禁用基于过期状态的文件动作，`voice-local-refresh` 只重读，不重发已接受的下载/删除。
- 下载失败行保留，Retry 调同一 Host 幂等下载入口；请求失败独立显示，不伪装成功。下载中不提供删除或重复下载。
- 页面 active 且 app foreground 才读取/轮询；只在 Host 报 downloading 时每 2 秒串行刷新。隐藏、后台、销毁停止 timer 并 fence 晚到结果。恢复先 GET；不取消 Host 正在进行的后台下载。
- 请求预算是每个可见 Voice 页面一个共享 manager（四个 STT + 一个 TTS），下载中最多一个串行 GET/2 秒；两个区域不各开轮询。空闲、隐藏、后台均无持续 GET。纯测试检查了请求次数和隐藏 timer，但未做 UIKit 帧时间/CPU/P95 测量。
- `voice.sttLocalModel` / `voice.localTtsVoiceId` 仍由现有 metadata 生成搜索项，锚点在真实管理组件。搜索目标可显示对应模型管理，不擅自切换 provider。

## main 必须完成的接线

本分工没有权限改下列 owner，以下不是已经完成的 C：

1. `application.tsx` 的 `BotEditor` 创建入口：传 `defaultContext={{ directory, selection }}`。`selection` 类型为 `{ providerID, modelID, variant? }`，必须来自实际当前选择 authority；`directory` 也必须来自真实路由/选择上下文。不能读取 `app.projects()[0]`、历史消息、recent 或任意 session 猜测。Native 当前没有 Web ConfigStore 等价全局选择时，需要 owner 明确捕获/传递；不传时只能使用 Host 默认上下文 config/catalog，不能声称已还原“当前选择优先级”。
2. `SettingsBasics` 新接收 `active?: boolean`。在 application 顶层路由用 `nav.routes().at(-1) === route` 传到 `SettingsPage`，并由 settings owner 透传给 Basics。现有未传入口默认 true，因此只证明了 app lifecycle/cleanup；覆盖页停止轮询仍待此接线和 engine 验证。
3. 可从 NSH `DOCUMENTATION.md` 链接本记录；该共享文档没有在此分工改写。

## 验证

### 已运行

```sh
bunx --package vitest@4.1.11 vitest run --config packages/nsh/vitest.config.ts packages/nsh/features-bot-defaults.test.ts packages/nsh/settings-voice-models-core.test.ts packages/nsh/bot-voice-parity.test.ts packages/nsh/bot-voice-fixture-host.test.ts packages/nsh/features.test.ts packages/nsh/settings-search-core.test.ts packages/nsh/settings-entrypoints.test.ts
```

7 文件、47 项全部通过。全部是 Node 纯测试、生产 callback/DTO 注入测试、无 URL 全局的 VM 或静态字典/catalog 对照；没有 NSH engine。覆盖默认名/优先级/variant/原顺序/坏返回/Host fence/保留编辑/pristine、安装 authority、ACK 不等于 install、读失败保留与只读重试、单次 mutation、防重、进度轮询/隐藏/恢复/销毁、十语 key 与搜索锚点。

跨 owner 提醒后核查：当前 `tests/new-session-path.js` 路径不存在，未跨 owner 新建或修改；自有 fake Host 使用自包含严格 path/query 字符串解析，支持模型 ID 中的合法小数点，拒绝错误目录、未知/重复 query、坏转义、绝对 URL、fragment、遍历 segment、错误 method、设置 mutation 与 TTS。`bot-voice-fixture-host.test.ts` 在 VM 将 `URL/URLSearchParams` 明确置为 undefined，执行真实 fake Host 证明这些路径不依赖它们；VM 通过仍不是 QuickJS runtime。

- `bunx tsc --noEmit -p packages/nsh/tsconfig.json`：失败。剩余诊断位于共享 Web `QuestionAutoDelegateStatus.tsx` / `button.tsx` / i18n/sync React Provider、desktop/import-meta/process 类型等跨域依赖；本分工文件无诊断。main 已说明 `draftStarters` type barrel 污染由 designer owner 修复，本分工未放宽类型或忽略诊断。**不记为 tsc 通过**。
- `bun run dead-code`：执行完成、非阻断报告已查阅。独立 `bot-voice-native.fixture.tsx` 是显式测试入口，被静态工具列为 unused；已收掉本地 `kokoroVoices` 的多余 export，没有删除其他 owner 的报告项。
- `.agents/skills/settings-ui-patterns/scripts/audit-settings-ui.sh` 对两个本分工 Settings TSX 通过。此脚本不能证明原生布局。
- 独立 `nsh build bot-voice-native.fixture.tsx --release --out <临时目录>`：未成功，当前 `nsh` 不在 PATH、`NSH_BIN` 未设，报 ENOENT；没有运行 NSH engine。
- 仅对自有 fixture 的 `bun build ... --target browser --external nsh --external 'nsh/*'` 静态打包通过（87 modules）；它不是 NSH bytecode，不证明 QuickJS/UIKit。产物只在 OS 临时目录，不提交。

### main 的串行 engine 入口（只准备，未运行）

- 入口：`bot-voice-native.fixture.tsx`
- fake bridge：`bot-voice-native.fixture-host.js`，无外网、仅内存模型状态；拒绝 Host 配置 mutation / 真实 TTS / 未定义请求。
- 测试：`bot-voice-native-engine.test.ts`，默认 skip，必须显式授权开关：

```sh
NSH_BOT_VOICE_ENGINE=1 NSH_BIN="<NSH可执行文件>" bunx --package vitest@4.1.11 vitest run --config packages/nsh/vitest.config.ts packages/nsh/bot-voice-native-engine.test.ts
```

准备的两项场景：生产 BotEditor 首名/配置模型/内联 variant 保存到 fake Host；生产 Voice radio 只改选择、下载 ACK 后 GET 失败仍不显示 installed、手动刷新不重放 POST、active=false 禁用刷新。尚未确认这些 engine steps 的实际可见性/滚动/布局。

## C / F / H / S / D 未验收

| 能力 | C | F | H | S | D |
| --- | --- | --- | --- | --- | --- |
| 首 Bot 名称、Yuri/config 默认模型 | 已接生产 BotEditor | 纯 callback/helper 通过；engine 未跑 | 未验 | 未验 | 未验 |
| 实际当前选择/目录的默认优先级 | helper 已实现；application 传值未接 | 输入覆盖已测；真实路由未验 | 未验 | 未验 | 未验 |
| Host STT/TTS 文件管理与 speaker | 已接 SettingsBasics；选择与 install 分离 | 纯 controller/metadata 通过；engine 未跑 | 未验 | 未验 | 未验 |
| app 前后台、cleanup 与旧 Host fence | controller/UI 已实现 | 纯生命周期通过 | 未验 | 未验 | 未验 |
| 覆盖页/返回时暂停和恢复 | 需 main 透传 active | 仅独立 fixture 已准备 | 未验 | 未验 | 未验 |
| 页面 1:1、radio/评分条/下载进度条、删除确认、长文本与十语布局 | 原生实现，不宣称视觉相同 | engine 未跑 | 未验 | 未验 | 未验 |

真实大文件下载/删除、Host 重启后的下载状态、断网/Relay-only 恢复及真实手机操作仍在完整交付 scope，但本轮明确禁止实际执行。没有因此降低验收标准，也没有声明 STT/TTS 真正能在手机端工作。

## main 生产整合与实跑追记

- `application.tsx` 已向所有 Settings route 传真实顶层 active，`SettingsPage` 透传 Basics。新建 Bot route 捕获实际 Chat/新会话 `onSelection` 发布的目录、模型、variant 与 Agent 副本；Host generation fence 和无选择不猜测由 `createBotCreationContext` 保证。此投影不发请求、不读取消息历史、不订阅草稿文字。
- Bot/Voice 两个 opt-in engine 场景已实际通过。最初 Voice fixture 直接传 `selected.set`/`voice.set` 导致 native signal receiver 丢失；已改成箭头调用，生产 Basics 原本已有正确调用方式，未修改业务协议掩盖。
- main focused `features-bot-defaults`、Settings entrypoints、picker runtime boundary 共 3 文件 17 项通过；这不是最新全包结果。生产 Bot 上下文跨公开路由另有独立回归，不能用本段代替其运行证据。
- 仍不宣称真实 Host 模型下载、真实 TTS/STT、真机、覆盖页 UIKit 或样式同状态对照完成。
