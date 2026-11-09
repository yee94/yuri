# Observer 无损分段导出：设计与规模材料（尚未实施）

此标题和下文记录前轮冻结时的设计状态及原始成本，不覆盖其历史结论。本轮经main授权已另实施 [v4模块](v4/README.md)，新的压力/SDK/实机边界以该目录及本轮交接材料为准；旧v3与原2.42GB证据不迁移、不重写。

本方案不改生产/SDK/Host，不减18000帧上限、不删字段/坏帧、不挑帧、不放宽 gap/5ms/三 body 门槛。P1/P2 与立即读回护栏先单独冻结；下面是下一阶段的具体实现边界，不是已完成的编码优化，也不能据此开始长时 v3 UI 验收。

## 已证故障及本轮读法

只读 agent `ses_e483370dcffe3Ng0lWKayc3jmb` 已确认989首次 cap flush：revision1/seq18000、overflow=true/nativeFailure=false，无 frame 自指环。本轮仅读取458-byte preservation.json、353KB process sample 的相关行，以及422KB native-before；对2,419,177,788-byte capture只查 stat，没有复制、hash整包或 JSON parse。

process sample 直接可见主线程1937/1937样本在 sample→flush→JSONSerialization/SwiftDeferred container 路径，physical footprint12.3G、peak21.5G。这是诊断载体自身干扰，不能当 production Changes bug。仅将整包 JSONSerialization 调到后台，仍保留多GB graph、整包 Data 和 bridge/释放峰值，**不足以解决 OOM**。

## 实际深层材料与可运行校准

`EncodingProfile.swift` 是 macOS Foundation 离线基准，不导入 UIKit/NativeShell；输入 stat超过4MiB或输入字节×帧数超过32MiB便在读取前拒绝并返回exit2，最多128个模型帧，不会读大 capture。用真实 native-before 的9 binding/祖先结构重建 Swift value containers，执行真实 JSONSerialization，而非浅层 `{sequence,frame}` 假数据。

该一次 read 有639个 dictionary、829个 array、14,673个 scalar，binding geometry 共121,097 compact JSON bytes、256条 ancestorVisibility。整 read约134,943 bytes，旧2.42GB capture平均约134,399 bytes/frame；代表性规模同量级，但该模型不是原18000帧的重放或 UIKit 时序证据。

本轮实际独立进程结果：

| 模型 | 帧数 | JSON bytes | encode ms | max RSS bytes |
| --- | ---: | ---: | ---: | ---: |
| legacy重复window | 1 | 142,051 | 3.56 | 10,665,984 |
| 同seq window ref模型 | 1 | 135,288 | 2.58 | 11,943,936 |
| legacy重复window | 16 | 2,272,664 | 38.26 | 38,715,392 |
| 同seq window ref模型 | 16 | 2,164,456 | 33.03 | 44,433,408 |
| legacy重复window | 64 | 9,090,728 | 140.37 | 122,896,384 |
| 同seq window ref模型 | 64 | 8,657,896 | 149.05 | 141,443,072 |

ref模型额外逐帧做了展开后的 sorted JSON 完整值相等检查，其 build/validation工作与RSS更高，不能拿这张表声称CPU或内存已优化。它只证明该显式引用可恢复全部值，并量化 window 去重只省约4.76%；单做这个改动不能关 OOM。

同一小 read 的256条完整 ancestor row 按**全字段精确值**分组有54条不同值。原111,573 bytes，唯一 row共24,284 bytes；理论材料差87,289 bytes，尚未计 refs/table/hash成本。只能据此建议下一阶段评估同记录祖先表，不推断所有帧都具有该压缩率，不按 instance/类名直接缓存动态 geometry。

复现（输出仅为规模摘要，不能传大 capture做解析）：

```sh
xcrun --sdk macosx swiftc -O -swift-version 5 -parse-as-library \
  packages/nsh/tests/history-production-uikit/EncodingProfile.swift -o "$PROFILE_BINARY"
"$PROFILE_BINARY" .scratch/nsh/uikit-989dfdee-identity-first/native-before.json 64 legacy
"$PROFILE_BINARY" .scratch/nsh/uikit-989dfdee-identity-first/native-before.json 64 same-sequence-ref-model
```

大文件参数已实际验证在 stat guard拒绝，未进入Data读取。没有运行18000帧/多GB内存压力来重新触发 OOM。

## v4 最窄方案

