# GitHub actual-window root bridge（冻结 API）

## main 的最小装配

```tsx
const github = createNativeDesktopHeaderGitHubRoot({
  committed: () => actualCommittedHostAndLeaseAndAuthorityAndDirectoryOrNull(),
  current: actualWindowIdentityCurrent, // 非 modal/interactive，不能来自旧标签
  operation: actualHeaderPageOperation,
  active: actualHeaderReadDemand,
  interactive: actualHeaderInteractionPermission,
});
const settings = createNativeDesktopSettingsRoot({
  // 保留其余原 options
  desktopGitHub: github.settings,
});
// Header 仅增加窄 port，不改变 Header 所有权。
<DesktopHeaderGitHub port={github.header} onResult={existingFeedback} />
```

实际 `NativeDesktopChatHeaderActions` 可新增 `githubPort?: DesktopHeaderGitHubPort`，将旧 `props.github` 整段 rendering 替换为 `<DesktopHeaderGitHub port={props.githubPort} .../>`（无 port 不画），不要同时保留旧 menu/旧 GitHub settings action。`application.tsx` 的 `requestSettings` 和最终 `canCloseFiles` 都须组合 `github.canClose()`；Host 切换/目录离开准入也检查同一 predicate，不能只在 render 隐藏入口。

`committed()` 返回 `{host:{hostID,lease},authorityKey,directory}` 或 `null`，必须是已经提交并核准的实际 Host/origin/authorization、lease、当前目录；不从旧 tab、recent 或首项目猜测。root 构造零请求。明确首次 Header demand 调 `github.header.ensure()`；只在这些低频语义边界调用，不能跟随 input/draft effect。目录/lease 改变可调 `github.reconcile()`，它只尝试安全交接，不发请求。

Settings 的唯一透传链：`desktop-settings-root.desktopGitHub` → `NativeDesktopSettingsContent.desktopGitHub` → `SettingsPageContent.desktopGitHub` → 原 `SettingsGit` 非 editor 的 `GitHubFragment`。slot 在原 publisher 下构造 registration，使用 **SettingsGit 自己的 `settingsPageLifetime().operation`**，不复用已经被 Settings 模态撤权的 Header operation。原 `SettingsGitHub` 仍持有唯一 controller/OAuth/timer/取消逻辑，不 remount 或换 lane 来制造刷新。

原生窗口 close 与 Host/路由更换必须同步检查 `github.canClose()`；异步其它 guard 完成后再次复验。正常 Settings 导航的 publisher 同时检查 registration 的 busy/refreshing/pending/flow/unknown/removal 等状态；`detach()` 若实际 `registration.dispose()` 返回 false，保留 orphan registration 并使 `canClose=false`，不因 cleanup 被调用就当成释放成功。root `dispose(): boolean` 也必须检查；最终无法阻止的窗口 teardown 只 `retire()` 撤销回调，不声称 pending 已解决。

同 Host auth 是 global resource。root 永远只持一个 source；mounted Settings 或 pending/unknown 时目录/lease/authority 改变均拒绝创建新 source。回到原目录后仍用旧 source/锁与显式 GET 核验。没有安全 source，Header 没有可见入口；桌面 Git 没有注入 slot 时只显示既有 unavailable 文案，不回落私有 GitHub sender。iOS 无 publisher 默认路径保持原组件。

## 共享 status 端口与生产根验证

source registration 现已通过原 `GitHubDependencies.sharedStatus.snapshot/subscribe` 提供共享 status，原 Settings controller 播种并订阅已确认快照。Header 切账号后 Settings 首读失败保留 prior/current 并标 stale；订阅不清 OAuth flow、pending、unknown 或 cleanup 锁，不制造第二 GET 或刷新成功。

原缺口的修复边界：

1. source settings registration 暴露白名单完整 status 的同步 snapshot + subscribe（只在 authoritative adopt 时通知，失败保 prior，不触发网络）；
2. 原 `GitHubDependencies` 支持这条只读 status port，原 controller 在构造时播种并订阅；`adopt` 只变 status，不清 OAuth flow/pending/unknown、不冒充 refresh 成功；
3. 原 controller dispose 撤销订阅，但原未知 receipt/flow close guard 不变。

`application.tsx` 已注入窗口根、真实 Header view 与 Settings slot，离页、Header Host 切换和最终关窗复验同一 `canClose()`。Header operation 委托已确认连接后挂载的原根 operation，并独立撤销模态期间的 Header intent；不能在初始无连接时构造一个永久绑定空 identity 的 PageOperations。生产根的 Header↔Settings 选择、首次 GET 失败保 prior、unknown veto 与 50 输入零额外 status read 已加入实际 App 测试；最新整组结果仍以运行记录为准，端口局部通过不能代签产品根。

## 验证边界

focused core / 真实 NSH headless 用合成 Host、原 `SettingsGit` + 原 `SettingsGitHub` + 原 publisher；网络被 OS sandbox 拒绝，不访问真实账户、OAuth 或执行外网写入。Mac/Win 指 headless 平台分支，不是 AppKit/Win32 视觉验证。生产 App 的最终注入由 main 独占，公共头像加载、真实 OS 窗口和跨 Engine 互斥不在此桥的验收证据内。

已运行：root core 6 项；Mac/Win headless 各 4 场景（单个 Vitest 外壳），原 Header/core + Settings/navigation 回归合计 80 项，`NSH_BIN=… bun run --cwd packages/nsh nsh:check`、`bunx tsc --noEmit -p packages/nsh/tsconfig.json --pretty false` 与四个透传文件的 Settings design audit 均通过。最后对 root core + native 再跑共 7 个 Vitest 用例通过。`bun run dead-code` 已尝试但因仓库现有 `packages/web/vite.config.ts` 缺少 `vite-plugin-pwa` 中断，未加依赖。最初直接运行 `nsh:check` 因 PATH 没有 nsh 失败，指定现有 0.4 binary 后通过。
