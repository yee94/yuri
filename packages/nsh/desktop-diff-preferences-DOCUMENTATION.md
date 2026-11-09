# 原生桌面 Diff 设备偏好

## 已接内容与边界

`desktop-diff-preferences-core.ts` 是唯一数据/Storage lane；`desktop-diff-preferences.ts` 只加 NSH reactive 投影与一次 root registration。`SettingsPreferences` 与 `NativeDesktopPanel.diffPreferences` 消费同一实例，不逐文件创建 Storage 或在 Settings 再造 singleton。没有修改 application、Host、主 header、close barrier 或 diff reader/document/model。

Web 依据：`useUIStore.ts` 的 `setDiffLayoutPreference`、`setDiffFileLayout`、`setDiffWrapLines` 和 `partialize`。默认 inline / false；layout 和 wrap 是设备本地持久偏好，不写 Host。逐文件覆盖是全局 **exact path** 键（不另加 Host/session 分区），**不在 Web partialize 中持久化**。Native 遵循同样冷启动行为，不能拿 Host 的同名字段当本地初值或写入目标。

## main 精确接线

```tsx
import { bindNativeDesktopDiffPreferences, createNativeDesktopDiffPreferences } from './desktop-diff-preferences';

// 仅当前确实只有一个 Engine 的 desktop root 创建一次。
const diffPreferences = createNativeDesktopDiffPreferences({ coordination: 'single-engine' });
cleanup(bindNativeDesktopDiffPreferences(diffPreferences));
// 可等待 diffPreferences.ready；恢复失败保留原 Storage，Settings 显示不可用/显式重试。
<NativeDesktopPanel diffPreferences={diffPreferences} /* 原 props */ />

// 在已有 root close barrier 接入，而不是在本模块自动安装第二个 close owner：
if (!await diffPreferences.flush()) return false;
// 等其它 owner 异步结束后，批准原生 ticket 前最后同步复验：
if (!diffPreferences.canClose()) return false;
```

`bindNativeDesktopDiffPreferences` 只登记同一个真实对象，重复绑定直接拒绝，不会覆盖旧 owner；cleanup 只撤销自己的 registration。Settings 不需要新 props、第二实例或 root 传给两棵树的并行数据源。root 实际销毁时才可调用 `dispose()`；pending/unknown 时拒绝 dispose。注册不属于跨 Engine 的锁或 grant。

### API ACK、磁盘与多窗口不是同一保证

- `durability === 'storage-api'` 明确限定 `flush()/canClose()`：它们只保证本 Engine 所有已接纳变更的 NSH Storage API lane 已结算，并且无未知写结果。**不是 fsync、断电或立即杀进程后的持久性证明。** 固定 NSH 0.4 的 FileStorage 异步落盘没有可用的错误/磁盘 barrier；不能把 readback 当成真实 native durability。
- 当前生产没有通用偏好 native CAS/sync/跨窗口协调 grant；本切片不创建或假称存在该能力。严格磁盘关窗屏障仍需 owning Host 提供真实能力后另接，不能以此 API lane 放行来声称已完成 crash-safe settings 保存。
- 一旦窗口体系允许多个 Engine 共享同一个偏好存储，必须传 `coordination:'multi-engine'`；当前稳定返回 `supported:false/error:'unsupported'`，零偏好 Storage 读写、无可变 Diff 控件。不能在两个 Engine 各建 `single-engine` owner，再以 JS registry 声称它们同步。该模式尚未完成原生 grant 接线，明确 fail closed。

## 值、失败与容量