1. **显式新 schema/新 reader。** periodic frame的 windowObservation 保存一次，diagnosticIdentity 用仅指向该 frame同seq的 windowObservationRef。reader验证schema、seq、引用范围、唯一性，错误/缺定义拒绝。control-read具有自己的读窗和liveProtection，即使lastPeriodicSequence相同，也绝不能引用旧periodic window冒充当前状态。旧v3/strict reader不偷偷兼容v4。
2. **不可变的纯值导出边界。** main actor完成所有实际UIKit读取；导出对象只含类型明确的Bool/Int/Double/String/null/不可变array/record，不含UIView、CALayer、weak registry、可变NSMutable容器或捕获observer/self的closure。后台不调用UIKit。优先独立SnapshotValue/DTO模块，而非对任意Any图使用unchecked Sendable掩盖风险。读窗仍计真实采样成本；不能移走timestamp来把超5ms变成合格。
3. **有界分段持久化。** 一个串行后台 writer，按已保留的真实seq顺序编码小段并原子发布段描述/hash。frame/event/control均有序号与真实native时间。main仅保留原有基线/分析所需的有界近期窗口和有界待写batch；全部完整采样均在durable段中保留，不是删历史帧。预算按未编码值/allocator实测成本制定，不能仅按压缩后JSON bytes假定内存。初始实验矩阵用8/16/32帧段与有限双batch队列；单帧超预算也须明确capture failure，不能裁字段让它塞入预算。
4. **背压与 cap 是显式终止。** writer落后且无法预留下一完整记录时，在开始下一次UIKit读前停observer并写小型overflow/原因/lastReadSeq/lastCapturedSeq/lastDurableSeq。所有已完成记录必须保全；不能丢队列坏帧或伪补连续。18000仍是原max-count；资源overflow是公开失败，不是降低验收标准。达到cap只invalidate sampler、排队终止记录；绝不在CADisplayLink回调同步整包导出或释放巨型array。
5. **单导出预算与真实ACK fence。** 一次只有一个后台导出工作；flush指定真实prefix fence，只有相关段实际落盘并原子发布manifest后才ACK该nonce/revision/seq。不生成完整多GBData，不并发重复桥接同一图；同一fence可复用持久化成果，但每个请求仍保留自己的fresh nonce/实际完成记录。timeout/磁盘失败/不完整段明确拒绝，不把“已排队”当已保存。
6. **同记录精确祖先复用另测再加。** 如果仅分段仍达不到预算，在后台对每次已经读取的完整ancestor row做精确typed-value/Double位模式比较，建立**该记录内**的defs/ref表。每个动态值仍实际读取，不按pointer或上一帧未变来省读；reader展开后须与原值逐字段相同。不能先假设87KB节省一定实现，也不先引入跨会话通用graph缓存。

这个方案需要新纯值/有界writer模块、明确v4 reader、控制ACK及Observer近期窗口接线，约数百行新模块加针对性I/O测试，不适合当P1/P2旁边的十行后台Dispatch补丁。原strict smoke/moving/stationary文件保持冻结；新native诊断必须显式使用v4流式读取入口，未经等价性验证不能签严格通过。整包legacy JSON即使以流式写到磁盘，也不能让旧json.load reader无条件加载多GB。

## 阶段与验收材料

- 阶段A：冻结P1/P2/立即读回，main只做一次短程prepare→read→AX→read并终止自有App；自动pan继续暂停。长时UI用独立viewer-only包，manifest明确observerDisabled/noHistoryEvidence，fixture不构造Observer、不加载history-QA clock sidecar，不假造ready/clock/capture。生产App/Host payload和其他native metadata owner保持原样。
- 阶段B：纯Foundation压力测试用本次真实深层结构，覆盖动态geometry逐字段变化、缺/错seq ref、落盘失败、writer backlog、cap、重复flush、取消/超时、所有已采样帧的连续顺序与hash、无UIKit对象越界及真实有限内存。测试流式处理18000记录而不是同时构造18000个Any图；所有bad-frame/gap必须原样恢复。
- 阶段C：完整SDK编译后，由main独占新artifact测读窗、RSS、flush响应和最终保全。保留全部raw采样/gaps，测量阈值仍原样；没有性能证据就不进入自动历史验收。

当前v3仍有整包内存/flush阻塞，**没有被这份设计修好**。在阶段B/C完成前，不应把P1/P2新包用于长时UI或自动历史pan；viewer-only关闭Observer的bootstrap/build入口仍由main在独立profile落实，不把“没有观察器”当历史稳定。
