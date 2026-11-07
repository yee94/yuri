# NSH About / Host 更新 / 事件诊断接线合同

## 当前边界

本 scope 只改 `settings-about*.ts*`、`ios/DiagnosticsBridge.swift` 和本目录自有 fixtures/tests/合同。没有改 `application`、`state`、`main.swift`、生产 `nsh.json`、构建/签名/发布身份、通知 owner 或其他 owner 的文档。三版本仍独立读取实际 Bundle、`GET /api/system/info.yuriVersion`、`GET /api/opencode/upgrade-status.serveVersion`（该协议的 `currentVersion` 仅作 fallback）。失败保留确认值，不用 CLI/package/Capacitor 版本补位。

旧的 snapshot-only About 已被本实现替代；文件中的版本 snapshot 只是事件报告的 `context`，不是事件日志本身。

## main 最小接线（现有通知 owner 不替换、不增加 observer）

当前 `application.tsx` 的 `observeRuntime` 第二参数是 `notifications.onEvent`。main 组合这个参数：

```tsx
import { createNativeAboutDiagnosticsRoot } from './settings-about-root';
// YuriNativeApp 内，现有 notifications 创建后：
const diagnostics = createNativeAboutDiagnosticsRoot();
observeRuntime(() => {
  void run(refresh);
}, (event, scope) => {
  notifications.onEvent(event, scope);
  diagnostics.onEvent(event, scope);
});
```

- 不再保留另一条旧 `observeRuntime`；不新增 `host.on('runtime.event')`。root adapter 自己负责一次 cleanup、Host/generation/foreground status 恢复；不读取/序列化 catalog，没有默认录制或默认写盘。
- **另有一行必须由 state owner 扩宽的 seam**：`state.ts` 已经解析 global/chat，但当前 callback guard 是 `if (onEvent && event.key === 'global' && !switching)`。要完整采集 Chat，改为 `if (onEvent && !switching)`，只扩宽 parsed sink，不改 catalog/attention/global stream 所有权。通知 `notification-root-core.ts:onEvent` 自己已严格拒绝非 global，所以现有通知行为不变。本 scope 没改 state；此行若未接，Chat 源仍未完成，不能把仅 global 的录制当完整 runtime 录制。
- 根初始化会新增一次 `native.diagnostics.status`（不读 Host CGI、不请求 OS 权限），前台/Host generation 恢复会再读。其他 owner 的严格全应用 fixture 应显式授权这个方法并返回 `{schemaVersion:2,mode:'event-recorder',enabled:false,recordingLease:null,…}`，把该初始化调用计入 before baseline；不能用 unknown blanket success，也不能伪称开启。append 仅用户明确开启后发生。
- 生产 capability **只新增** `native.diagnostics.append`；现有 `native.clientMetadata/status/setEnabled/export` 保留。不要授权 `about.fixture.*`。
- **Swift 无需新增 main 注册行**：现有 `DiagnosticsBridge(...)` init 内已注册新的 append handler。main 继续强持有此 bridge，沿用原 capture（`resourceTransport().isCurrent`），保留现有 `onInvalidate`/shutdown 上的 `diagnostics.invalidate()`；不能覆盖通知、appearance、resource 等其他 owner 的回调。系统分享失活不等于 Host 失效，不能在 willResignActive 时清理分享。
- `SettingsAbout` 已自行使用现有 `runtime.request` POST seam；没有新增 Swift Host 更新 handler，没有 shell、artifact URL、下载器或重启私有接口。
- main 更新 `DOCUMENTATION.md` 对应模块行即可：`settings-about*.ts* / ios/DiagnosticsBridge.swift` 负责“三版本、Host 更新确认/执行/进度/恢复、默认关闭的有界安全 runtime 事件日志与分享；NSH 客户端更新仍受签名渠道和安装生命周期阻塞”。该文件不在本 scope 写权限内。

## Host 更新：真实合同，不执行真实更新

证据：`ui/src/queries/hostUpdateQueries.ts`、`components/update/HostVersionUpdate.tsx`、`web/server/lib/host-update/{DOCUMENTATION.md,routes.js,runtime.js}`。

