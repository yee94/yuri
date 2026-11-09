# Actual App 附件下载接线验证

本专项不修改产品组件、状态 owner、布局或交互回调。`ContactAttachment.test.tsx` 通过实际桌面按钮打开真实 `YuriNativeApp` 的联系人对话，消费原 `NativeDesktopAssistantAttachment`、`createDesktopAssistantAttachmentDownload` 和原根模态/离页/关闭保护。

## 边界

- 两种 headless 平台模型各六场景，共十二场景。十个场景直接打开生产 `App.tsx`；两个迟到状态回执场景通过 `ContactAttachmentRoot.tsx` 挂同一生产根，只延迟公共 `host.call` 的合成成功响应，不替换 controller、页面或状态。它先接收原生合成回执，再延迟交付，不能当作仍未发出的请求。
- 原 journal/writer Host fixture 保留；contact read POST 校验原 writer grant/target，HTTP reader 验证当前 Host/lease。下载只通过既有五个 `desktop.files.download.*` 方法；没有 JS 附件 GET、浏览器下载或文件系统 fallback，每个场景都断言零直接网络请求。
- fixture 的记录、连接和 native receipts 全为合成；没有打开物理窗口、系统 chooser，没有访问真实账号、凭据、目标文件或 Host。测试中的 selecting 只验证产品对该原生回执的消费，不能证明系统 SaveDialog 的实际行为。

## 场景

1. 附件历史行挂载与五十次草稿输入零下载 native I/O。显式动作才发一次 exact canonical capability 和 save；选择位置期间原 composer/联系人入口禁用，新会话离页不释放 writer，原生 close ticket 被拒绝。saved 状态解除模态后保留原草稿。
2. 丢失 native save ACK 后为 unknown：无重放 save/chooser，无 resume，时钟推进不偷偷核验。显式 inspect 只发原 identity 的 status，成功后恢复原操作入口。
3. 缺完整 canonical capability 时不退回旧 Host 文件下载 shape；不保存，composer 保持可用。
4. 畸形历史 descriptor 只显示 unavailable，零下载 native I/O。
5. selecting 已结束、后台 pending 时切换联系人：精确取消退休 owner/request/window/Host，旧轮询不残留，不影响新联系人。
6. 成功 status 回执已生成但交付迟到期间切换 Host：原附件 owner 退休，迟到成功不能重新发布进度、跨授权保存或启动新下载；cleanup 只取消原 scope。

## 本次结果与限制

诊断 paired digest `8a261f52b450ac75cc77225f2751bda1dc59097dd1e48ac5677f67d3ad77ff25` 下，Vitest wrapper **1/1**、内部 NSH **12/12**，无 skip。该 digest 自身的旧 List core 契约红灯不因本专项通过而关闭；新工具链和晚到源码仍须复验。

单独 TypeScript config 启用 `allowJs:true/checkJs:false` 以解析沿用的 JS fixture，并保持 TS strict 检查；它不修改产品 tsconfig 或降低产品类型约束。运行中首次延迟放在测试 Host 的 handler 内导致两个场景超时，已改为公共 bridge 响应的 JS 交付边界并完整重跑；没有删除、跳过或放宽相关场景。

根目录 `bun run dead-code` 已尝试，因既有缺失 `vite-plugin-pwa` 无法载入 Web Vite config 而退出，未新增依赖或手工改锁。真实 AppKit/Win32、系统保存框、真实网络/账号和像素对齐仍未验收。
