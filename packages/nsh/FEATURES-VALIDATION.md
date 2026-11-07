# Native Bot / Task 编辑器：实现与证据

日期：2026-11-07。范围为 `features.tsx`、`features-cron*` / `features-schedule-date.ts`、features 专属 fixture/tests 和本记录；后续按 main 明确授权新增独占 `ios/ScheduleDateBridge.swift`。未修改 application、state、settings、assistants、schedules、其他 iOS 文件或共享词典；无依赖增补、git/GitHub、真实配置/Host/模型/语音操作。

## C / F / H / S / D

- **C**：下面所述生产代码已经实现；独立 NSH fixture bundle 构建通过。
- **F**：最新 18 项纯 Node Vitest 通过，专属tsc和Foundation-only Swift typecheck通过。它们**不是 NSH 渲染器**，不证明 reactive header、手势、UIKit 或 QuickJS Intl 的运行结果。12/13项早期运行与main的UI失败回报按时间保留在下面追记。
- **H**：真实 Host 未测。
- **S**：UIKit 模拟器未测，未运行任何 NSH engine test / UI Vitest、未安装或启动模拟器。唯一获 main 新增授权的 NSH 操作是独立入口 build，不是 production build。
- **D**：真机未测。
- 已先检索下层工具：当前工具目录只有模型查询等 OpenCode 工具，没有 spawn/delegate/explore/session-message；没有派出或口述冒充派出下层。

## 真实 Web 对照与当前实现

对照 `AssistantsSettingsPage.tsx`（settings draft 与 PATCH、catalogDirectory、默认模型与首名称）、`MobileAssistantSettingsPage.tsx`、`ScheduledTaskEditorDialog.tsx`（goalEnabled、日期/时间、cron）、`ScheduledTasksDialog.tsx`（dirty 离页）、`lib/cron.ts`、`lib/scheduledTasksApi.ts` 和 Host `scheduled-tasks/routes.js`。

| 能力 | C：本轮结果 | F | H/S/D |
| --- | --- | --- | --- |
| Bot 字段归属 | 创建/PATCH body 均不写 agent/mode；Bot 模型区不显示 Agent，也不额外 GET Agent | 确认保留后台字段的 PATCH body；保留 variant/workspace/expectedRevision | 未测 |
| Bot 模型上下文 | 使用草稿显式 workspace，否则原 Bot managedWorkspacePath，否则 null；null 时省略目录 query，绝不回落首项目/effectiveWorkspacePath | 托管/显式/null 三条路径通过 | 未测 |
| 模型目录失败 | 刷新开始不清 providers/agents/partial；失败和坏 envelope 保留旧有效快照，显示错误；成功空集合才清空；sequence/Host fence 拒绝旧响应 | 保留引用、部分状态、失败/畸形返回、较早完成、成功空集合通过 | 未测 |
| Task Goal | 真正 Switch 读取/修改 execution.goalEnabled；保存显式 true/false，关闭旧 true 不会被 spread 恢复 | 关闭 true → 保存 false 通过 | 未测 |
| 保存/删除 fencing | 确认响应 + Host fence 后、任何 refresh 前调用 noteScheduledCatalogWrite；保存核对任务 ID，删除核对剩余 tasks 不含被删除 ID | 保存/删除先 invalidate 再 refresh；取消删除不发写；旧 Host 不 commit 通过 | 未测 |
| 提交后同步失败 | schedulerSynced:false 仍 committed；锁住写按钮和核心重复写；Done 只重读，不重建/重删/重跑 | 重按 Save 不重复 PATCH，Done 只刷新通过 | 未测；精确说明需 main 接线，见下 |
| 原生 header | 两编辑器 headerBackTitle=""；每个编辑器只有一个 headerRight Save，移除长页末尾重复 Save，末尾保留 Cancel/Delete/反馈 | 回调测试通过；header实际可见/布局不由纯测试证明 | 未测 |
| dirty Back/Cancel | 比较实际可编辑 draft；busy/确认中/dirty 设置 popOnBack=false、popOnSwipe=false；Back/Cancel 原生确认，只在明确 Discard 后 onDone；已确认提交不再作为 dirty | 取消离页保留稿，随后保存仍发原稿；Task 明确丢弃才离页通过 | 未测；不宣称交互式返回手势可弹确认 |
| 日期/时间 | 一次日期采用 NSH DatePicker，时刻采用 TimeField minute/h23；新任务日期/时区采用系统本地值；多个时间、去重排序与 weekly 保留 | tsc/bundle通过；实际 picker 交互未测 | 未测 |
| 时区 | 同 Web 当前能力保留文本时区字段，不伪造 IANA picker；cron 使用输入时区计算、locale格式化 | UTC/纽约/上海纯解析结果对照 Web 通过 | 未测 |
| cron | 复用已安装 cron-parser 的真实 CronExpressionParser；与 Web 相同五个示例、完整语法校验、四次运行预览；进入 cron 时填 Web 默认 0 * * * * | 宏/命名星期/范围/L 与 Web 语法、纽约DST预览逐值一致；非法表达式不发写 | 未测，QuickJS Intl 必须由 main engine验证 |
| Token budget | 没有新增控件/字段。真实 Web 当前 execution 只有 goalEnabled，不因词典中有 budget 文案而虚构协议 | 代码对照 | 不适用 |