- GET `/api/system/update` 跟随 Host 已保存的渠道；失败任务恢复 GET `?channel=stable|beta` 使用原任务渠道。无新增、猜测或已退休的更新 CGI。
- 用户点击执行先重新 GET，展示版本、渠道、工件种类、更新日志及回滚警告，再用原生确认框确认。
- 只有当前确认的完整 plan 可以 POST `/api/system/update`，精确 body 为 `{version,channel,planId,allowDowngrade:boolean}`；无 command、URL、kind 或客户端可选安装方式。信任/权限最终由原生 runtime transport 和已有服务端 admission enforce，不由 UI visibility 代替。
- 双击、活动任务、过期 confirmation、无能力、检查失败和无 plan 不可提交。UI 取消清除 confirmation，域层未经 prepare 的 confirm 不可提交。
- operation 的 opaque identity、状态、版本/渠道/kind、原生 progress 保留；未知 progress 是 indeterminate，不构造百分比。活动时可见/foreground 每两秒检查；离页、后台或 lifetime 失效停止 timer。GET/POST 八秒 deadline 释放锁，迟到响应不能写入另一 Host。
- POST 失联不能确定未受理：进入 `updateUncertain`，只 GET reconcile，不自动重发。GET 502 仍可提供 operation，但带检查失败；POST 502 绝不是成功。404/501 在重启间隙保留原任务，不能误判 unsupported/succeeded。
- 失败保留任务。重试必须重新读原渠道的计划，验证 exact version/kind/channel 不变，再次显式确认；新版本替代不被当作“继续原任务”，旧 planId 不重放。成功仅根据 Host 返回的 succeeded，不根据连接中断或时间推断。

## 安全事件 recorder

证据：Web `sync/transcript-diagnostics{,-runtime}.ts`；`RuntimeAPIs.diagnostics.downloadLogs` 是可选本地日志导出，并非 Host CGI。NSH 采用同一 Web event 字段的严格子集，type-only 依赖，不引入 React/IndexedDB/Capacitor runtime。

Web 实际允许少量 user text，且 prerelease 可默认开。本次明确禁止两者，因此 NSH **不复用这两个策略**：所有版本默认关，旧 `nsh.about.snapshotDiagnostics.enabled.v1` 绝不迁移为录制授权；新的设备偏好是 `nsh.about.eventDiagnostics.enabled.v2`。

来源是现有根 observer 已解析的真实 `global/chat` runtime events，前提是 main 完成上面的一行 sink 扩宽。覆盖 session/message 结构变化、execution/step/tool 终态、权限/问题生命周期、重连和已列出的 Yuri revision/联系会话事件；delta/token 与未知类型丢弃。报告明确标 `coverage: runtime-global-and-chat-events-content-free`，不伪造 NSH 尚无采样源的 Web transcript canonical diff、durable hydration、task row/click 或 FPS/perf facts，也不是任意原始日志 dump。

每条只含 `at/feat:'transcript'/kind:'sse-event'/source:'sse'/sseType/sessionID/surfaceKind:'global'|'chat'`；报告外层沿用 `schema:'yuri.client-diagnostics.v1'/exportedAt/eventCount/feats/events`：

- `sseType` 是固定 allowlist；`sessionID` 为本 Host/lease 内的匿名 ordinal `session-1…500`，容量满后用 `session-0`。原 session/event/server/Host ID、directory/transport URL、原始异常和任意文本都不进入事件或文件。
- **绝不记录** user/assistant/system body、标题、prompt、reasoning、工具入参/结果、附件/文件内容、credential、password/token/cookie/pairing 值。不是先 stringify 后 regex 脱敏，而是固定字段投影；Native 再次 exact-key/type/enum 校验全批，坏行使整批不落入 ring。
- disabled/不合 scope/未知类型在读 body 前直接退出。100,000 次 delta 的 operation-count 回归要求 body reads=0、append calls=0；每事件无 catalog scan/serialize。
- 单 root、单 in-flight append；JS 等待队列最多 128 条、每批最多 32 条，背压丢弃计数随批传给 Native。匿名 map 最多 500 项。Native circular ring 最多 500 条和 256 KiB；报告最多 512 KiB。ring/queue 超限丢旧保新，`dropped` 显示容量造成的丢弃。事件仅存内存，重启不恢复；Host 失效或关闭录制立即清除并换 lease，不能混入另一 Host。
- append 失败使该 lease 停录，不生成自递归 error 事件或 retry loop。显式状态刷新/回前台可恢复。native callback错误字符串不进入状态或导出。

### Native capability wire

