# Provider usage-credential integration contract

此独立模块还原 Web `providers/QuotaCredentials.tsx`，不接入模型 API Key，不改服务端。
主会话负责正式接线；本任务不修改 `settings-providers.tsx`、Settings 路由、搜索或 usage/integration owner。

## 最小接线

- 详情页使用 `quotaCredentialProviderFor(provider.id)`。映射与 Web 一致：`opencode` / `opencode-go` → `opencode-go`；`ollama` / `ollama-cloud` → `ollama-cloud`；`cursor` → `cursor`；其它不挂载。
- `SettingsQuotaCredentials` 仅是详情行：`providerId`、`providerName`、`active`、可选 `directory`，以及 `onManage()`。产品名分别传 `OpenCode Go`、`Ollama Cloud`、`Cursor`。建议放在现有 Integration 区域之后、模型列表之前。
- `onManage()` 推入原生导航的独立凭据路由，捕获当前 Host generation、连接身份与 directory。路由不放任何表单字段或凭据。
- `SettingsQuotaCredentialsPage` 拥有唯一 `NavPage`，直接作为已有 `NavStack` 的页面，**不再外套 NavPage**。传同样上下文与 `onBack()`；成功写入调用可选 `onSaved(status, action)`，然后 `onBack()`。
- `onSaved` 只接收 `{ configured, workspaceId? }` 和 `save | import | delete`，供 main 用既有 `saved` / `deleted` 文案反馈。返回详情使 summary 从真实 `active=false → true` 回读；不要重放写入。
- `active` 必须是实际顶层路由且当前 Settings Tab 的状态，不可在隐藏页固定传 true。组件额外检查应用 lifecycle、Host epoch/连接与 directory。Host/provider/directory 变化销毁旧 owner，重新挂载新页面；后台/覆盖页清除认证草稿，恢复只读。
- `dependencies` 仅用于明确的合成夹具注入；生产省略，使用既有 Swift `runtime.request`，不引入浏览器 transport 或 SDK。

## Scope 与 wire

| 动作 | 请求 | 正文 / 成功结果 |
| --- | --- | --- |
| 状态 | `GET /api/quota/credentials/:provider` | 无正文；`configured:boolean`，可选 `workspaceId` |
| 保存并验证 | 同路径 `PUT` | Go `{workspaceId,authCookie}`；Ollama `{cookie}`；Cursor `{accessToken,refreshToken}`；返回 configured 状态 |
| 验证已保存凭据 | 同路径 `/validate` `POST` | **无草稿正文**；必须 `{valid:true}` |
| Cursor 导入 | 同路径 `/import` `POST` | **无正文**；导入的是当前 Host 的本地 Cursor，不是手机文件；返回 configured 状态 |
| 删除 | 同路径 `DELETE` | 先独立确认；无正文；必须 `{configured:false}` |

凭据按 **Host 全局**存放。不要向这些路径附加 directory/location/query，也不要把 directory 写进 body；directory 只作为表单/异步响应的生命周期 fence。认证仍由 Swift 注入，JS 无 endpoint/token 缓存。

保存必填与 Web 一致：Go workspace/authCookie，Ollama cookie，Cursor accessToken；refreshToken 可选。服务器继续拥有最终校验与凭据存储。

## 失败与秘密

- 失败保留当前表单必要内存；不记录原始服务端错误，不回显 token/cookie/masked metadata；响应投影仅 configured/workspaceId。
- 关闭、返回、隐藏/后台、Host/provider/directory 失效、销毁均清空认证字段和删除确认。已发原生请求不宣称物理取消。
- 丢 ACK、5xx、畸形成功结果进入 read-required，禁止继续写入。Retry **只 GET**；回读失败保旧状态和草稿，仍禁止写入。
- 回读成功仅进入 review，**不能**根据 configured=true 推定新 token 已保存，也不自动再保存/导入/验证/删除。用户可以检查结果后显式发起新动作。删除回读为 false 后不再提供删除动作。
- ACK 成功后清空表单并退出；已确认写入不再因为刷新失败被重放。没有 Storage、日志、URL 凭据、夹具真实秘密或真实 Host 操作。

## 搜索合同

保留 Web anchor：`providers.opencode-go-credentials`、`providers.ollama-cloud-credentials`、`providers.cursor-credentials`。summary 已使用 `SettingsTarget`，可传 `target` 与 owning Scroll 的 `onReveal(node)`。

目前全局 NSH Settings 搜索未接线 provider 二级路由，因此**不**把这些条件字段当作无条件根页面项注册。main 若纳入搜索，必须先解析当前 provider 目录并准备对应 provider detail，再传相同 target；不存在对应 provider 时隐藏结果。不得为每个动态模型/账号生成索引，不得搜索、持久化或显示凭据字段。无新增顶级页、无改 usage 页面。

## 验证入口与未验边界

纯协议/合成 Host/字典测试不启动引擎：

```sh
bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/settings-quota-credentials-core.test.ts packages/nsh/settings-quota-credentials-fixture-host.test.ts packages/nsh/settings-quota-credentials-locale.test.ts
```

独立 engine 夹具由 main **串行 opt-in**，不运行 App/main build，不连接真实 Host：

```sh
NSH_QUOTA_CREDENTIALS_ENGINE=1 bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/settings-quota-credentials-engine.test.ts
```

严格 Host 仅允许 usage 路径和固定 `fixture-only-input` 标记，不落盘、不读 Cursor、不出网；审计只返回操作计数。engine 夹具不等于 UIKit/真机验收。正式路由接线、UIKit 导航/返回手势/布局/安全键盘/后台清理、实际 iOS request bridge、direct/Relay、真实额度服务与 Cursor 导入均仍需 main 验收。不能由纯协议测试宣称 Web 手机 1:1 已完成。

本次实际验证：27 项纯测试通过；5 项 engine 用例跳过，未启动 NSH。`bunx tsc --noEmit -p packages/nsh/tsconfig.json` 和 Settings design audit 通过。`bun run dead-code` 已执行并检查：正式入口未接线的组件与孤立夹具被列为 unused，仓库还有其他既存报告；未为消除报告而越界接线/删除其他代码。未运行 UIKit、设备、main build、Git 或真实 Host。当前可用工具未提供任务下派能力，未声称完成独立子代理审查。
