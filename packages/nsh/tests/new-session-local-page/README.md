# Desktop new-session local commands

`NativeNewSessionPage` 的稳定 `NewSessionBody` 为真实 owner 构造一次
`createNativeNewSessionLocalCommands`；普通编辑不重建 registry。desktop 的
NativeCommandSuggestions 接其 catalog，既有 native keyboard 仍唯一拥有
Tab/Enter、caret、选区与 IME。iOS 不构造该 registry，原 `/model` 去 token
行为不变。按钮、键盘、桌面 submit action 与 starter 最终共用同一个 submit 分流。

- `/model` 打开真实 model modal，desktop 不消费文档尾文。
- `/new` 通过根的真实同目录 ownership intent 重新打开 unsent draft，不 POST create；
  immediate 文本消费由 registry 完成，附件/context 继续留在同一 durable 分区。
- magic 编译使用 captured operation，`draft.admitLocalMagic` 安装成功后只经原
  transfer/onOpenChat/navigation → `createNewSessionAdmission`。不直接 complete
  source，不第二次 create。unknown 不导航，原创建恢复入口仍有效。
- 未绑定或 session-only 命令被共享 classifier claim，绝不 fallback 到同名 Host。
  `/goal`、`/init`、非 VS Code `/reload` 和普通 Host 命令保持共享规则的 pass 语义。
  当前 shared registry 对结构引用仍是 blocked，不以丢引用换取 magic 成功。

## Shared conflict helper

`desktop-local-command-conflict.ts` 导出
`confirmNativeLocalCommandConflict(conflict,{current,replace,submit,focus})`。
`current` 必须捕获真实 owner/scope/operation；`replace` 必须 CAS scope、authority、
monotonic revision、text。helper 用 Native AlertDialog 和现有通用 discard changes
翻译，不使用 Git 警告。Cancel 不消费；submit conflict 先 CAS bare command 再交
registry；selection conflict 优先 presetText，否则只插入 webText。仅 current 时
恢复 focus。返回 `applied/cancelled/stale/rejected`；`applied/submitted` 是文档应用与
delegation 结果，不是业务 accepted 回执。Chat 可直接复用同一 helper。

## Evidence and limits

`new-session-local-page.test.ts` 执行真实 page callbacks、registry、native keyboard、
writer 和 `createNewSessionAdmission`；VM 仅替代 native layout leaves。覆盖 exact
selection/IME、Tab、同名 Host、尾文确认、资源保留、unknown、ABA，以及闭合前后
各 50 次编辑的零 catalog/history/request 扫描。

`new-session-local-page-native.test.ts` 在每次唯一临时 config/output 目录，用固定
NSH 0.4.0 执行 `Root.tsx` 的实际生产 page，所有请求经 strict fake Host。macOS /
Windows 目标覆盖真实 handoff admission、源资源保留、model modal、unknown create、
编译 await 期间 native 编辑 ABA、native Tab/Enter 和 50 次输入零网络增量。
不会启动 application 根、真实 Host/模型或共享 `packages/nsh/.nsh/test`。

这不是 AppKit/Win32/UIKit 实机、物理 IME 或视觉验收。shared suggestions 尚未提供
row-disabled 契约；本页不伪称已实现不可用条目的原生 disabled 样式，核心 claim / 拒绝
保持生效。该 shared 契约由 composer owner 补齐，不能删除条目隐藏缺口。