| call | 精确输入 | 输出/authority |
| --- | --- | --- |
| `native.clientMetadata` | 无 | 原 `{schemaVersion:1,version,build,updates:{status:'unsupported',blockers:[…]}}`；来自 Bundle |
| `native.diagnostics.status` | 无 | `{schemaVersion:2,mode:'event-recorder',enabled,recordingLease:string|null,eventCount,maxEntries,maxBytes}` |
| `native.diagnostics.setEnabled` | `{enabled:boolean}` | 同 status；正在分享拒绝；新偏好与内存状态一致更新 |
| `native.diagnostics.append` | `{hostID,lease,events,dropped}` | `{accepted:true}`；Swift 检查当前 capture、scope.isCurrent、当前启用 lease、精确白名单；Host/lease 值只用于 admission，不写入报告 |
| `native.diagnostics.export` | 原 `{hostID,snapshot}` | `{outcome:'shared'|'cancelled'|'failed',eventCount?}`；snapshot 仅版本 context；实际 events 从 Native ring 取，JS 不能指定导出事件/文件路径 |

Settings 与根 recorder 共用 lease；显式导出先 drain 已排队的安全事实，再交 Native 创建报告。空报告显示现有十语 `diagnostics.toast.empty`，不能把没有事件称为已有日志。所有 UI 文案复用正式十语字典，本次未新增字典 key。

## 分享生命周期

`NativeDiagnosticsShare` 是真实 UIKit bridge 使用的 Foundation lease owner，不是测试里重写算法。`UIActivityViewController` 的 completion/error、取消、Host fence/原生 invalidate、呈现失败统一 finish；仅 OS completed 且 scope 仍 current 才返回 shared。文件自创建到真正分享 completion 保持可读，未因点击导出就提前删除或宣告成功。ticket 保护重复/迟到 completion 不能 settle 两次。

随机自有临时目录 0700、固定文件名 0600、iOS complete protection；JS 不得到路径。finish 清理 lease，清理失败返回 failed；deinit 再尽力清理自有目录。不跟踪/删除用户在其他 App 保存的外部副本。Foundation 回归验证数据白名单、全批原子性、容量与顺序、stale lease、分享三种终态/Host fence/重复 completion 和真实文件清理；SDK typecheck 不等于 UIKit 已实跑。

## 客户端更新外部先决条件 / 不能宣布完整 1:1 完成

客户端只展示实际 Bundle metadata，允许显式重新读取。没有伪造 `check/update/download/install succeeded`，没有调用 Capacitor/Capgo，没有把 disabled 按钮当作已完成能力。

仍须提供并验证：NSH 实际发布身份/签名/installer 或 TestFlight 渠道、可信更新 origin/manifest 与验证公钥，以及该 NSH 产物的版本/兼容门禁、manifest 验签、原子安装/失败回退和启动健康确认。当前没有已验证平台目的地，故不能编造 App Store/TestFlight URL 或把其他壳的 OTA 当作 NSH。Beta 选择/回滚、客户端安装仍未完成；不能以 metadata 刷新等同更新能力。这些不得通过猜 ID、发布/下载实际产物来绕过，本任务禁止真实执行。

## 允许的验证 / main 后续

```sh
node packages/nsh/tests/settings-about-check.mjs
NSH_BIN=/path/to/nsh node packages/nsh/tests/settings-about-check.mjs --bundle
./node_modules/.bin/tsc --noEmit --project packages/nsh/tsconfig.json
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/settings-about-core.test.ts packages/nsh/settings-about-update.test.ts packages/nsh/settings-about-diagnostics.test.ts packages/nsh/settings-about-fixture-host.test.ts packages/nsh/settings-about-native.test.ts packages/nsh/settings-about-locale.test.ts
```

bundle 使用随机自有临时目录并清理，不写 main 的 build 输出。Foundation fixture 不使用 UIKit、Host、网络、Keychain 或设备；Swift SDK typecheck 只编译本 bridge。main 如获准且 engine 窗口空闲，可显式运行 `NSH_ABOUT_ENGINE=1 … vitest … settings-about-engine.test.ts`；它也只使用合成 Host。还需 main 将 root/capability 接上后验证真实全应用默认关/切 Host/后台恢复，不可复制 fixture 监听替代生产事件来源。

本轮未运行 NSH engine、UIKit、main build、设备、真实 Host、网络请求、Git、依赖安装、更新/签名/发布/下载安装。无实际下层派发工具，未声称独立 agent review。

本轮最后验证：**51 passed，1 项 engine skipped**；独立 About tsc、42 源文件静态 bytecode bundle 边界、Foundation recorder/真实临时文件生命周期、iOS Simulator SDK 的 bridge typecheck、Settings UI audit 均通过。`bun run dead-code` 已检查，本 scope 剩余 unused 为独立 fixture 和等待 main 装配的 root adapter；移除了不必要的公开 parser/type exports。整包 tsc 曾通过；最后一次被其他 owner 的 `composer-reference-keyboard.ts` 六处泛型错误阻塞，未有 About 错误，未越权修改。
