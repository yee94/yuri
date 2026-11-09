# Local compatibility preferences：底层 owner 与 Prefs 接线冻结

本模块只负责 sidebarBrandName 与 iosNativeUiEnabled 的本地持久化。生产入口是 `../../local-compatibility-preferences.ts` 的 `localCompatibilityPreferences`；它直接连接 NSH Storage。纯控制器在 `../../local-compatibility-preferences-core.ts`。不创建 root、signal、轮询、Host 请求或品牌 UI，也不控制 NSH Tab/composer。

## Prefs P2 freeze 后的接线 seam

生产 adapter 是唯一 coordinator；不要每次打开页面重新创建 coordinator。Prefs 为每个打开的表单创建 handle，使用 `load / snapshot / save / dispose`。`changed` 只发布成功且仍有效的结果；失败通过 rejected promise 交给 UI。页面隐藏、销毁或 operation 更换时 dispose，后续重开创建新 handle。

品牌接口：

```ts
const owner = localCompatibilityPreferences.openSidebarBrand({
  transportID: transportPartition.id,
  expectedHost: operation.scope,
  current: operation.current,
  currentHost: app.runtimeScope,
  currentTransportID: transportPartition.currentID,
}, value => { /* 发布到当前 Prefs 表单，不挂品牌 UI */ });
await owner.load();
await owner.save({ sidebarBrandName: draft });
owner.dispose();
```

`operation.scope` 必须非 null。`operation.current` 来自创建表单时捕获的 Host operation，不能在点击时重新捕获。controller 同时核对 copied expectedHost 与 currentHost，以及 captured transportID 与 currentTransportID。`currentTransportID` 必须返回当前已确认 transport partition 的身份；未知返回 null。

**transportPartition 由 Native Connection.transportID 明确注入。** ConnectionStore 在原子连接记录中维护精确 transport 到 opaque UUID 的持久映射，只在提交成功后通过 publicValue 暴露 transportID。连接记录支持同 ID 改换端点；不能从 hostname、公开 relay URL、connection.id、authorizationID 或 lease 猜稳定分区。旧桥缺少此字段仍是 unknown，不提供推导 fallback。

transportID 是无凭据的稳定 opaque ID（TS 接受1–128个 ASCII 字母、数字、下划线或连字符，当前 Swift 签发小写 UUID）：精确匹配 origin/端口及 direct/Relay route、Relay server identity 的同一 transport 重开使用同 ID；这些维度不同必须不同 ID。Storage key 不存 URL、凭据、路径或 lease。拿不到此身份时，Prefs 将该字段标记为等待 transport scope，不允许回退全局桶；只有成功存储读取才确认默认 Yuri，不导入任何旧全局品牌记录。

iOS 兼容偏好接口：

```ts
const owner = localCompatibilityPreferences.openIosNativeUi({
  current: () => pageStillCurrent(),
  changed: value => { /* 仅更新兼容偏好表单 */ },
});
await owner.load();
await owner.save({ iosNativeUiEnabled: draft });
owner.dispose();
```

flag 是设备级，不绑定 Host；page current/dispose 仅控制本次表单异步结果的采用。此 flag 不启停 NSH 原生 Tab/composer，不创建 Web fallback。不要从 Host GET/PUT 读写这两个字段，也不要将它们放进 Host preference receipt。

## 数据与失败合同

| 项目 | sidebarBrandName | iosNativeUiEnabled |
| --- | --- | --- |
| Storage key | `sidebar-brand-transport-v1.<opaqueID>` | `ios-native-ui-compat-v1` |
| JSON | `{ "sidebarBrandName": string }` | `{ "iosNativeUiEnabled": boolean }` |
| 成功读取缺记录或旧 `{}` | 默认 `Yuri`；不自动写盘 | 默认 false；不自动写盘 |
| 归一化 | 和 Web setter 相同的 UTF-16 `slice(0,64)`，不 trim、不压缩空白 | 严格 boolean，不把字符串/数字转 boolean |
| 隐藏品牌语义 | `''`、全空白原样保留；未来有消费者才按 trim 判断隐藏 | 不适用 |
| 保存 | 串行，逐次 read-before-write，保存前捕获草稿副本 | 同左；保存 false 也真实落 JSON |
| 损坏/读写失败 | 拒绝，不覆盖已确认 snapshot、不覆盖未读旧记录 | 同左，不发布 false 默认 |

这是新的 Native Storage namespace；未发现需迁移的旧 Native 两项记录。不读取浏览器 localStorage，也不从 Host 的历史同名键导入。成功读取 `{}` 属于显式缺字段兼容；null/数组/坏 JSON、错误类型及未知字段均拒绝，避免重写未知数据或携带凭据。有效旧字符串也按 Web setter 限64字符；load 不修改磁盘，只有显式 save 落规范值。

同 key 的所有页面 handle 共用串行 lane；新 handle 使同 key 旧 handle 的 callbacks 和排队工作失效。跨 key 并行互不覆盖。不同 transport 切换由 currentTransportID/Host receipt/page operation CAS 作废旧操作；同 transport 的新 lease 保持原磁盘桶，旧 lease 不得发布结果。

