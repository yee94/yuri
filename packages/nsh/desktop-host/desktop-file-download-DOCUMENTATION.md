# 文件下载 v2：接线合同与未完成项

## 状态

`src/file_download.rs` 是新的有界下载 owner；`file_journal_download.rs` 是此前的 25 MiB Vec scaffold，**不能作为本轮生产下载安装**。TS adapter 只接受 v2 capability，旧 scaffold 不会被误认作已完成实现。

上传与 canonical contact 附件下载的 ID／文件名／MIME 校验共用 crate root 的唯一 `file_download_attachment_validation` 模块；`attachments.rs` 和 `file_download_attachment.rs` 只导入该模块，不各自重复编译一份源文件。生产 binary 与各 owning example 同样各声明一次，校验规则、大小限制和传输协议不变。

生产磁盘 adapter 已实现于 `file_download_target.rs`，直接复用 `documents_files.rs` 的同一 pinned Grant／Stage；不再要求 Host owner 提供磁盘 factory，不另造 rename／write infra。真实 QuickJS → **实际 `desktop-files-download.ts`** → HostChannel → native job → 合成 Network → **该生产 adapter／私有临时磁盘** 覆盖中断／续传、未知回执核验与核验中取消。另以实际 NSH 0.4 `net::network()`＋合成 loopback HTTP 服务验证 16 MiB 流式磁盘下载和 Range 恢复，并有 256 MiB 数据流的有界 operation-count 测试。

Stage／生产 SaveJob／默认磁盘 adapter 已由 main／Host owner 接入同 actor Reader 与窗口 UI mailbox；Reader 的 exact scope／window／origin／authorization 之外还有单调 download epoch，suspension／retire 后旧 handle 不复活。`nsh.json` 已精确声明五个 v2 方法；本模块未修改这些入口装配，也未另读 Vault。多窗口 dequeue 的前台检查之外，实际 chooser 入口另有下述 OS gate，避免 deferred 呈现使用过期前台状态。

仍未打开系统保存框、原生窗口，未访问用户目标或真实 Host。Mac/Win Save API 复用已有 `file_journal_download_native.rs` 真源码；Windows target／实机仍未验。纯门禁与合成测试通过不能当作系统 chooser 实机验收。

## 精确安装接口（交 Host owner）

```rust
mod file_download;
mod file_download_attachment_validation;
let (downloads, download_jobs) = file_download::channel();
let owner = file_download::install(
    &host, &window_id, network.clone(), capture, downloads,
)?;
```

- `Capture = Arc<dyn Fn(&Value, &str) -> Result<Captured> + Send + Sync>`：参数是 expectedHost、native window ID。Reader 在自己的 publication lock 下捕获已提交 scope、origin、token、authorization 与 window；同时拒绝 shutdown／runtime suspension。不得只调用较弱的 `Reader.current(scope)`。
- 构造 `transport::Captured::direct(scope, window_id, origin, token, loopback, current)`；`current` 必须持续检查 live、非 suspended、exact lease／window／origin／authorization。先在 publication lock 下 clone 已提交快照，**释放锁后**调用此构造器，因为构造器会立即调用 `current()` 复验，不能反向重入同一锁。捕获和 credentials 都只在 Rust，不序列化；字段私有，是不透明的 authenticated readhandle。网络必须是同一 actor 已注入的 `Network`，不另建认证来源。
- 磁盘 Target 是安装函数内部的生产默认实现；factory 参数仅来自系统确认后的 native Job，不接收 JS 本地路径。Host owner 不需要再装一个磁盘实现。`install_with_targets` 仅为模块私有的故障注入测试 seam。
- 窗口根每轮 UI mailbox 最多取一项，与 documents／attachments／diagnostics 串行，在不持有 pump borrow 的主线程调用 `unsafe { job.show(&window_id, real_window) }`。ID 必须来自此原生窗口；不能由 JS 指定指针或伪造另一个窗口。
- `Owner` 必须持有至 teardown。actor **在改变 selected、authorization、window 或 suspension 前**，同步 `owner.invalidate()`，与最终 commit 共用 gate；先撤权再发布。shutdown 先 drop owner 再 stop engine。不能以当前谓词的检查代替这个同步 gate。
- `is_presenting()` 覆盖 scheduled／modal 生命周期；既有系统 dialog owner 也必须参与串行调度。
- `choose` 在实际系统调用前重新读取 OS 状态，不使用 dequeue 时的缓存：Mac 要求 NSApplication active、其 keyWindow 恰为 owner 且 owner.isKeyWindow、visible、非 miniaturized，同时无 modal／attached sheet；Win 要求活 HWND 仍属当前 UI 线程、恰为 GetForegroundWindow、visible、enabled、非 iconic。final gate 前后仍复验同 scope／runtime current。Mac dispatch_async 后失焦、另一窗口成为 key、隐藏／最小化／关闭均拒绝弹框。此 gate 只限制 chooser，不加入已获准传输的 Reader current，不因普通后台取消下载。

