# Production-root desktop Git regression

独立 `App.tsx` 直接挂载真实 `YuriNativeApp`；不注入测试 props、按钮、路由或业务 owner。
独立 `nsh.json`、测试入口及生成目录避免与 `tests/desktop-application/App.test.tsx` 的产物互相覆盖。
只运行 NSH headless，不启动 AppKit、Win32 或 UIKit 窗口。

从仓库根通过外层 Vitest 运行，`NSH_BIN` 指向调用方提供的 NSH 0.4.0：

```sh
bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/desktop-git-application-native.test.ts
```

## 已覆盖

macOS、Windows 两个 headless platform，各七条真实根装配路径：

- 首页实际选择目录 → 打开 Git panel → conflicted operation 显示 resolve-new。
- resolve-new 只暂存可编辑 visible draft；instructions 和 JSON sidecar 不渲染，不创建或发送 session。
- 同目录新会话动作复用仍可写的 owner。
- 原草稿 Cancel 完整保留；Replace 保留附件，只采用请求捕获时的上下文，不重新读取变动后的 Git。
- 在公开 Storage 边界延迟 Replace 写入，通过真实 composer 输入制造竞争，验证 CAS 回滚，保住更新后的文本和附件。
- 已有 Chat 的 resolve-current 只 staging；Chat → resolve-new 经生产新页面注册采用 captured initialContext。
- PR 显式发送与同一 Chat 的普通发送比较参数契约，沿用现有 session 的模型/Agent/variant authority，不另造 model 参数或调用小模型。确认 admission 后清掉 sidecar。
- PR prompt ACK 丢失保留稳定 input ID/compiled snapshot；再次点击 PR 动作不能 restage 或第二次发送。

外层 Vitest 另外验证九种不支持请求均 fail closed。Host 只允许明确列举的 GET、精确只读 Goal RPC，以及已有会话的 prompt POST；未知请求、额外 query、过期 scope、创建 session、Git 写入和模型生成全部抛错，没有兜底空成功。
项目本地配置仅对两个确切路径的 `optional=true` 读取返回空文本，代表 fixture 中确实不存在配置文件。未选目录时目录 catalog/Agent 查询只额外允许空目录，不将其作为 Git authority。

## 未覆盖

- 真实 Host/Git/GitHub/模型、凭据、上传与原生系统窗口/物理快捷键。
- 新会话首次发送/create/handoff、集成临时 worktree、checks/comments 两种 PR 分支。
- Host/authorization 切换、未知发送跨进程重启及显式 Retry reconciliation。
- 真实附件选择器与文件内容；附件通过合法持久记录 bootstrap，仅验证保留元数据。

这些路线仍须各自验证；headless 通过不代表它们已完成。