在 Storage.setItem 发出前变 stale：不会写；发出后才 stale：无法声称物理取消，写入仅可能落到原捕获 key，promise 拒绝 stale、不发布成功。新 owner 的同 key load 等该写完成后再读，读取结果决定后续展示，不盲目重放旧 save。错误仅返回固定 `local_preference_*` 分类，不转发底层异常中的 key、内容或路径。错误保 prior；scope 已失效时 snapshot 返回 null，而不是借 prior 冒充当前 scope 权威。

## 四个 target ID 冻结

只交付映射，等 Prefs ACK/刷新 P2 freeze 后由主会集成；本模块不改 Prefs/core。

| 字段 | 当前 Native | 正确 Web target | Web 来源 |
| --- | --- | --- | --- |
| padding | appearance.spacing | **appearance.spacing-density** | YuriVisualSettings.tsx:1355 |
| pwaAppName | appearance.install-name | **appearance.pwa-install-name** | YuriVisualSettings.tsx:1033 |
| pwaOrientation | appearance.install-orientation | **appearance.pwa-orientation** | lib/settings/search.ts:142 |
| allowPromptingSubagentSessions | chat.subagent-read-only | **chat.subagent-read-only-banner** | YuriVisualSettings.tsx:1698 |

以上 Web 文件均在 `packages/ui/src/`；YuriVisualSettings 位于 `components/sections/yuri/`。其余本批标准 target：appearance.code-font-size、terminal-font-size、editor-font-size、input-bar-offset、file-editor-keymap、sidebar-brand、ios-native-ui、usage-reports、mobile-keyboard-mode、transcript-cache；Chat 为 chat.collapsible-user-messages、chat.persist-drafts；跨 surface 拼写字段为 chat.spellcheck（手机隐藏）。

## 默认与适用说明冻结

下表的默认仅在成功读到缺字段时使用；读失败/unknown 不是确认默认。数字值发 Host 时是 number；本地字段不得因 Host 的200响应就标成功。

| 字段 | 默认 / 范围 / 类型 | 保存与说明 |
| --- | --- | --- |
| codeFontSize | number 100；50–200，step5 | 本机；代码展示，已由 device appearance owner 消费 |
| terminalFontSize | number 13；9–52，step1 | Host round/clamp；用于终端 surface，DedicatedMobile 无终端入口，不新增菜单 |
| editorFontSize | number 13；9–32，step1 | 本机 round/clamp；Skills 可编辑 Input 已消费，不新增普通 Files 编辑器 |
| padding | number 100；50–200，step5 | Host round/clamp；Native density 已消费，不能继续标 unconnected/unavailable |
| inputBarOffset | number 0；0–100，step5 | Host round/clamp；只影响 Capacitor Web composer 且未聚焦；NSH 不额外 offset |
| fileEditorKeymap | string default / vim；默认 default | 本机 device appearance owner；仅保存/恢复，不需 Native Vim engine |
| pwaAppName | string；空 override；trim/合并空白/64字符 | Host；Web/PWA 安装名。空提交清 override，GET 缺该键可表示成功；展示默认名不写回 override |
| pwaOrientation | string system / portrait / landscape；system | Host；PWA manifest，不把它当 NSH 旋转锁 |
| mobileKeyboardMode | string native / resize-content | Host GET 缺值默认 native；Web 启动/本地缺值默认 resize-content，二者不合并。适用浏览器 viewport，不修改 NSH UIKit 键盘策略 |
| sidebarBrandName | string Yuri；slice64保留空白 | 本模块 transport-scoped Storage；不在 DedicatedMobile/NSH 首页添加品牌消费者 |
| iosNativeUiEnabled | boolean false | 本模块设备兼容 flag；Web 开关仅 Capacitor iOS 可见，不应用到 NSH Tab/composer |
| reportUsage | boolean false | Host；Web mobile update check 有消费者。Native 当前客户端更新 unsupported，后续上报必须消费确认偏好，不能以 host-only 假称上报闭环 |
| transcriptCache | 清理动作，无标量默认 | 本机确认/清理/失败重试；不渲染 text 偏好输入 |
| allowPromptingSubagentSessions | boolean false | 本机 Chat owner；Native 核心发送准入已消费 |
| collapsibleUserMessages | boolean true | 本机 Chat owner；Native transcript 已消费 |
| persistChatDraft | boolean true | 本机 Chat owner；Native draft 持久化策略已消费 |
| inputSpellcheckEnabled | boolean false | Host允许；Web手机 UI/search 隐藏，手机输入为 isMobile OR preference，不新增影响手机输入的假开关 |

Host sanitizer 位于 `packages/web/server/lib/opencode/settings-helpers.js`：PWA/keyboard/spellcheck:529–548，terminal/padding/offset:620–630，reportUsage:813。code/editor/keymap/sidebar/iOS flag、三个本机 Chat 偏好和 cache 均不在当前 Host 白名单内；历史 JSON 同名键存在不等于 API 接收。Host patch 保留其它旧键，GET 会过滤不支持键。