## cron barrel 故障与修复证据

main 首轮串行验证报告：直接从 Web `lib/cron.ts` 导入，会经 cron-parser 的 CommonJS barrel 装载 CronFileParser → fs，导致所有加载 features 的 App/Bot bundle 报 `nsh has no module fs`。该失败是真实故障，不计作通过。

现为：

```text
features.tsx → features-cron.ts → features-cron-parser.js
  → 已安装 packages/ui/node_modules/cron-parser/dist/CronExpressionParser.js
  → CronFieldCollection / CronExpression / CronDate / fields / random / Luxon
```

- `features-cron-parser.js` 是真实静态 re-export，不是动态 require、运行时兜底或 Node 模块 stub。
- 相邻 `.d.ts` 仅 re-export 同一实际 class 的 package canonical public types；没有 ambient declare、ts-ignore 或伪造 fs/native 模块。
- 因该依赖已由 UI 安装，桥接显式使用现有安装位置；未新增 NSH dependency，也未复制实现/自行发明 cron 算法。
- `features-cron.ts` 只封装与 Web 相同的 parse/options/next 与五个示例。Node 回归逐项对照 Web，防止方言/时区计算分叉。
- 独立 fixture build 已实际完成，无 fs 或 native missing；**build 不执行所有 Luxon/Intl 分支**，不能把它当作运行证明。
- `features-ui-test-app.tsx` 的 Task fixture 使用 `0 9 * * MON-FRI` + `America/New_York`；`features-ui.test.ts` 等待实际 Next runs，以便 main 在串行 engine 窗口捕获 Intl 缺口，不能只 mount daily 空表达式绕过。

## 实际运行

```sh
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/features.test.ts
# 1 file, 12 tests passed；纯 Node，无 NSH engine

./node_modules/.bin/tsc --noEmit -p packages/nsh/.nsh/features-tsconfig.json
# passed；临时专属配置 include features.tsx / features-cron.ts / features-ui-test-app.tsx

# packages/nsh 工作目录，NSH_BIN 为 main 提供的已安装 0.4 工具
"$NSH_BIN" build features-ui-test-app.tsx --release --out .nsh/features-test-bundle
# passed；4.5 MB js / 2.9 MB bytecode；最后一次构建 280ms

bun run dead-code
# completed，非阻断；已查 report，features-ui-test-app.tsx 被标 unused（它是CLI test入口），不因此删除。
```

全包 `tsc --noEmit -p packages/nsh/tsconfig.json`：第一次通过；最新一次被并行工作的 `new-session.ts:157/174/180/182`（string|undefined 与 Receipt narrowing）阻塞。features 专属 tsc 此后通过；本 worker 未修改该文件，不将旧的全包通过冒充最新结果。

没有运行 `features-ui.test.ts`、其他 UI suite、`nsh test`、production App build、ios build、模拟器、浏览器或真实 Host。它们全部交 main 串行执行。

## main 的精确接线

### 明确显示 scheduler 同步未完成

TaskEditor 已接受可选 `syncPendingDescription: string`，成功写入但同步失败时追加显示；当前未传时仍是已有的 Saved + Schedule · Error 文案，**不能声称该降级文案已足够清晰**。共享词典只能由 main 修改，请添加：

`sessions.scheduledTasks.editor.toast.schedulerSyncPending`

并在所有生产 TaskEditor 调用传入：

