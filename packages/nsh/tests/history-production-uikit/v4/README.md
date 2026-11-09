# Native diagnostic v4 分段存储合同

这是显式新格式，独立于 v3 的 capture.json。生产 UI/SDK、main 的 ui-parity observer-disabled profile、旧 artifact 和 strict smoke/moving/stationary reader 均不迁移。自动 pan 仍暂停；纯值压力和 SDK 编译不签收 UIKit 读窗、实时性能或原−53pt问题。

最新control-read-sharing-v1见 [92aa实际红反馈及同轮共享](../CONTROL-READ-SHARING-RESULTS.md)。92aa实际baseline14帧通过，仅限该14帧；带十binding control约225/229ms仍红，SDK setter/getter backing缺口另见 [public端口合同](../SDK-IDENTIFIER-PORT.md)。没有通过私有类补丁或label伪造正文身份。

当前独立诊断revision为 [native-freeze-v1 / 92aa2cd2](../NATIVE-FREEZE-RESULTS.md)：在保留scroll-insets-v1的基础上，将已知native容器直接转纯值，避免该路径首次协议一致性查询开销；可选阶段诊断增加thread CPU读数。main db06实际首帧18.275ms失败仍保留，新包未实际运行，不将离线首次freeze降低写成UIKit通过。

## 所有权与读取边界

- `SnapshotValue.swift`：不可变、递归、checked Sendable 的纯值枚举。仅 main actor 的 freeze 适配器接受现有 public UIKit read 的临时 Any 输出；枚举与 record 不保存 Any、UIKit 对象、NSObject 引用、observer、closure 或 unchecked Sendable。未知引用类型拒绝，不能转成 description 或 metadata 默认成功。原生 Swift 容器通过专用私有协议复制，避免为一次 NSNumber/NSNull 类型检查把整个深层容器桥接到 Objective-C。
- `NativeSnapshotValue.swift`：native-freeze-v1的main-actor精确native容器转换入口，用于v4 periodic window/small-frame、完整control result及诊断metadata；纯值定义/codec仍归原SnapshotValue。精确容器及NSNull直接转换，其它类型回落原freeze，未知引用仍拒绝。没有UIKit依赖、缓存、预读或warmup；opt-in CPU时钟也归此窄诊断模块。旧压力Profile仍走原freeze，不能复用旧结果签新转换路径。
- `CoverageReadMemo.swift` / `ControlReadContext.swift`：control-read-sharing-v1仅在一个同步control-read内共享实际public原始事实和目标无关的coverage facts；leaf→root运算、全部原安全谓词、每目标cap/inspected、根顺序和hit test保留。容量只限制缓存，不截断审计；完整geometry及所有ancestorVisibility字段仍输出。context每read重新创建，不能存入Observer跨read复用，不能跨nonce或跨帧缓存动态UIKit状态。
- `TypedGeometry.swift`：v4 periodic 的深层binding geometry在实际读取时直接构造typed值，保留原geometry的全部字段与Double位，不先构造深层Any图再复制；原v3/control-read方法不变。小型window/header和frame其余字段继续使用main freeze。近期准备baseline仅保留它真正读取的root/window/nodes等字段，不另持有深层binding Any图；完整diagnosticIdentity保存在每个持久化typed frame中，没有从导出删字段。
- `CapturePipeline.swift`：main actor 上的资源准入、一个 accumulating batch、一个 in-flight batch、近期序号和 prefix fence。没有每帧 Task、无限任务队列或历史数组。一个已经开始的 read 即使遇到事件停止，也先完整提交该 frame，再记录终止边界；未知对象导致冻结失败时显式区分 lastRead 与 lastCaptured。
- `SegmentWriter.swift`：一个 actor 独占编码和 I/O。只接收纯值 records；不会读取 UIKit，也不接收返回 observer/UI 的 closure。每段及每fence的同步编码/I/O限定在独立autoreleasepool内，约束Foundation临时对象释放范围，不依赖actor任务调度恰好清池。文件写完后 fsync，rename，再 fsync 目录；segment 和描述符成功后才推进 durable prefix。manifest 与 metadata 同样持久化后才返回 receipt。
- `stream_reader.py`：只认 `history-native-segments-v4`。分段校验 hash，再逐 record 解码；不会 json.load 大 capture，不合并全部帧。消费者必须耗尽迭代器并完成尾部 prefix 检查才能声称完整验证；提前停止只能代表部分读取。

UI 字段仍在 main actor 同步读，记录实际 native start/end；v4 periodic 的 readEnd 还保守包含纯值冻结成本。≤5ms、250ms、1.1pt、gap、三完整 body 和18000上限不变。复制慢也不能挪时间戳造合格窗口。main 必须在新包独占测实际读窗、RSS和flush响应。