## 本次验证边界

使用仓库已安装的 Vitest CLI，仅执行两个纯 callback/Storage adapter 测试文件；adapter 测试 mock NSH Storage，不加载 engine 或 Host。独立 tsc 项目只检查这两个生产模块及其实际依赖。不宣称 Prefs UI、原生磁盘故障、UIKit 或 transport partition 签发已验收。UI 集成归主会在 Prefs P2 freeze 后完成；transport ID 端口不能被 guessed identity 绕过。

本次结果：两个聚焦测试文件共12项通过；`tsc --noEmit -p packages/nsh/tests/local-compatibility-preferences/tsconfig.json` 通过。dead-code 按仓库脚本的 knip 参数尝试离线执行：本地无 knip binary，已缓存5.80.0又缺 formatly，未能完成分析；没有联网或安装依赖。新 adapter 目前等待主会集成，不将暂时无生产消费者误称为已闭环，也不为消除 unused 告警修改 root。

## Prefs 后续接线状态

以上为底层交接时的冻结结果。后续 Prefs 已真实消费 singleton adapter 的 openIosNativeUi 与 openSidebarBrand。iOS flag 按活跃页面/operation 创建 handle，成功读缺值默认 false，损坏/失败保持 unknown 并显式重读，保存与 Host receipt 分离，原生界面不因 flag 关闭。它与本机 code/editor/keymap 均可在 Host GET 失败或 receipt 未 ready 时独立显示/编辑/保存；独立路径只提交本机草稿，不触 Host journal、不制造 Host ready、不覆盖 Host 错误。品牌继续需要捕获的 transport 与 Host authority，不扩大为全局/无 scope 保存。生产回调/Storage 故障与 stale 验证见 `../settings-preferences-gap-contract.md`。

### 已接品牌 scope 与原生持久化合同

原连接 ID 语义保持：ConnectionEditorRecords.replacing 仍保留 connection.id、替换 URL/relay 并轮换 authorizationID。transportID 独立于记录、授权和 lease；RuntimeBridge.snapshot 转发 store.snapshot，只新增 opaque transportID，不暴露 tuple、token 或公钥。TS model、snapshot parser、连接 metadata 保存与重新授权的 adoption 均校验并保留该字段；没有增加 runtime.request 或 expectedHost 字段。

ConnectionEditorRecords 在原 Keychain 原子记录新增 transportPartitions 数组，每项为 {transport:{address,serverID?},id}，连接行同时持有 transportID。direct address 复用既有 ConnectionEditorRecords.origin；Relay address 复用配对的 scheme/host/default-port 规则，现由 RelayConfiguration.canonicalAddress 统一提供，保留精确 route path 与 serverID。token、公钥、授权 ID 和 lease 均不参与 tuple。保存去重和替换碰撞也使用同一 tuple；没有另建 JS normalize 系统。认证、配对、健康核验及未配对 Relay gate 保持原路径。

缺少 transportPartitions 且连接没有 transportID 的旧记录可读，decode 本身不签发 UUID；ConnectionStore 初始化在暴露 snapshot 前通过原 commit/persist 原子补齐映射。已有映射必须满足规范 route、唯一 tuple/UUID、每个连接精确匹配，null/损坏/重复/不匹配拒绝，不丢弃记录或降级迁移。commit 从当前已确认记录继承映射，只在 persist 成功后替换内存；写失败不发布临时 UUID，保留旧配置。映射保留离开/删除过的 route，同 tuple 新 recordID 可复用；上限4096，满时拒绝新增，不静默淘汰/重用 ID。原授权退休 journal 与原子提交顺序仍成立。

Prefs 将初始捕获 transportID、operation.scope/current、app.runtimeScope 和 currentTransportID 交给原 owner。缺记录成功读取确认 Yuri；空串/空白原样保留，保存只 slice(0,64) UTF-16。read/write 失败保 prior/dirty，清 dirty 按提交时 revision；隐藏、lease/transport 变化及 dispose 退役旧 handle。表单不将旧分区草稿重绑到新分区，迟到物理写只可能进入原捕获桶，不能显示跨桶 Saved 或派发旧 mixed Host patch。同 transport 新 lease 重开 handle 读取原桶。没有新增 sidebar 品牌消费者、根、平行 form 或 store。

验证包括真实 ConnectionStore 的内存 read/write seam（保留生产初始化迁移/commit/mutation），Foundation round-trip/失败原子性、direct/Relay/端口/path/server 隔离、凭据/公钥轮换稳定、删除重建/切回稳定、损坏/容量拒绝与快照白名单；授权退休既有回归和完整 iOS SDK typecheck 通过。TS 覆盖 parser、生产 Prefs 回调/Storage 的 unknown、空白/UTF-16、跨桶/stale/partial 与 Host unknown no-replay。纯设置快照 fixture 只补充固定 synthetic transportID，未放宽 expectedHost 准入。设备/Keychain 真故障、引擎/UI 与跨后台的实际 UIKit 效果仍交主验收。