## 已实现的共享 Stage 接口

已在 owning module 增补独立的 Stage 方法；旧 `stage(&[u8], current)` API、documents／diagnostics 的现有消费者及 receipt 语义保留：

- `grant.begin()`：与 slice wrapper 使用同一个 private、exclusive、nofollow／pinned-parent 同目录临时文件创建路径。
- `stage.append(bytes)`：每次至多 65,536 字节，完整写入或报错；不向 JS 暴露文件句柄／名称。
- `stage.rewind(received)`：截断到确认写入的前缀、seek 到末尾并做真实文件屏障；失败不得宣称可续传。
- `stage.seal()`：完成 staging 文件屏障，之后才能调用已有 `grant.commit(&mut stage)`。
- 目标替换继续使用既有 Grant／Stage commit 与 Drop 清理，不写第二套 rename／link 安全实现。rename／目录屏障不明映射 `Commit::Unknown`；只有明确未执行替换才是 `Failed`；已确认完整提交才是 `Saved`。
- Stage 记录写入长度、sealed identity 与 final-commit attempted 标记，拒绝超 64 KiB append、越界扩展、sealed 后 append、未知 commit 再次 rename；commit 前再次核对原始 staging name 身份。确认失败保留原目标，Drop 只清理自己的临时身份，不删除后来同名的外部文件。
- `documents_files_io.rs` 仅共享 Stage 文件屏障和 Windows 私有文件创建。Mac 为 0600、fsync＋F_FULLFSYNC；Windows 使用当前用户 SID 的 protected DACL、CREATE_NEW／OPEN_REPARSE_POINT，同样经真实文件 flush。没有新增依赖、客户端目录发现或第二套 commit。

临时失败持有原 Stage 与 metadata；0 字节失败可显式重试幂等 GET；完整 body 的 seal 失败可只重试本地屏障，不再次 HTTP。partial 只有强 validator 满足下述合同才允许 Range。目标被外部编辑时不越过旧授权强行覆盖，需取消并重新系统确认目标。

`status` 在 unknown 时异步运行 `Target::inspect`，状态为 verifying。`Grant::confirm_stage` 只接受**原始 Stage 的精确 file identity**，重新执行文件 flush 与 pinned parent 目录屏障后，再次复验目标／文件身份和 current，才发一个新的 durable ACK；绝不调用 commit／rename／HTTP。此前的相同缓存 bytes 或另一个同内容 inode 均不算成功。仅观察到原文件、屏障失败、身份不明、取消或退休时仍为 unknown。Windows 如果系统拒绝目录 FlushFileBuffers，同样保留 unknown，不伪造跨平台成功。

状态与 partial 是此原生窗口进程内的 receipt，不声明断电／进程被杀后的自动断点恢复，也不把失效 Host 的旧 grant 自动迁给新 authorization。

## exact HostChannel wire

所有方法均为 `desktop.files.download.*`。未知字段一律拒绝。

| 方法 | payload |
| --- | --- |
| `capabilities` | `{}` |
| `save` | `{ownerID,requestID,windowID,expectedHost:{hostID,lease},directory,path}` |
| `status`／`cancel`／`resume` | `{ownerID,requestID,windowID,expectedHost:{hostID,lease}}` |

capability：`{version:2,save:true,windowID,maxBytes:1099511627776}`。maxBytes 为明确的 native 单文件硬界限，不分配该大小内存。

receipt：`{requestID,windowID,state,received,total,resumable,error}`。

