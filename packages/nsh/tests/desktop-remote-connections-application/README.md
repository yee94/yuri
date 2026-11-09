# Production App SSH consumer evidence

## 接线

窗口根使用 `desktop-remote-connections-root.tsx`：

```ts
const remote = createNativeDesktopRemoteConnectionsRoot({
  current: () => workspaceAlive,
  runtimeReady: () => workspaceAlive && lifecycle() === 'active' && !closeCommitting(),
});
cleanup(remote.dispose);
// createNativeDesktopSettingsRoot({ ..., remoteConnections: remote.slot })
```

`slot` 始终存在。没有真实端口时，只显示原 SSH 安全说明、禁用的 Add SSH connection、不可用文案和显式 Retry。
它不伪造 registry/snapshot/port，不隐藏区域，也不发 mutation/sync。fallback 登记无 dirty/pending 的 Settings owner；
discovery 是只读，不能据其阻止用户关闭设置。原生 source/window lifetime 退休才永久失效；普通 Settings 关闭不退休已有 controller。

factory 启动时只 discovery 一次；无 timer、无自动无限 retry。首次闭页成功结果仅缓存原 captured port，不创建 controller；
首次显示时复验 readiness 并采用一次。已显示后关闭/切走/ABA 的迟到 discovery 会丢弃 port，不能创建 owner。
fallback 的 Retry 由用户触发重新 discovery；一旦创建 controller，之后永不替换，真实面板的 Retry 继续走原 refresh lane。
dispose 释放缓存端口及唯一 owner，不发原生 cancel/disconnect。

## 测试入口

`desktop-remote-connections-application-native.test.ts` 创建独立临时 `nsh.json`、App 入口与测试文件。
入口只 import **真实产品 `App.tsx`**，不替换 application / SettingsRoot / controller / native loader。
所有页面通过现有 `desktop-settings` 按钮和 `desktop-settings-page:remote-instances` 导航进入。
不占用项目 `.nsh/test`，不修改生产 manifest。

`host.js` 复用既有 production-root synthetic transport，并为六个精确 `desktop.ssh.*` 方法提供严格 metadata-only fake。
SSH caps/read 必须空 DTO，不允许 Host scope、windowID 或凭据；配置读取继续按选中远端 expectedHost 校验，SSH service 身份与之分离。
只允许一次 exact fake save；丢 ACK 后在内存中保留 receipt，恢复只读，不重放。无真实 SSH/Host 写入。

macOS/Windows headless 分别覆盖：

- 异步发现的真实端口经 production root getter/slot 到实际连接面板；
- connection-only ready 保留同步不可用说明，但不挂载 sync 表单/动作，零 sync 派发；未注入 connection mutation admission 的 Connect 禁用；
- unsupported 仍显示禁用 SSH 入口，并保留原 saved/connect/device 页面；
- starting → 用户显式 Retry → 唯一 controller，refresh 保留草稿；
- dirty 关闭、导航和 native close 的 Cancel 均保留原稿；
- unknown save 禁止离页，缺失 receipt 不解锁，原 receipt 的读取核验不重放写入，重开仍为已确认 registry。

## 当前生产阻塞的记录

首次添加测试时，产品 `nsh.json` 缺少全部六个 `desktop.ssh.capabilities/read/save/remove/start/cancel` grant。
临时 manifest 只补这些明确名称，不使用 `host:true` 或通配符。生产 grant 仍由 Host owner 修复；测试补 grant 不是产品可用证明。

旧 production root 仅在 loader 成功后提供 slot，unsupported/starting 会让 SSH 区域消失且无显式重新 discovery 入口。
测试保留对此的失败断言；必须由 main 改接上述稳定 factory 才能闭环，本测试 slice 不改 application。

原审计把 connection-only 与完整注入 port 的同步呈现混为一谈。本轮按 owning `desktop-remote-connections-DOCUMENTATION.md` 和 native slot 回归统一：connection-only 的 ready 状态保留独立 unavailable 说明，sync 控件零挂载；完整 port 的原同步表单仍由独立 fixture 覆盖。这里不声称 production 支持 sync。

本轮 root 新增共用 `connectionMutation`、frozen close/leave guard 与 result recovery seam，但未改 application 的生产装配。故此 App 测试额外断言没有准入时 Connect 不可用；准入后 start/unknown 跨 Settings/Header teardown 的证据在 `desktop-remote-connections-root-engine.test.ts`。main 仍须先完成全部 owner 准备和旧 writer release ACK，再 dispatch，不能只传一个 fake available/callback 开启入口。

实际通过情况以执行输出为准。headless 不证明真实 Rust HostChannel、SSH、Vault、系统凭据、AppKit/Win32 或物理键盘。
