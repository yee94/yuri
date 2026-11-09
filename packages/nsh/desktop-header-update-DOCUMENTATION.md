# Header / About 共享更新源

## 本轮边界与证据

- Web `ConnectedHostVersionUpdate` 与 `AboutSettings` 都消费同一 Host update query；客户端更新另外由 `useUpdateStore` 管理。NSH 不复制 Web 的客户端 updater。
- Rust `desktop-host/src/appearance.rs` 的 metadata 明确为 `updates.status: unsupported`，列出签名产物、可信 origin、manifest verifier、原生安装 lifecycle 缺口。当前 native bridge 也没有 Host 更新来源 admission。HTTP `/api/system/update` 存在或 `supported:true` **均不构成 native update grant**。
- `settings-about-core.ts` 仍是唯一版本、更新计划、任务、prepare/confirm 与 unknown receipt owner；新增两消费者可订阅和 await 的 status single flight，不创建另一 reader/store/updater。
- 本轮只改 `settings-about*` 与 `desktop-header-update*`。application / Header runtime / Settings route 透传由 main 装配，未在此宣称已接 actual root。

## main 冻结 API

```tsx
import { createNativeDesktopHeaderUpdateRoot } from './desktop-header-update-root';

const update = createNativeDesktopHeaderUpdateRoot({
  current: () => windowAlive, // 只表示窗口 lifetime，不混入 modal/foreground
  committed: () => committedHostDescriptor(), // {host:{hostID,lease},authorityKey} | null
  operation: () => originalHostOperation(), // main 原有 adoption effect 更新的 signal
});

// main 原窄 Host/lifecycle effect 在更新原 operation 后调用；零 I/O。
update.reconcile();
// Header 始终拿同一个稳定 port，不能在 render 时复制 owner/source。
<NativeDesktopRuntimeHeader update={update.port} /* 原 props */ />;
// Settings 四层透传到最终 About；用 getter 避免初始化顺序/过早捕获。
const aboutOwner = () => update.about();
// 已注入桌面 root 时，undefined 代表暂停/authority 阻塞，不是许可建私有 owner。
<If when={!!aboutOwner()}>
  <SettingsAbout owner={aboutOwner()} active={active} target={target} />
</If>;

// 原 native close ticket 的最后同步终验；纯 guard，绝不 dispose 作探测。
if (!update.canClose()) return false;
// 只在真实 teardown 才调用；false 仅撤销 callback，保留旧 entry/锁。
if (!update.dispose()) update.retire();
```

root 冻结返回值为 `{ port, about(), reconcile(), canClose(), dispose(), retire() }`；没有新的 PageOperation、support bool、Host request sender、source registry 或原生能力。`about()` 和 `canClose()` 通过极薄 NSH signal 订阅 **现有 controller** 的状态/实际 in-flight 结算，不另读网络；source 释放后取消订阅。root constructor 不调用传入 getter，不创建 source、不请求；首次已知合法非空 committed descriptor 才构造一个 owner。稳定 source identity 是 `hostID + authorityKey`，authorityKey 必须来自当前 committed origin/auth，不能是路由或菜单选择。

相同 identity 的 lease 更新只更新原 operation，保 prior/controller；operation=null 暂停、null committed 暂时不对外返回 About，均不永久退休 source。恢复只消费 main 给出的原 operation；operation.scope 与 committed host/lease 不符即读不可用。Host/origin/auth 真正变化先调用旧 source 的安全 dispose；false 就仅保留那个旧 entry 和全部 guard，不创建新 source，`about()` 对新 authority 返回 undefined，Header read 明确失败。它不是一个跨 Host registry。旧 identity 若重新成为 committed，可用新原 operation 恢复同一个受锁 owner并显式只读核验。

**透传约束：**main 若已配置 root，却得到 `about()===undefined`，不要把 undefined 默默传给 `SettingsAbout` 的 iOS 私有默认分支；保留既有 unavailable 呈现/等待 owner。没配置 root 的 iOS 才继续不传 owner。Host 切换仍沿原 Settings route/lifetime guard 退休旧 presentation，不能把新 owner 替换到同一个已捕获旧 controller 的 Settings mount 中。

