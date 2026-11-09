# 真实桌面根 Changes 回归

`desktop-changes-application-native.test.ts` 生成独立临时 manifest/entry，NSH 0.4 headless 实际挂载 `YuriNativeApp`。每个 case 都新建 Engine、Storage 和 synthetic Host；不向 application 注入测试 props、route、controller 或按钮，不拿旧 Engine 的 writer 二次 open 冒充冷恢复。

## 真实入口

- 侧栏 hover 项目 → **New worktree** → Cancel 创建表单 → ProjectDetail 的 **Changes**：项目根目录正常进入桌面 panel，不假定这里会打开 Sheet。
- 同一 ProjectDetail 选择 Host 工作树 catalog 返回的 `/fixture/chosen` → **Changes**：页面 route 仍属 `/fixture/actual`，`desktopOpenPanel` 的 exact-directory 准入拒绝跨目录；现有生产 fallback 才打开根 `projectChangesSource` 的 `NativeChangesPresentation`。这是本测试的保稿及离页保护入口。
- Chat 的真实 history 响应提供 completed `edit` tool（含 old/new 与 patch），展开 Activity 后点击原 tool button，验证历史快照进入 panel、零 current Git diff 读取。正常桌面路径不经过 Chat 的 Sheet fallback；本套没有伪造 fallback。
- Chat 的既有 composer changed-file summary → 文件行 → Changes Sheet → Back：单独验证该既有 owner 的保稿和输入读取预算，不将它冒充根 `NativeChangesPresentation`。

## 覆盖（macOS / Windows 各 10，共 20 case）

1. 项目根 Changes 进入真实 panel。
2. 真实 message tool payload 进入历史 panel，不能改读 current Git。
3. Composer Sheet 关闭/重开保留提交稿；50 次提交稿输入、关闭后 50 次 Chat 输入均零额外 GET。
4. 工作树 Project Changes Sheet 关闭/重开保留同稿；50 次提交稿输入零额外 GET。
5. 普通脏稿 veto 原生 close 和根导航；清空同稿后正常导航恢复，避免把永久禁用误当 guard 生效。
6–9. pending ACK 和 unknown ACK 各自隔离：关闭/重开不重发、不清稿；Sheet 打开及关闭后原生 close decision 都为 `approved:false`；根 section、新会话、connect route、Header 实例切换均不能越过 owner。veto 前后核对 writer release/held 快照，随后重开核对原稿仍在。pending 的迟到 ACK 释放后仍不得清掉已退休 lane 的稿。
10. 从工作树 Sheet 打开 preview，严格核验原生 `resources.read` 的 path 为 captured worktree 文件，而非页面项目根；同一 captured Host/lease 与 requestId 也须匹配。

## 合成边界与断言

`Host.js` 包装 `desktop-application/NavigationHost.js` 的独立严格 baseline，只增加完整 exact route/method/Host/body 匹配的工作树/status/diff/message/commit，以及明确的 `resources.read/close/release`。未知 HTTP 仍交 baseline 报错并记录 rejected；每 case 均要求 rejected、baseline mutation 为空。唯一 Git 写请求是固定 worktree 的合成 commit，严格核对 `{message, files, stageFiles:[]}`，只在本地 handler 生成 ACK/ACK 丢失，绝不运行 Git 或模型。

`Root.tsx` 只拦截这一 exact 合成 commit 的 ACK 时机；不改 application 状态或控制导航。它用明确 Host event 释放 ACK。Changes 当前只有业务 `canLeave` guard，没有 native writer claim；测试明确要求 commit 不夹带 `writerGrant`，不声称验证了多 Engine 原生写权限或冷恢复。

外层不仅检查退出码：还检查完整 stdout 的 `20 tests: 20 passed`、20 条成功 case 行及两平台全部 10 个 case 名，拒绝任何非零 failed 统计。内部失败会使外层 Vitest 失败；不是只取 CLI exit 0。

```sh
NSH_BIN=/path/to/nsh-0.4.0/bin/nsh bunx --no-install vitest run --config packages/nsh/vitest.config.ts packages/nsh/desktop-changes-application-native.test.ts
```

已运行：真实 NSH 0.4 headless，两平台投影合计 20/20。它不是 AppKit/Win32 实机、真实 Host/Git、物理按键、视觉、跨进程 writer、磁盘 durability 或冷恢复验收。