## 格式

manifest 为小型 JSON，schema 必须精确为 `history-native-segments-v4`，列出 nonce、revision、lastOrdinal、lastSequence、按顺序排列的 segment 文件/hash/字节数/ordinal与seq边界，以及 metadata 文件/hash。metadata 也是 typed value 编码，不是另一个 Any 图。每个已完成 segment 另有小型描述符，I/O失败时保留已发布文件，不签不完整 prefix 的成功 ACK。

segment 首6字节为 `HNSV4\n`，之后重复「4字节 unsigned big-endian record长度＋typed value」。record 只有 ordinal、kind、sequence、value；ordinal逐条加1，frame seq逐帧加1，event/control/clock/host/terminator引用当时的已采frame seq。所有原始坏帧、读窗、真实间隙、事件和控制完整保留，不按验收结果过滤。

typed value 标签：0=null，1=false，2=true，3=signed Int64，4=IEEE Double原始64位，5=UTF-8 String，6=array，7=object。整数及Double占8字节 big-endian；String/array/object长度占4字节；object按key排序。Double不经 JSON number，因此−0、NaN payload、Infinity均保留。reader用 `DoubleBits` 保存原始位，`.number` 才转换成Python float。Darwin原生Double必须在NSNumber桥接前取bitPattern，避免NaN payload被规范化。

periodic frame 保留全部原字段，只将 `diagnosticIdentity.windowObservation` 改为 `windowObservationRef: 当前seq`；同seq的外层 windowObservation 是唯一实际值。reader拒绝缺引用、错seq、inline/ref重复或缺window，并展开回原字段结构。control-read必须保留自己的当前window，禁止引用旧periodic观测。未实现ancestor interning，不按pointer或上一帧缓存任何动态geometry。

## 资源、停止及ACK

默认frame ceiling=16，可测8/16/32；allocator计账按完整纯值树保守估算，batch预算32MiB，下一次读取预留4MiB，至多一个编码batch加一个累积batch。字节预算可以先于frame ceiling触发分段，因此选择32不代表每段必有32帧。近期原准备baseline只保留350ms且最多64帧；原准备准入仍只使用最后300ms及原250ms门槛。seen/control/weak AX registry等既有容量约束保留。

在下一UIKit read之前无法预留时，明确 stop=`writer_backlog_before_next_read`，不开始这次读取。已完成的单记录超出allocator预留时完整保全它并停止，记录超预算原因；计账预算不是裁字段的许可，也不宣称任意单个未知大小输入永不超预留。typed编码在分配Data前检查每值≤64MiB、≤250000节点、深度<128，单编码batch≤128MiB；超限明确失败、无成功ACK，未持久值保留在有限失败batch中。正常深层规模的真实RSS必须以压力结果及main设备测量评估，不能把计账字节当RSS。

cap18000只停止并排入小型terminator，记录lastRead/lastCaptured/lastDurable边界；display-link回调不做整包JSON或host snapshot。后续单独Task收集有界metadata并排队prefix fence。event cap保持20000，record队列另有4000项资源停止线与终止记录预留。任何资源overflow都是公开失败，不改变验收标准。

flush请求在main同步固定ordinal/seq边界；writer按该边界切段，不拿后续帧偷换目标。fresh nonce和递增revision只在相关段、metadata、manifest实际持久化后返回；重复flush可复用已有段，但有独立manifest和新nonce/revision。等待超时或取消不返回成功receipt；持久化仍可完成，不能为了拒绝ACK丢已采prefix。writer I/O失败则不ACK，failure.json明确保留lastRead/lastCaptured/lastDurable边界；已发布段和此前成功manifest仍在，不回滚/覆盖它们。

control record保存提交时的原始观测/result字段，尚不是已发布的成功ACK。成功文件ACK才附加本次manifest的revision、durableOrdinal/durableSequence、manifest/hash，以及await持久化完成后生成的ackNativeMs；原nativeMs/readStart/readEnd不改成该时点。raw control里的旧revision字段保留原观察值，不能冒充v4的durable receipt generation。这个区分也避免把导出完成或内部scroll计数误当UI/SDK adoption。

control-read-sharing-v1将v4 read-ax的完整result纯值freeze纳入最终readEndNativeMs；persistControl直接使用该typed result，只冻结小ACK header。新增window/candidate/geometry/coverage/freeze阶段与operation counts也计入总wall，不从5ms扣减。v3默认的字段合同不变，旧artifact读窗值不重写。

## 显式入口

main构建新独立目录/版本（worker不运行此完整构建或安装）：

```sh
NSH_BIN=/path/to/nsh/bin/nsh node packages/nsh/tests/history-production-uikit/v4/build.mjs --scenario normal
```

