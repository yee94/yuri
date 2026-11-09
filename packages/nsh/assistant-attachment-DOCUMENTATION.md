# 桌面 Assistant 附件垂直 slice

## 正式接线 API

```ts
import type { AssistantAttachmentDescriptor } from './assistant-attachment-model';
// model Attachment 的可选字段由主装配 owner 接入，drafts 必须原样 roundtrip。
type ContactAttachment = { uri: string; name: string; mime: string; contact?: AssistantAttachmentDescriptor };

const attachments = createDesktopAttachments({
  scope, native, id,
  target: { kind: 'assistant', assistantID: capturedTarget.id },
});
await attachments.pick('files', capturedDraftOwner); // images 同合同
// 原有 message writer 将 files.map(file => assistantAttachmentFilePart(file, capturedTarget.id))
// 编译进 parts；仍由它自己的 native writer grant / pending journal 控制消息提交。
```

`contact` 是冻结的 `{type:'file',assistantID,attachmentID,sha256,size,mime,filename?}`。`uri` 是同一 assistant/attachment 的 canonical 相对 GET 路径，`name/mime` 保留原附件展示字段，不是客户端本地文件。只有 session legacy 返回 `file:///`。所有 ID 只接受 1–128 位 `[a-zA-Z0-9][a-zA-Z0-9._-]*`；不接受路径、percent 编码、空白、代理 URL。元数据解析与序列化不访问网络。

`target` 在 controller 创建时复制并冻结。省略或 `{kind:'session'}` 保留旧 session 输入/输出；assistant 的 pick/status/cancel/release 均携带 exact target，返回包括同 target（空/失败回执也包含）。requestID、原 captured expectedHost 与 target 任一不匹配都拒绝，不从当前选中 Bot、路由或 backing session 推断归属。JS 原 owner.current 在选择前和采用前复验；native 同时在 chooser 前后、读取前、PUT 前及完成后检查原 scope/lease。

## 原生 ownership / 协议

沿用 `attachments.rs` 唯一 receipt book / picker inbox / native Selected、`attachments_native.rs` 的私有文件读取与系统 SHA-256、`attachment_transport.rs` 的同一 bounded actor mailbox 和 `bridge.rs` captured Connection。没有第二 Vault/Network/sender；原始 bytes 永不经过 HostChannel/JS/base64。上传文件独立于消息写权限；protected chooser + exact target + native scope 授予只上传文件的能力，不能据此发送 assistant message 或创造 writer claim。

- Assistant：PUT `/api/yuri/assistants/:assistantID/contact/attachments/:nativeUUID`，仅四个 headers：`Content-Type`、`X-Content-SHA256`、`X-Content-Size`、`X-Attachment-Filename`（encodeURIComponent）。严格接受 201 完整 descriptor，hash/size/mime 对照真正 native bytes，不接受服务端 path、url 或跨目标字段。
- Session：原 PUT `/api/fs/prompt-attachments/:nativeUUID?storage=temporary` 和五个 `X-Yuri-*`/Content-Type headers 不变，仍验证 200 temporary-file receipt。
- 原 actor 继续注入认证、same-origin、禁 redirects、64 KiB response、8-job admission、scope retirement 与原 mailbox；不放宽通用 HTTP 或任意 PUT/header。
- 每个文件非空且 ≤25 MiB、一次选择合计 ≤50 MiB、≤64 文件。JS assistant adoption 再检查整个当前草稿的 64 文件/50 MiB 预算，不覆盖已有有效草稿。

## 失败与恢复

部分成功保留完整 descriptor；failed/unknown 原 receipt 阻止新 pick，status 只回读，不 resume/replay PUT。cancel/release 只标记 exact receipt，不删除任意 Host path；迟到已知成功记录 orphan 数，无 delete API 不假装清理成功。Host 或 draft owner 退休不把附件写入新的 Bot。相同 attachmentID 返回不同 metadata 会触发 identity conflict。GET 预览只是冻结 exact metadata，本 slice 不启用 file://、不认证的图片 URL 或网络 fallback；安全 renderer 仍需其 owning resource 协议。

## 验证边界

focused TS 测试覆盖 legacy wire、严格 descriptor/target、回读去重、partial/unknown/401、取消/退休、跨 Bot 和预算。Rust 合成测试覆盖真实 HostChannel/QuickJS、原 actor/合成 Network/private native bytes、exact raw wire 与原生哈希、receipt target、lease/cancel/unknown 与零重放。未打开真实系统 chooser、读取账号/用户文件、连接真实 Host 或运行模型；这些测试不代表 AppKit/Win32 系统交互或完整生产根装配验收。

## 生产桌面 Assistant 接线

`model.Attachment.contact` 已接入原 draft v1 attachments/pendingSend 的 roundtrip 与 metadata equality；格式错误、URI/mime 不匹配的写入失败会保留之前的有效记录。`ChatOwner` 使用原 `createDesktopChatAttachments` 并传 exact target，detached receipt recovery 保留最初 target，不借当前 Bot 采用。

原 `createChat.send` 在任何消息写入前再验证 assistantID、canonical URI/mime 和 64 文件/50 MiB 总预算。正式消息 parts 使用 `assistantAttachmentFilePart`，附件-only 不产生虚假的空 text part；语言沿用当前 locale。消息级 not-dispatched 重试沿用原 ID 和附件快照，不把文件改成 Session 引用，不消费后来草稿。

实际 App 首批两平台附件-only、单 List/Input、Settings 保附件和 50 输入零额外请求已进入 **74/74** 主根检查点；此处系统 chooser/真实 PUT 网络并未执行，原生上传正确性仍只有 Rust synthetic evidence。安全历史预览/下载、缩略图、粘贴和拖放尚未接入，不把 unavailable 视为已完成。