- state：`selecting | pending | verifying | saved | cancelled | error | unknown`；total 为整数或 null，error 为稳定 code 或 null。
- `selecting` 保持 browser 的 modal 遮挡，系统目标确认后进入 pending；不能把排入 UI mailbox 当系统确认。取消系统选择不执行 HTTP。
- JS 不收到 bytes、ETag、credentials、目标路径或句柄。目录／path 始终是 Host source，不是客户端 fs 权力。
- requestID 在窗口进程内不复用；128 条 receipt 容量满时明确失败，不通过淘汰旧 receipt 允许晚到消息接管新请求。一次仅一条 running job。
- resume 仅错误状态且 `resumable:true` 时允许：仍保有有效 Stage 的零字节幂等 GET／可验证 prefix／仅待本地 seal 的完整 body。复用同一 receipt／目标／Host source，不重新选择目标。unknown、verifying、cancelled、saved 不允许 resume。

## HTTP 与流式合同

Web `packages/web/src/api/files.ts` 的 downloadFile 委托 `runtime-file-download.ts`，实际 raw route 为 `/api/fs/raw`；大文件交浏览器并不证明目的地已保存。iOS `ResourceBridge.swift` 是受限资源预览下载再用 UIDocumentPicker 导出，并非本轮有界大文件下载器。

native 只构造认证 GET `/api/fs/raw?path=…&directory=…&download=true`，源路径再次校验在 exact directory 内，拒绝 URL、dot segments、反斜杠和越界。后端继续做其 workspace／Host auth 检查，不放宽 outside-workspace、不新增路由、不使用 URL token 或 cookie。禁止 redirect，最终 URL 必须 exact；只接收 identity encoding。

NSH 0.4 Network 是公开流式 FetchEvents，桌面 net 实现为每请求工作线程、64 KiB chunk；pause 只能暂停后续读取，不能从断点恢复。这里由独立 launcher 加两项同步 mailbox 提供真正 backpressure，即便注入的 fetch 同步发全部回调也不会在引擎线程上执行或积累整文件。consumer 写完才消费下一批，任务取消先断 receiver 再 cancel，晚到回调无权发布。

resume 发送 Range 与 If-Range，必须返回 206、**相同 strong ETag**、精确 `bytes offset-(total-1)/total` 和匹配的可选 Content-Length；200／416／weak ETag／错 range／改 size 均不 append、不重置 prefix。不以 Accept-Ranges 声称推测成功。Web sendFile 的默认 validator 可能是 weak；真实 Host 没有 strong validator 时明确不可续传，进度／partial 仍保留，不能把合成 strong ETag 测试当所有 Host 已支持。

## UI 与验证

TS poll 至多单 flight、250 ms；隐藏停止，重新激活只查询 receipt，dispose 取消。cancel 有独立 epoch，旧 save/status ACK 不能覆盖取消结果；verifying 被取消仍保留 unknown，不能声称撤回已可能发生的保存。无变化的 progress 不 notify，下载 revision 不驱动文件树 rows 重算。文件树细进度条复用 `historyImportProgressTokens()`，展示十语已有的已下载／总量 MB；total=null 时只报已下载量，不造百分比。失败保留进度及显式 Continue／Cancel，unsupported 的 Continue 标不可用。

```sh
bun build packages/nsh/desktop-files-download-fixture.ts --target browser --format esm --external nsh --outfile "$FIXTURE"
NSH_FILE_DOWNLOAD_FIXTURE="$FIXTURE" cargo test --offline --config packages/nsh/.nsh/desktop/cargo-source-patch.toml --manifest-path packages/nsh/desktop-host/Cargo.toml --target-dir packages/nsh/.nsh/desktop-target --example file_download_contract -- --include-ignored
```

`FIXTURE` 放专用私有临时目录。所有选中目标都只在独立私有临时目录，HTTP 服务仅为合成 loopback，无用户 Host／文件。此处实际使用生产 documents adapter 和真实 NSH Network；但不验证系统 chooser、真实同 actor Reader 生产安装、断电恢复或 Windows 平台。

呈现门禁另有无 UI 的纯 gate／合成 deferred 测试：逐一拒绝 inactive、非 owner key／foreground、hidden、minimized、disabled、dead、已有 dialog；delivery 时复采样，scope 在 probe 期间退役也不能呈现。生产 Stage 的合成下载在 Data 期间失焦仍保存，用于防止把 chooser 限制扩散到传输。测试未调用真实 chooser，Windows OS 适配仍待 target／实机验证。