也可显式使用base builder的 `--observer-v4`；默认仍为v3。v4输出根为 `.nsh/history-production-uikit-v4/<独立build>/`，Info.plist精确标记 HistoryObserverSchema=v4，App Documents使用 `history-production-v4/`。manifest与工具源hash冻结独立stream reader，原v3 driver在任何control前拒绝该新合同。main的ui-parity profile优先保持observerDisabled分支；本工作没有修改其main安装、Host或schema。

main仅进行已授权的短程控制/性能验证，文件握手使用新目录；成功ACK带durableOrdinal、durableSequence、manifest、manifestSHA256。完整读取另调用：

```sh
python3 tools/stream_reader_v4.py /path/to/history-production-v4/segments/fence-000001.json
```

这不是strict reader适配器，不会把v4自动送入旧pan链。`Profile.swift`、`stream_reader_test.py` 和focused Vitest为纯Foundation/离线reader压力与故障入口；实际成本、最终源码hash、验证状态和main接手边界另记交接材料。

## 原−53pt事件的证据边界

main转交的独立oracle结论与 `.scratch/nsh/production-history-review-1794040314/README.md:39–81` 一致：`[-53,-53,-53]` 是同一303帧事件里的三个目标，不是三次独立复现。302→303有1.033333s编码缺口，未证明SDK adoption，也未证明单16ms显示帧内瞬跳。缺口不能补成连续帧；多目标仍足以证明已录入的额外位移超1.1pt，不能据归因缺口把红灯取消。

main另转交SDK源码已有shrink先scroll再contentSize的结论；本轮不重新归罪算法调用顺序。首要候选是footer footprint收缩h，而旧offset o要求的o−h越过下界留下残差；实测尚未证明h=53。备选是grouped row内部head/metadata/body几何改变；row key稳定不保证内部文字锚点稳定。这些是待证伪候选，不写入存储成功ACK或装成实际测量。

| 证据 | v4保留的实际字段 / 明确缺口 |
| --- | --- |
| native scroll | scroll-insets-v1在同次scrolls[]读取及control liveProtection.outerTranscript中增加contentInset/adjustedContentInset的top/left/bottom/right，public getter各一次，原字段全保留；新增readStartNativeMs/readEndNativeMs覆盖同轮读取，frame/control总窗继续计入成本，不能用windowSafeAreaInsets代替 |
| footer自然占位 | nodes中的history-footer/history-footer-natural和当次实际controlAncestors保留；ancestor记录受原weak发现范围/深度约束，不能用缺席推出h或more=false |
| Composer/header | window/header实际几何保留；liveProtection中的Composer/header是control-read当前值，不引用periodic旧值 |
| row/body/text | body节点surface frame、binding text window/surface frame、bounds及完整ancestorVisibility保留；没有独立权威row-local文字锚点时unknown，不由stable key补造 |
| Host与key来源 | hostSequence、原Host journal/request/responseIDs/cursor等来源事件保留；Host response IDs不是权威before/after row-key adoption ACK |
| SDK adopt | sdkAdoptionIdentity保持null；无public observer port时为unknown，交正式SDK port owner未来补。scroll_applied即使可见也只代表内部scroll计数，不能充当整页adopt ACK |

scroll-insets-v1的变更前输入/性能指纹冻结在 [SCROLL-INSETS-BASELINE.md](../SCROLL-INSETS-BASELINE.md)，旧18000压力不签收新增字段后的真实frame成本。两组四CGFloat转换为原生Double字典后由既有freeze/typed TLV保留raw bits，不清理负零/非有限值；没有新增reader/writer、setter或layoutIfNeeded。v3默认includeScrollInsets=false，其字段合同与旧strict reader不迁移。

阶段计时由显式 `--read-phases` 开启，默认false；仅v4允许。启用的新包ready提供pipeline初始化前后时间，frame提供readPhases与readOperationCounts（视图访问数、scroll数、inset getter数、新建pan trace数及binding数），既有event通道另存diagnostic-frame-append的main-actor准入时间。阶段包含实际traversal、window read、window freeze、binding geometry/header、frame assembly及small-frame freeze；inset getter累计耗时是traversal的子区间，不重复相加。总readEnd在计时metadata冻结之后，5ms门槛不减去计时开销。异步actor编码/IO不在该append计时内，不把它报告成writer实际完成成本。不预热、不缓存动态geometry、不重试prepare，计时只能定位候选，不能凭首帧单次结果认定root cause。

manifest metadata显式标注ackAuthority仅为durable export，以及上述未采集项。footer experiment仍默认OFF；不加固定53、inset/JS offset补偿、不放宽任何门槛。v4先解决诊断扰动，原反馈与真实安全/性能/SDK采用证据仍需继续闭环。