`createNativeDesktopHeaderUpdateOwner` 不创建 signal、Effect、PageOperation、timer、请求或独立连接。每个请求捕获原 operation 的 native scope，通过既有 `bindRawRequest` 携带 `expectedHost {hostID,lease}`，发出前/回执后均复验 operation 和稳定 Host 身份。native 继续拥有 origin/auth；旧 origin、授权或 lease 的异步结果不发布。null 是暂停 lane，同身份恢复保 prior；Host/origin/auth 变化必须新建 owner，不能复用 `updateOperation` 接管旧状态。

底层 `createNativeDesktopHeaderUpdateOwner` 现在由薄 root 管理，不要求 main 手工维护 identity callback。`operation` 的结构就是原 `captureHostOperation()` 快照；main 在已有 foreground adoption effect 取得它，不要求新增 `createPageOperations`，也不能借 Header 的 modal-active lane 承担 Settings 的读取。root 用独立 admitted guard 复验当前 committed/operation，暂时 unavailable 不会触发底层的永久 identity 退休。

About update 是 Host 全局资源，不拼 directory，也不拿 Chat directory 当更新源。Header 的 exact directory/route/modal fence 由其原 `DesktopHeaderServiceIntent.current()` 双重复验；旧目录的 Header read/push 不能发布到新目录。这个 source 不能替代 Header 原 operation lane。

Settings route 需要的唯一窄透传是 `aboutOwner?: SettingsAboutController`（或等价 slot）→ `SettingsAbout.owner`；不要传合成 support bool、请求 sender 或第二个 PageOperation。`settings.tsx` / `desktop-settings-content.tsx` / root 本轮未改，归 main 与 GitHub bridge worker 协调。

## 读取与呈现

- `update.port.read(intent)` 只调用同一个 `about.hostUpdate()`，返回 closed Host 版本/计划/任务/忙碌/unknown 投影；不读 client、OpenCode 或 diagnostics。
- 两个 consumer 同时读取等待同一 status flight；第二个 consumer 不能立即拿 `refreshing:true` 冒充完成。Settings 首次挂载已有 Header 快照时不重复检查更新；自己的显式 Check/Refresh 继续读取同一源。
- Header 只有 Instance 实际可见才由原 services owner读取；隐藏、Usage、外部模态、后台零请求、零 polling。source 也不在构造或 lane replacement 触发刷新，不依赖 UI 卸载重建刷新。
- 原 Settings 导航/原生关窗 publisher 保留，额外把 `updateUncertain` 纳入 pending。共享 controller 不随 About 关页 dispose；重开保 prior/unknown。显式刷新失败保 prior 且 status 为 failed，不报成功空。
- Settings 既有活动任务轮询仍只属于该 Settings 呈现，Header 本轮没有另起轮询。Header 的 task/plan 是只读快照；跨 Header 的自动进度推送/可执行确认仍未闭合，不能声称完整 updater parity。

若 main 已有 authoritative source push，可在 **Instance 可见期间**调用 `update.subscribe(intent, value => services.projectUpdate(value, capturedHeaderOperation))` 并在关闭/换 Tab/模态/换 lane 时取消；服务端 snapshot 读取和 push 不是新的轮询。不要无条件注册全局 render effect，或把草稿订阅带入 source。`subscribe` 本身零读，仍复验 intent；主装配不需要为了只读投影额外添加它。

## 更新写入与未知回执

- native producer 完全不提供 `submitUpdate`；默认 desktop About 同样不从 `/api/system/update` 路由猜写权限。核心没有 submitter 时连 prepare 都拒绝，不弹一个无法提交的确认框。原按钮/设置锚点保留，显示既有本地化 unavailable，不删除入口。
- Header `nativeGate()` / `available()` 恒 false，`run()` 为 unsupported（旧 intent 为 stale）；明确原因 `native-update-admission-and-confirmation-unavailable`。即使注入一个有 synthetic submitter 的既有 About controller，也不借此宣称 Header 有原生安装许可或 retained confirmation presenter。
- iOS 未注入 owner 的默认流程/确认、原 diagnostics 和三版本保持原路径；测试依赖可注入现有 `dependencies`，没有新增安装/发布授权。
- `about.canClose()`/root.canClose() 同步检查真实 updateBusy、updateUncertain、updateConfirm、diagnosticsBusy、exporting、全部五个资源 refreshing 和 controller 跨 lane 的实际 in-flight 计数。它们不请求、不 reconcile、不调用 dispose。lease replacement 即使已清 UI refreshing，也不能洗掉尚未结算的旧 read/diagnostics/export guard。
- `about.dispose()`/共享 owner.dispose() 在上述 guard 未释放时返回 false，不洗锁。root.disposefalse 只 retire callback、保留旧 entry/receipt，不创建或返回新 source；root.retire 同样不释放 guard。lane replacement 撤销旧请求并保留 unknown receipt，旧 POST finally 不释放新 lane。失效只读结果结算仅清自己的 read refreshing，不发布旧结果或清 mutation/unknown 锁。
- unknown 后只有同 server、同 `planId/version/channel/kind` 的权威 operation 能解除未知；空快照、不同任务、failed GET、缺 planId 都不能证明原 POST 回执，更不会重发。无计划回执的老 Host 将保持 unknown/unavailable，不能靠看到同版本任务猜成功。