```tsx
<TaskEditor
  item={route.item}
  onDone={() => nav.pop()}
  syncPendingDescription={t('sessions.scheduledTasks.editor.toast.schedulerSyncPending')}
/>
```

| locale | 完整翻译 |
| --- | --- |
| en | The change was saved, but scheduler synchronization did not complete. Do not submit it again. |
| zh-CN | 更改已保存，但调度器同步未完成。请勿重复提交。 |
| zh-TW | 變更已儲存，但排程器同步尚未完成。請勿重複提交。 |
| ja | 変更は保存されましたが、スケジューラーの同期は完了していません。再送信しないでください。 |
| ko | 변경 사항은 저장되었지만 스케줄러 동기화가 완료되지 않았습니다. 다시 제출하지 마세요. |
| fr | La modification a été enregistrée, mais la synchronisation du planificateur n’a pas abouti. Ne la soumettez pas à nouveau. |
| es | El cambio se guardó, pero no se completó la sincronización del programador. No lo vuelvas a enviar. |
| pl | Zmiana została zapisana, ale synchronizacja harmonogramu nie została ukończona. Nie przesyłaj jej ponownie. |
| pt-BR | A alteração foi salva, mas a sincronização do agendador não foi concluída. Não a envie novamente. |
| uk | Зміну збережено, але синхронізацію планувальника не завершено. Не надсилайте її повторно. |

不造 sync/retry endpoint。Done 只是刷新/离开，不表示 scheduler 已恢复；Host 当前没有独立公开的同步重试接口。

### main 串行 engine / UIKit

```sh
./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/features-ui.test.ts
```

该新 fixture 只验证 dirty Back/Cancel、托管目录/不读取 Agent，以及实际 cron Next runs；host fixture 禁止所有写请求。header Save 的布局/触区、实际保存删除与 scheduler 恢复仍需 main 的生产入口及 UIKit/Host 专项。不能以 worker 的回调测试代替这些检查。

## 全量剩余缺口（不删减范围）

1. **新建默认值尚未 1:1**：Web 首个 Bot 名称为 Yuri，模型优先 settingsDefaultModel、随后当前内存选择/OpenCode默认、最后首可用模型；Native 当前新建仍空名称/模型。已核对真实源码，但本轮未猜测 Web 的内存选择，也没有用首项目/首Bot列表空值冒充权威。需要 main/后续提供真实创建上下文及新任务模型/Agent默认值。
2. **明确同步失败文案待 main 接线**。Host 同步恢复、删除最后一个任务、网络未知结果、冲突后的权威恢复均需真实 H/S/D；本轮没有自动重放写。
3. **模型目录完整交互仍未同 Web 对帧**：Native 是 Provider/Model/Variant 多字段，尚非 Web ModelSelector 的品牌/搜索/分组完整呈现。切换目录失败时保留旧快照并显示错误，但尚未提供逐目录历史目录选择体验；服务端仍校验模型可用性。
4. **dirty 支持边界**：已实现 Native Back/Cancel 明确确认；dirty 时返回手势关闭，而不是伪称拦截手势弹确认。外部强制 nav reset、Host 切换、进程退出的草稿持久恢复不在这次编辑器本地 guard 的证明范围，仍需整体生命周期方案。
5. **日期/时间 picker 的 UIKit/大字号/键盘/读屏/深浅色/10语言视觉与触控未测**。cron 完整 parser 已无 fs闭包，但 QuickJS Intl 的 formatToParts/时区/DST 实际运行、预览渲染及解析异常呈现仍要 main 跑新 UI fixture，再做 UIKit专项。
6. **Web完整二级编辑交互与异常**仍需生产逐项验收：新建/更新/删除、409 revision对照与明确重试、刷新失败后的 Done、busy 时离页、嵌入渠道 children 的生命周期以及关联详情返回收敛。不能因纯测试、tsc 或独立bundle通过宣布全量完成。

## main 串行回报追记：features UI 第 13 行

main 实际运行报告：原始生成的 `.nsh/test/features-ui-test-app.tsx.steps.test.ts:13` 得到 expected false → true。已读原步骤：

```ts
await app.back();                                  // line 11
expect(app.shows('id:features-bot-name')).toBe(true); // line 12，已通过
expect(app.host.calls().some(call =>
  call.data?.path === '/api/config/catalog/providers?directory=%2Fmanaged'
)).toBe(true);                                     // line 13，实际失败处
```

