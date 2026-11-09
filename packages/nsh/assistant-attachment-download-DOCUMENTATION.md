# Canonical Assistant 附件：原生安全下载合同

## 主装配可消费的冻结接口

仍是已安装的 `desktop.files.download.{capabilities,save,status,cancel,resume}`，无需新增 manifest、Host install、Vault、网络或下载 store。原 `host_services.install_file_download` 的 captured actor authority 和系统 dialog inbox 直接复用。

```ts
// 旧 Files loader 保持 capabilities({})；返回字段完全不变。
const capability = await native('desktop.files.download.capabilities', {
  source: 'assistantAttachment',
});
// 除原 version:2/save/windowID/maxBytes，显式返回：
// assistantAttachment: { supported:true, maxBytes:26214400, integrity:'sha256' }

const identity = { ownerID, requestID, windowID: capability.windowID, expectedHost };
await native('desktop.files.download.save', {
  ...identity,
  source: 'assistantAttachment',
  attachment: { type:'file', assistantID, attachmentID, sha256, size, mime, filename },
});
await native('desktop.files.download.status', identity);
await native('desktop.files.download.cancel', identity);
await native('desktop.files.download.resume', identity); // 仅明确 resumable 错误
```

`filename` 可省略，不能写 `undefined/null`。descriptor 为 exact keys；size 必须整数、非空且 ≤25 MiB，sha256 为 64 位小写十六进制，两个 ID 均为 1–128 位 `[A-Za-z0-9][A-Za-z0-9._-]*`。名称/MIME 沿用 upload owner 的既有规则。URI、URL、directory、path、authorization、header 等不是 descriptor 输入。

旧 save `{...identity,directory,path}` 原样兼容；新 source 与这两个字段严格互斥，不能通过 HostFile 的目录或路径猜测附件身份。旧 `capabilities({})` / FS receipt 保持 exact 旧 shape，避免旧 TS 严格 loader 因新增字段失效。Assistant 查询必须明确请求上述 capability，不能凭方法存在猜支持。

Assistant receipt 为原 `{requestID,windowID,state,received,total,resumable,error}` 加 `{source:'assistantAttachment',attachment:<最初 descriptor>}`，包括 selecting、cancelled、error、unknown；不返回 bytes、目标路径、ETag、凭据。主 controller 采用前应比对 immutable descriptor、原 owner/scope/window，不从当前 Bot 重建来源。status/cancel/resume **不接受** source/descriptor/path；它们仅消费 native 最初保存的来源和目标授权。原 FS receipt 不增加字段。

## TS bound controller（主线接入口）

```ts
import { createDesktopAssistantAttachmentDownload } from './desktop-files-download';
const download = createDesktopAssistantAttachmentDownload(
  capturedHost, canonicalDescriptor, nativeCall, capturedOwnerCurrent, notify,
);
// 仅显式用户下载动作，或同一 retained owner 恢复时 probe；不逐历史行 mount probe。
await download.probe();
if (download.state().available) await download.save();
// state / inspect / resume / cancel / dispose 与原 Files controller 同合同。
```

新增 factory 不构造假的 `DesktopPanelScope/directory`：host 复制冻结，descriptor 经既有 `assistantAttachmentDescriptor` 严格校验并复制冻结。它与原 `createDesktopFileDownload(scope,native,current,notify,scheduler?)` 共用唯一私有 `createDownload` 状态机、receipt、cancel epoch、250ms 单 flight polling；FS factory 的签名、capability `{}` 与 save `directory/path` exact wire 不变。

实际桌面 contact 文件行已装配这一 factory 和根的系统 chooser 模态保护；仅非 image/video 的 canonical descriptor 可下载。实际生产根的 headless 接线证据、迟到回执/Host 退休与边界见 [ContactAttachment.md](./tests/desktop-application/ContactAttachment.md)。这不代表系统 chooser 或真实窗口验收。

Assistant probe 只接受完整 exact capability，包括 nested `supported:true/maxBytes:26214400/integrity:'sha256'` 与顶层 `maxBytes:1099511627776`；缺失或畸形保持 unavailable，不探测/降级 FS。成功 capability 仅在该 controller 内缓存，失败或 inactive 期间的迟到结果不永久缓存，可在下一次显式动作重试。不需要 global capability cache：构造 50 个历史行 owner、读取 state 或 50 次输入更新均零 native call；只有实际动作有一次 probe，成功后同 owner 不重复探测。虚拟行卸载 dispose 会释放自己的 timer 并精确取消 pending receipt，不保留全局逐 item 缓存。

save 无参数，仅发送最初 immutable descriptor。Assistant receipt strict keys 并逐字段相等，包括 optional filename 是否存在；received/total 不超过 descriptor.size，saved 必须 received/已知 total 均等于 descriptor.size。`state.path` 只是原 filename（缺失时 `attachment`）的显示 label，不含 URL 或本地路径。unknown 只 status/cancel，explicit resume 只原 identity，不重发 descriptor。current 的精确 operation/Host/授权生命周期及避免系统 chooser 自身 modal 被误判退休由主线装配负责。

TS focused 包含旧 FS 原用例与新 Assistant 用例；`desktop-assistant-attachment-download-fixture.ts` 是独立 saved/corrupt harness 入口，未替换或减少旧 `desktop-files-download-fixture.ts` 的 resume/unknown/cancel coverage。该新 fixture 当前只完成 bundle，**尚未运行 JS→native canonical fixture**；不可将 TS unit/native 各自通过写成这条新联调已通过。