## 验证与未验

聚焦命令：

```sh
NSH_BIN=/path/to/nsh/bin/nsh bunx --no-install vitest run \
  --config packages/nsh/vitest.config.ts \
  packages/nsh/desktop-header-update-root-core.test.ts \
  packages/nsh/desktop-header-update.test.ts \
  packages/nsh/desktop-header-update-native-owner.test.ts \
  packages/nsh/desktop-header-update-native.test.ts \
  packages/nsh/settings-about-core.test.ts \
  packages/nsh/settings-about-update.test.ts \
  packages/nsh/settings-about-fixture-host.test.ts
bunx --no-install tsc --noEmit --project packages/nsh/tsconfig.json --pretty false
bun run dead-code
```

真实 NSH 0.4 两平台 headless 场景覆盖：原生 SettingsAbout + Instance、注入的唯一 source、可见读取、50 字输入零新增读取、explicit Check、Settings 关开保源、导航 pending guard、failed GET prior、lease renewal 和 origin/auth 退休。延迟场景使用 Settings 原有可注入 dependencies 及本地 gate；正常场景直接运行新增 native producer/真实 raw binder。全部端口是合成数据，无真实网络或写更新。

薄 root 追加后的最终聚焦 **10 files / 97 tests passed**（上方 About/update 文件、`settings-about-diagnostics.test.ts`、`settings-about-locale.test.ts` 与既有 `desktop-header-services.test.ts`）。root pure 13 项覆盖 inert constructor、空/false 早期未污染、50次零IO、共享flight、暂停/null descriptor/resume、lease保prior、真实authority变更安全释放、pendingread/unknown/confirmation/diagnostics/export close guard、错误scope、拒绝dispose与retirecallback。真实 native bound-root unit 另外验证只传原 operation、准确 expectedHost 与跨lease唯一controller。

native wrapper 内 **macOS/Windows 各 3 场景，共 6 场景通过**；正常场景已改为消费新增薄 root，而非手工持有底层 owner。第三场景使用纯本地 synthetic lost-ACK submitter，零 runtime POST，验证 unknown 跨强制模态 teardown 保留、原导航 guard 持续生效及空状态检查不能洗锁；最终rootdisposefalse只撤callback/保锁，不再允许 About 挂回私有默认源。single-flight pure 还覆盖同步 source subscriber 重入：refreshing 通知前必须先登记 flight。

Settings design audit 在原 slice 通过。薄 root 本轮最后的 **整包 tsc 通过**；上轮遇到的范围外 `desktop-diff-list.tsx:85,99` IconName 阻断已经不在当前 tsc 输出中，本线程没有改该文件。

这些不是 actual `YuriNativeApp` 装配、AppKit/Win32 系统窗口、真实 OS 安装或签名/发布测试。main 的原生 close ticket 终验、真实 Host 来源 grant、Header 原确认 presenter、客户端安全更新仍缺，不得宣称已经完成。

本轮再次执行 `dead-code`，仍被既有 `packages/web/vite.config.ts` 缺 `vite-plugin-pwa` 阻断（exit 2），未补依赖。上轮范围外 `settings-raw-production-recovery.test.ts` VM 的 `nsh` mock 缺公开 `platform`，四个 About 场景 TypeError 的补mock工作已交 main；root 本轮未改或重跑该文件，不声称其当前状态。