因此**不能将这个失败归因于 dirty Back 弹走页面**。当时仍在 Bot editor 与第12行一致。尚未有证据区分外置 `--web-host` 调用未进入 `app.host.calls()`、其记录结构不符，或请求实际目录不符；先前直接依赖该审计数组的断言不足以定位。

核对安装版 `nsh/test.d.ts:297` 和当前 NSH 文档：`app.back()` 是用户返回路径，受 popOnBack 控制；被阻止时询问页面，触发 onBackPress。它不是强制 `nav.pop()`，也不证明 UIKit交互式 swipe。生产页保持 dirty/busy `popOnBack=false` / `popOnSwipe=false`，onBackPress 仅在 blocked 时走确认；本次没有无证据改动生产离页逻辑。

修订后的验收没有删除或弱化保稿：

1. 外置只读 fixture-host 只接受 `/managed`、`/first-project` 两个**完整精确**模型目录 URL，并在真实 catalog 响应 provider 名字中分别返回 `Managed directory verified` / `Task directory verified`；UI 等待实际选中 provider 的这些文字。错误路径不会得到同一个宽松成功 catalog。
2. Agent 只允许任务的 `/first-project` 精确 URL，Bot 托管目录 Agent 会明确报错；纯生产回调测试仍检查 Bot 不 GET Agent。所有非 GET 的 runtime.request 继续直接抛错，未开放任何真实写。
3. Back/Cancel 后除仍在编辑器，还断言输入值完全保留、原生确认 dialog 数量恰好增加一次；显式 Discard 才返回 root。不能以“返回被静默忽略但没有确认”混过。
4. 移除依赖不明外置 audit 数组的断言，改以上真实 Host响应契约；可选 `FEATURES_HOST_TRACE=1` 只输出一次中性 fixture 的审计记录，供 main 定位 records 是空还是形状不同，不影响验收结果。

main 下次串行命令：

```sh
FEATURES_HOST_TRACE=1 ./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/features-ui.test.ts
```

若仍失败，精确 probe：请求标记未出现时保留 screen/error 与 `[features-host-probe]`；若保稿/确认计数失败，给出失败步骤、`app.value` 与 `app.dialogs()`，再区分真实 pop gate/onBackPress 问题。**本 worker未自跑 engine/设备。纽约 cron 的原运行尚未到达，明确仍未通过**；需本次走到 Task 的 Next runs 才有运行证据。

本次补充修订实际仅运行纯 `features.test.ts`：**13 tests passed**（包含外置 fixture-host 的精确目录响应与 POST/PATCH/PUT/DELETE 全拒绝）。没有运行修订后的 UI测试，不能写已修复通过。

## main 第二次串行回报：纽约 cron 没有 Next runs

实际回报：dirty/确认/目录已通过，Task 的 Cron、Examples、Provider 正常，但 `Next runs` 等待5秒失败。该轮已经到达纽约 runtime，**预览仍未通过**。原实现 `getNextRuns` 与 `formattedRuns` 两层 `catch → []` 会同时隐藏 parser/Luxon/Intl 异常。

### 目前知道什么、不知道什么