本次 TS 交付验证：原 FS + 新 Assistant controller **20/20**；加现 descriptor model 回归共 **53/53**。以更新后的共享 controller 重建原 FS fixture，独立 offline/locked target 的原 native example **44/44**、production actor ownership **3/3** 通过；主线已接共享 validator 后另跑原 upload `attachments::tests` **12/12**，未修改 Rust 源码。dead-code 仍因环境缺少 `vite-plugin-pwa` 阻塞。

## 分层与有界工作

- `file_download_transport::Source` 只扩展为 File / AssistantAttachment；公开 `HostFile` 与既有 `receive` wrapper 保留，原 FS 验证、路由和 stream 合同不变。
- canonical GET 固定 `/api/yuri/assistants/:assistantID/contact/attachments/:attachmentID`，native captured Authorization、identity encoding、no-store、禁止 redirect；最终 URL、status、duplicate headers、真实 Content-Type/Content-Encoding/length 都在接纳 body 前核验。不读取或信任 SHA header，不把它当正文证明。
- 同一 2 × 64 KiB stream mailbox 和 private documents Stage；每块 append 成功后才推进原生增量 SHA 与 checkpoint，最终 hash + descriptor size 一致才 seal/commit。hash 使用与 `attachments_native.rs` 同一系统 SHA provider（CommonCrypto / BCrypt），不加 crate、不把正文放进 JSON/JS、不整文件缓冲。
- 每个 transfer 原生独占增量 hash；断流保留同 Stage、checkpoint、hash 前缀。显式 resume 必须同 strong ETag、206 和 exact range，完整 hash 仍覆盖原前缀及新字节。append 失败回退 Stage 至最后确认前缀，hash 未推进；hash 失败/最终不符将原 transfer 标不可续传，绝不绕过校验 commit。无 strong validator 则保留 partial 但不可续传。
- 当前服务端 GET route 总是返回 200 全体 body，没有 Range handler；因此真实 Host partial **不能假称已完成 Range 恢复**。206 合成测试只证明客户端严守协议；若真实返回 200，保留 partial/原目标并显式失败，不重置前缀或悄悄重下。
- 完整已核验 body 的 seal 失败只重试本地屏障；unknown 只走原 native `inspect` 重新屏障，不重新 GET、rename 或重新弹选择框。取消/Host/auth/lease/window/suspension retirement 与原 final commit gate 共用，不改写先前目标；unknown 不声称可以撤销已可能发生的替换。
- 不扩 preview/thumbnail、不用 JS fetch、Blob、data/base64 或新的 attachment cache。

## 共享校验模块

`file_download_attachment_validation.rs` 提供 upload 原有规则的同形 `pub(super)` 函数。生产 binary 与各 owning example 在 crate root 各声明一次该模块；上传和下载模块只导入，不重复编译同一源文件，也不为附件上传引入整个 download owner。调用语义、错误码、upload Transport 和 install 不变。

```rust
use crate::file_download_attachment_validation::{opaque_id, validate};
```

## 验证边界

focused Rust 合成测试使用真实 HostChannel/QuickJS、注入 Network、原生产 documents Stage、私有临时目录；覆盖 exact URL/auth/raw、hash/size/MIME/encoding/status/redirect 拒绝、opaque descriptor/path injection、owner/Host/slot/取消、prefix hash + Range、仅本地 seal retry、unknown inspect 零重放和并行独立 owner 隔离，保留原 FS 回归。实际旧 TS controller fixture 也进入原 native resume/unknown/cancel 测试，没有用假 TS downloader 替换。

`file_download_owner_tests.rs` 另通过真实 production bridge/actor、committed Reader 和 install 装配 canonical 保存，并在 Data 与 End 之间替换同 Host ID 的 authorization/origin/lease，验证先前本地目标不被晚到保存覆盖；另保留已有 suspension/window 与 legacy FS production 回归。不启动系统 chooser。

验证使用只读 prepared digest `7834beffee6dc6dd588bee99f717366a37dca2282ceb53544b80734e800f97e0`、独立临时 manifest/target、原 lock 的副本和 cached offline/locked Cargo；未抢占其它 worker target。执行后的 prepared 完整源码 hash 与原 receipt 一致，临时及仓库 Cargo.lock digest 一致。

```sh
bun build packages/nsh/desktop-files-download-fixture.ts --target browser --format esm --external nsh --outfile "$WORK/legacy-files-fixture.js"
NSH_FILE_DOWNLOAD_FIXTURE="$WORK/legacy-files-fixture.js" "$CARGO" test --offline --locked --config "$WORK/patch.toml" --manifest-path "$WORK/Cargo.toml" --target-dir "$WORK/target" --example file_download_contract -- --include-ignored --skip actual_nsh_04_network_streams_to_real_stage_and_resumes_without_full_body_buffering
"$CARGO" test --offline --locked --config "$WORK/patch.toml" --manifest-path "$WORK/Cargo.toml" --target-dir "$WORK/target" --bin yuri-nsh-desktop download_owner_contract
"$CARGO" check --offline --locked --config "$WORK/patch.toml" --manifest-path "$WORK/Cargo.toml" --target-dir "$WORK/target" --bin yuri-nsh-desktop
```

当前结果：focused example **44/44**（含旧 TS fixture），production actor ownership **3/3**；Mac production main check 通过。真实 socket 用例显式排除，测试 Network 全部为内存合成。`bun run dead-code` 已执行，但因环境缺少 `vite-plugin-pwa` 无法加载 Web Vite config 而失败；未为此新增依赖或修改锁。

系统 SaveDialog、真实 AppKit/Win32 窗口、Windows target/runtime、真实账号/用户文件/Host、断电或进程重启的 partial 恢复均未验证；receipt/partial/hash 只在原 native 进程内保留。此 slice 不代表历史附件 preview/thumbnail 或完整 PC parity 已完成。