- `state()` 为 `{supported,hydrated,reading,writing,pending,error,value}`。`value` 始终是已确认的 `{layoutPreference,wrapLines}`；新候选只在 Storage ACK 或 exact 候选回读后发布，不假成功。
- `preferences(path?)` 为窄只读 `{layoutPreference,fileLayout?,wrapLines}`。panel 使用 source 的真实 path；没有恢复成功则返回 undefined，让现有 Diff 保留真实默认展示，同时不提供可写偏好回调。
- `save({layoutPreference?,wrapLines?})` / `setWrapLines(wrap)` 返回 `Promise<boolean>`。接受的并发更新串行合并，`flush()` 等待队列最新 revision，不只等待第一笔。读失败不是空成功；malformed version/字段/类型拒绝，不覆盖 prior。
- native `available()` 在写入期间撤销 UI 偏好动作，避免用尚未确认的旧 wrap 值接纳重复切换；core 仍可串行处理已显式提供完整目标值的后续 API 请求。
- `setFileLayout(paths,mode)` 原子更新整个去重批次，不读写 Storage。默认最多 4096 paths、512K UTF-16 path units；可在 owner 创建时配置 `fileLimit/pathUnitsLimit`。容量不足拒绝整批、显式 error，**不做 LRU/截断/淘汰已使用偏好**。只在真正改变时通知消费者。
- 单个 v1 Storage key `desktop.diff-preferences.v1` 只存 `{version:1,layoutPreference,wrapLines}`。不保存文件 path、文件正文、Host、凭据或 file override map。
- 提交前先读核验 prior，发现 foreign writer fail closed。Storage 写 reject 是未知结果：只回读 exact candidate；看到 prior 不能当作“绝不提交”的负回执，继续保留 unknown/pending 和 close veto。`retry()/reconcile()` 在 unknown 下都只读、不自动或盲目重发。看到 exact candidate 才解除该笔未知结果。提交前的 GET 失败尚未写入，可显式 retry 后继续原候选。
- 唯一可确认未写的异常是固定 NSH 0.4 公开 `Storage.setItem` 的 `ERR_NSH_QUOTA_EXCEEDED`（本地源码 `nsh-core/src/runtime/storage.rs` 明确保证 value 未设置）。它保留 draft/prior、显示 capacity、拒绝关闭，只有显式 retry 才可重试写；其它错误不猜负回执。unsupported/no accepted changes 的 `flush()` 是无 I/O 的 no-op，不代表获得可写 grant。
- `retry()` 不覆盖 conflict；restore/malformed 只重新读取，容量拒绝只清本次错误；没有自动读循环或 timer。50 次无关输入不会新增偏好读写。

## 实际 Settings 与工作台消费者

原 `chat.diff-layout` 字段改为 desktop device-local consumer；只有已注册、恢复成功的真实 owner 才可编辑。mobile 原字段仍明确 unavailable，不添加页面、菜单或新入口。保存 diff-only 不发 Host PUT、不刷新 Host appearance。混合表单先提交 local 字段，成功才清该字段；失败保留 confirmed prior 与原 draft，不抹掉其它 Host 字段。局部错误有本地 retry，unknown retry 不落到通用 Host reload。

panel 只接一个 `diffPreferences` 窄 port。`onLayoutChange(paths,mode)` 与 `onWrapLinesChange(wrap)` 回到原 owner；读/偏好操作仍服从既有 current、active、模态门禁。`file-diff` 传 `singleFileView:true`，普通 diff 保持原 toolbar；两种工作台都 `showFileSidebar:false`。workspace `onOpenEditor(path,line)` 直接复用已有 `props.openFile` 的真实 path/一基行号，历史不增加 editor 写入口。没有叠加新的 header 控件或另建 reader。

## 验证与未验

`desktop-diff-preferences-core.test.ts` 覆盖 Web partialize 对照、多 scope 设备语义、容量原子拒绝、读失败/malformed restore、迟到 flush 最新 revision、unknown 只读回执、foreign conflict、50 次读取/输入零额外 I/O、multi-Engine unsupported 与 Settings Host patch 排除。

`desktop-diff-preferences-native.test.ts` 用独立临时 nsh.json/App/test，驱动 **生产 SettingsPreferences + NativeDesktopPanel + NativeDesktopChanges/原生 DiffView**：真实 Settings 选择与保存、split/unified 原生正文、逐文件覆盖与 wrap、切 scope、真实 editor 行号、single-file 隐藏 toolbar/sidebar、local failure 保稿/显式 retry、malformed restore、unknown close veto/read-only reconcile、50 次真实 Input 零新增偏好/Host I/O，以及多 Engine 无 grant 零 I/O。只使用合成 Host、NSH MemoryStorage，不运行真实 Host 写入。

这不是 AppKit/Win32 实机、物理键盘、真实磁盘 durability 或多个真实 Engine 的同步验收。主 root close barrier 与生产 registration 由 main 接线；本模块不擅自修改它们。

本轮结果：相关纯回归 **8 文件 / 112 项**通过；生产 Settings/panel 偏好 wrapper 内 **9 场景**通过（另含 mobile 原字段不可用、重复 registration 拒绝、held save/late flush 的 close veto）。偏好、既有 panel、embedded workbench、diff 的 broader NSH wrapper 回归 **4 文件 / 17 项**通过。独立临时 tsconfig 覆盖本切片真实源码与 imports，通过；Settings design audit 通过。全包 tsc 曾通过，最后重跑被并行 `desktop-header-services-view.tsx:28,83` 三处类型错误阻断，未修改该文件。`bun run dead-code` 仍被既有 Web Vite 缺 `vite-plugin-pwa` 阻断，没有添加依赖或假称取得报告。