- 已核对安装的 cron-parser 5.5.0 `CronDate.js`：`tz` 交给 Luxon `DateTime.fromJSDate` / `setZone`。Luxon 3.7.2 `IANAZone.isValidZone` 通过 Intl 验证且会吞掉原始异常，随后 CronDate 只抛 generic unhandled timestamp。
- [NSH 官方 Intl 限制](https://github.com/longbridge/nsh/blob/main/website/modules/globals.md)：无时区数据库，只支持设备时区、UTC、固定 offset；其他 IANA 名称抛 RangeError。这是明确库能力差异，不能给纽约任务换成 UTC/固定全年offset。
- **当前引擎的完整实际异常尚待 main 跑下面 probe 捕获**。这里只能记录上面的实际症状及源码/文档证据，不编造一条实际运行的 RangeError 文案或堆栈。

### 已实现的异常闭环

`features-cron.ts` 增加 `CronPreview` success/failure union，失败包含 `stage/name/message/stack/previous`；parse、next[index]、format 分开。若 Luxon 在parse吞掉Intl异常，再直接检查同一时区的Intl，并同时保留原始CronDate外层异常。`getNextRuns` 不再把异常变成空成功。

TaskEditor 在预览加载时显示 Loading，最终失败把完整链渲染到 `features-cron-preview-error`；没有静默降级或虚构 None。只有得到四个真实结果才挂载 `features-cron-next-runs` 和四行 `features-cron-next-run`。UI验收仍等待成功标记并断言四行，不因标题/Loading出现就算通过。

### 最小无Host探针

`features-cron-probe.tsx` 固定时间 `2026-03-07T15:00:00Z`，分别记录 system.resolvedOptions、UTC/固定offset/纽约的 Intl.formatToParts、parser.parse、next、完整preview。每个步骤独立捕获完整异常，不因前面失败跳过后面；无Host/网络/用户配置操作。

main 在 `packages/nsh` 串行：

```sh
"$NSH_BIN" test features-cron-probe.tsx <<'EOF'
await app.waitFor("id:features-cron-probe-report");
console.log("[features-cron-probe]", app.texts().join("\n"));
EOF
```

注意 probe 的固定offset是分别检查 Intl 和 parser 的真实行为，不预设二者接受相同语法；Luxon固定区语法与Intl offset语法本身也可能不同。真实异常必须保留在报告，不以probe命令退出0冒充全部能力通过。

### 原生窄契约与生产接线

新增独占 `ios/ScheduleDateBridge.swift`，只读 `schedule.dateContext`：

```ts
// request，四个字段完全匹配；数字为整数epoch milliseconds
{ hostID: string, timeZone: string, startMs: number, endMs: number }
// response
{
  schemaVersion: 1, hostID: string, timeZone: string, startMs: number, endMs: number,
  transitions: Array<{ atMs: number, offsetSeconds: number }>,
  anchor: { timestampMs: number, era: number, year: number, month: number, day: number,
            hour: number, minute: number, second: number, weekday: number, offsetSeconds: number }
}
```

- 范围 `[startMs,endMs)`；首条 `atMs === startMs` 表示该瞬间真实offset，后续严格递增，不跨界猜offset。单次最大64×366天、最多1024条；无效字段/时区/范围/非递增transition/过期Host明确throw。
- Offset/transition来自 Foundation `TimeZone`，anchor来自 Gregorian `Calendar` + 同一时区；服务端不读或解析cron，不创建调度、网络或凭据。
- JS `features-schedule-date.ts` 校验scope/schema、完整转换表及Calendar anchor，将真实offset表作为 Luxon ZoneLike 交给**原cron-parser**；无自造cron方言或调度算法，无全局Intl/Settings修改。
- `features-cron-parser.js` 提供真实静态adapter函数 `parseWithDateZone`。cron-parser的TS tz类型只列string，但已审安装源码：tz原样进入Luxon的ZoneLike，`normalizeZone` 接受offset-bearing对象。该版本依赖路径用真实parser回归，不能在升级依赖时假定继续成立；没有ambient declare/native stub/TS强转掩盖缺失能力。
- NSH格式化按每次真实发生时刻的offset调用固定offset Intl，**不是用一个offset覆盖全年**；跨DST每次分别读取权威数据。覆盖不足会扩展native范围并从同一个currentDate重新计算，失败保留完整异常链，绝不猜范围外offset。遇到次分钟offset等格式能力缺口仍显式失败，不造成功。
- TaskEditor effect按输入/语言/Host重算，旧attempt/Host/卸载响应不提交；UTC/GMT固定零偏移且direct路径成功时无native调用。命名IANA始终使用Foundation，即使它恰好等于设备时区、direct暂时接受，也不把“未抛错”当完整tzdb/DST正确性证明；direct有异常时保留完整原始链，direct无异常则不伪造异常。

main 独占文件必须接两处：

1. `nsh.json` capabilities.host 加 **`schedule.dateContext`**。
2. `ios/main.swift` 保留 `private var scheduleDate: ScheduleDateBridge?`，在已创建RuntimeBridge的分支注册：

```swift
let scheduleDate = ScheduleDateBridge(app: surface, capture: { [weak bridge] in
    guard let bridge, let hostID = bridge.store.selected?.id else { throw CancellationError() }
    let transport = try bridge.resourceTransport()
    return ScheduleDateScope(hostID: hostID, isCurrent: transport.isCurrent)
})
self.scheduleDate = scheduleDate
```

桥接是无状态本地计算，调用前后检查capturedScope.isCurrent；没有待取消的网络/缓存，不需要额外onInvalidate副作用。`build-ios.mjs` 已动态收集ios/*.swift，无需手写来源列表。本worker未改main/nsh.json，未做iOS production build。

### Foundation真实capture → headless验证，不能手填DST

`tests/features-date-capture.swift` 只调用上述真实Foundation service。捕获纽约2020–2050规则；同时核对Kathmandu非DST政治offset、Apia跳日、Lord Howe半小时DST的表查值与Foundation直接查值。任何漏转换直接失败，不把方法名字里的daylightSaving当完整性的证明。

`tests/features-date-host.mjs` 由这个真实capture生成无import headless host：只对capture涵盖的请求切出精确转换表，未知范围失败。原fixture-host的全部写请求禁止保持不变。生成过程不计算cron、不手写纽约规则。

main 在仓库根执行（先加capability）：

```sh
swiftc packages/nsh/ios/ScheduleDateBridge.swift packages/nsh/tests/features-date-capture.swift -o packages/nsh/.nsh/features-date-capture
packages/nsh/.nsh/features-date-capture > packages/nsh/.nsh/features-date-capture.json
node packages/nsh/tests/features-date-host.mjs packages/nsh/.nsh/features-date-capture.json packages/nsh/.nsh/features-date-host.js
FEATURES_DATE_HOST=.nsh/features-date-host.js FEATURES_HOST_TRACE=1 ./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/features-ui.test.ts
```

原 `tests/features-host.js` **不预置假的日期服务**；未提供capture/缺capability时生产会明确显示native-context失败，并附原始Intl/CronDate异常。不可用默认Host重跑失败后把它误诊成又一个算法故障。

### 本worker验证与剩余边界

- 18项纯Vitest通过：包含完整异常链、拒IANA Intl条件下真实parser+ZoneLike的DST结果/格式与Web逐值一致、遥远闰日覆盖扩展、坏context显式失败。这里的DTO seam数据明确是unit fixture，**不作为Foundation/QuickJS运行证据**。
- features专属tsc通过；Swift核心+capture的Foundation-only `swiftc -typecheck`通过，UIKit/NativeShell条件编译块不在此检查范围。
- 独立features UI fixture与原始cron probe bundle通过；仅build，不是engine运行。
- main还必须跑原始异常probe、真实Foundation capture、capture驱动UI，以及注册后的production iOS build/实际UIKit预览。完整纽约runtime本轮仍未绿，H/S/D不变。

## Main 引擎复验追记

- 原始 QuickJS probe 已实际执行，证据在 `.scratch/nsh/features-cron-probe.log`。纽约 Intl 明确抛 `RangeError: Invalid time zone specified: America/New_York`；直接 cron-parser 抛 `CronDate: unhandled timestamp`。UTC/固定offset成功不能替代纽约时区。
- 已编译并运行 `tests/features-date-capture.swift`，使用 Foundation 生成真实转换数据，再由 `features-date-host.mjs` 生成隔离 fixture；没有手填 DST 表或访问真实 Host。
- `schedule.dateContext` 已加入生产 capability 并在 `ios/main.swift` 注册 captured scope。
- 带 `FEATURES_DATE_HOST=.nsh/features-date-host.js` 串行执行 `features-ui.test.ts`、`appearance-settings.test.ts`、`settings-outer.test.ts`、`chat-header-ui.test.ts`：**4文件15项通过**，包含四个实际 Next runs、dirty 返回保稿及真实目录/model/variant/Agent选择。
- 此结果是 Foundation capture 驱动的真实 QuickJS 引擎，不是生产 UIKit/Host/真机证明；注册后的 iOS build 与 UIKit 运行仍需另验。

### 默认测试装配修正

`features-ui.test.ts` 未显式设置 `FEATURES_DATE_HOST` 时，现在会在独立临时目录编译现有 Foundation capture、运行捕获并生成 import-free Host，再运行原有四个 Next runs 和离页保稿断言。显式 Host 参数仍可覆盖；捕获、编译或生成失败会使测试失败，不退回缺日期服务的默认 Host，也不跳过用例。临时目录在测试结束后清理。

2026-11-07 此默认命令已实际执行：**1 file / 1 passed**。该变更只修复测试装配，没有修改生产日期、时区或 cron 算法。
