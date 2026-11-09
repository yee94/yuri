# native-freeze-v1：首次freeze对照、无损改动与92aa2cd2短程包

已实现v4读取值转换优化，并构建独立可安装Simulator App **92aa2cd2**。本轮离线实测定位到首次Swift协议一致性查询路径的CPU开销；没有将db06整个18.275ms都归因为cold setup，也没有签收新包真实UIKit性能。原5e595357的5.777ms与db06的18.275ms均保留原失败，5ms不变、首帧不删、不减诊断成本、不重复prepare。

## main实际db06证据

`.scratch/nsh/identity-db06f6d2-sequence/`来自main唯一prepare→read→AX→read，无输入/noPan，pid81307、nonce `4B3EC25D-25A4-41CC-9070-8AC625698BF1`。242 event/13 frame/1 control的完整prefix已由main耗尽验证；prepared=false、无ID，两个control预算内，AX token=0。frame-read-costs.json SHA256 `73898fe75f86f801e52de362990529c9f1c4e56e20015e17674c784c91064e66`，native-before.json SHA256 `8cc389267bb3e5427bb0b860fa11e78ea43d24d2e74f3d2bfa0eb5df37834941`。

首帧readMs=18.27537500858307，readPhases.admissionEndNativeMs=565153115.0345417（db06源码中它与nativeUptimeMs使用同一started），由此总end=565153133.3099167。windowEnd→windowFreezeEnd=9.552208304405212ms；assemblyEnd→smallFrameFreezeEnd=2.1380417346954346ms。634 views、3 scroll、3 new pan traces、0 bindings；6次inset getter累计0.013749957084655762ms。三scroll八边均0只说明该次场景，不外推旧−53。旧数据没有线程CPU，不能从wall区间直接分解CPU与调度等待；首帧后12帧不代替首帧验收。

## 反馈循环与最小化

离线工具 [v4/freeze-first-read.py](v4/freeze-first-read.py) 从main小native-before读取window值，按Observer实际构造点恢复native字段类型：rect/insets为[String:CGFloat]，transform为[CGFloat]，layerOpacity为Float，时间Double，计数Int，bar/ancestor数组为[[String:Any]]，实例数组[String]。去掉control-only liveProtection，nativeTextOwners设为periodic实际空数组；没有UIKit调用，不把JSONSerialization解析后的Foundation容器直接当原native类型。该重建与首帧periodic值不是同一时刻的观测，所验证的是实际构造类型/规模下的转换路径，不冒充原设备复现。

逐个独立进程执行首次freeze和后续15次freeze，随机固定种子交错变体，同时测wall与CLOCK_THREAD_CPUTIME_ID；不复用进程抢首次好结果。每个变体都用原TLV编码，所有输入字段/位必须得到相同字节SHA。初轮16进程能复现旧首次freeze>5ms；24进程容器分支消融与20进程bar/null最小化后，30进程完整图验证如下。

| 完整window，30独立进程/变体 | 首调wall median / p95 / max(ms) | 首调线程CPU median(ms) | 后续wall median(ms) |
| --- | --- | --- | --- |
| 原freeze | 1.457938 / 4.107125 / 8.930542 | 1.115500 | 0.284333 |
| native adapter，去掉null分支 | 1.319771 / 4.505125 / 6.781333 | 0.963001 | 0.135146 |
| 新native adapter | 0.180063 / 0.332167 / 0.336250 | 0.182750 | 0.134125 |

新adapter首调CPU max=0.272292ms。全部变体/进程TLV SHA均为 `7b43ad6dea200d0b51d9bb44ddea6ba8f1fc388b8e130a22c0bb0cf249777987`。完整图结果JSON SHA=`e295f4d348198a8743f4d822a9f62a2c601c6405cc87117ab41184954451db7d`，保存在本会话工具临时目录的 `freeze-first-db06-combined-v4/results.json`，旁边保留每个变体源码/binary/所有TLV/每次CPU与wall。

单独优化root对象、geometry容器或NSNull均不能消除整个首次通用分派；仅bar图中旧首调CPU median1.250646ms，新adapter0.1825835ms。完整图还含SDK-adopt=null，未特判null的adapter会回到旧通用协议检查路径，首调CPU因此仍明显存在。优化不删除null，也不把adopt补成ACK。

红反馈命令（它**故意对旧baseline判红**，即使同轮candidate已改善）：

```sh
python3 packages/nsh/tests/history-production-uikit/v4/freeze-first-read.py --input .scratch/nsh/identity-db06f6d2-sequence/native-before.json --output "$HP_FRESH_OFFLINE_OUTPUT" --runs 30 --max-first-ms 5
```

已实际运行的完整图返回 `RED: first native-type freeze exceeded unchanged budget; full samples preserved`（exit1），旧max8.930542、新max0.336250；不是把红反馈工具失败伪写为全部通过。输出目录必须全新。该5ms只是离线反馈红线，新App仍按原真实读窗判定。

## 进一步分离协议检查、类转换和调度

用同一实际SnapshotValue源码中的两个private协议，构造最小NSNull输入，在30个新进程中分别首先执行负向array/object协议检查、NSNull类转换、精确metatype比较与原freeze。协议probe源码保存在结果目录，变体固定种子交错。

| 首次操作 | wall median(ms) | 线程CPU median(ms) |
| --- | --- | --- |
| `value is any HistorySnapshotArrayCopy` | 0.919708 | 0.6390415 |
| `value is any HistorySnapshotObjectCopy` | 0.895667 | 0.6196040 |
| `value is NSNull` | 0.001875 | 0.0034375 |
| `type(of: value) == NSNull.self` | 0.000833 | 0.0023125 |
| 原freeze(NSNull) | 0.960604 | 0.6879165 |

warm协议查询wall median约0.000292ms。时钟读数自身有固定成本，µs级CPU与wall范围不完全相同，不据细小差额推断调度。结果JSON SHA=`05fc256c47eba8149df821edddfaf6ae6b3d29c95db3371935ef8621120dc2d0`，`freeze-first-db06-protocol-v5/results.json`保留所有原样本。

这确认了本离线场景中昂贵的是首次Swift协议一致性查询路径，类转换本身不是该数量级；adapter组合消融证明该路径对首次CPU差异有因果作用。没有符号栈证据区分Swift内部conformance注册表扫描、metadata构造或dyld具体实现，因此不将其细化为未经测量的内部根因。旧baseline存在wall显著大于thread CPU的样本，调度/等待不能排除；更不能仅凭离线CPU减少宣称main18.275ms全部解释。

```sh
python3 packages/nsh/tests/history-production-uikit/v4/freeze-first-read.py --input .scratch/nsh/identity-db06f6d2-sequence/native-before.json --output "$HP_FRESH_PROTOCOL_OUTPUT" --runs 30 --protocol-probe
```

## 改动与无损边界

新增Foundation-only `NativeSnapshotValue.swift`，只对精确native类型[String:Any]、[[String:Any]]、[String:CGFloat]、[CGFloat]、[String]、[String:Double]、[String:Int]及NSNull做直接纯值转换；其他值仍调用原freeze，未知引用保持拒绝。没有新reader/writer、unchecked Sendable或description兜底，没有修改原SnapshotValue/codec。所有CGFloat→Double、负零、NaN payload、无穷及subnormal保持原位语义。

只将v4 typedPeriodicRead的window freeze、small-frame freeze及诊断metadata/counts转换接入该adapter。binding typed geometry、公有getter、实际UIKit读取顺序、原frame字段和native clock保留。没有动态值cache、提前读UIKit、warmup或一次setup移位；优化直接使通用类型查询不再成为这批已知native容器的必要工作。v3默认采集合同不变。

阶段开关仍默认off，本包显式开启；新增window读前/读后/freeze后thread CPU，以及small-frame freeze前/后、总read起/止CPU。CLOCK_THREAD_CPUTIME_ID失败时省略phase对应项、总readEndThreadCPUms=null，不能默认0或据此绿。最终wall readEnd仍在metadata构造后，预算包含CPU诊断自身，不减metadata/时钟开销。CPU用于解释wall，不用于替代5ms验收。pipeline初始化仍在原位置记录，不预热。

回归覆盖全部新增native容器、native/Foundation混合fallback、负零/NaN等数值位、原字段/allocator计账/完整TLV一致、快照不随源字典变化、未知引用拒绝；用测试内计数确认旧通用freeze调用至少减半，避免只有一组时延好看的结论。独立window重建所有变体TLV一致。

## 新包与验证

产物：`packages/nsh/.nsh/history-production-uikit-v4-identity/2026-11-08T00-41-44-581Z-92aa2cd2/HistoryProductionUIKit.app`；bundle ID=`example.nsh.history-production.run-b2d61f28`，arm64 Simulator、SDK26.5、ad-hoc签名。机器索引 [NATIVE-FREEZE-ARTIFACT.json](NATIVE-FREEZE-ARTIFACT.json) 保留完整hash。manifest SHA=`88c91bfcceb05f4581784b0558f7940fea4177e4e1b1761e83b236da7dc3c1a4`；exe SHA=`9a6b3d7a795b6c59a5e0b409f5fbca7e17ae5616e405d86ed7297bb6972d3b2e`；bytecode SHA=`5246869e983c8f3a4b4fc45d44616f15b8d7efe089c9c0ddba36a1e738361dee`。

已完成完整SDK链接、NSH编译/签名、codesign strict验证、包内native/tool/binary hash及Info.plist核验。最终focused **5文件13项通过**（native-snapshot/identity/insets/v4-sdk/observer，含UIKit probe编译，不运行UIKit）；TS检查通过。SnapshotValue、writer、pipeline、reader、原Profile/run-pressure与422568-byte压力输入仍按原指纹，不覆盖旧18000结果，也不将离线优化签成新完整frame/长时RSS通过。

dead-code退出0、专项0；全仓132 unused files/795 unused exports提示保留。测试夹具初次有throwing autoclosure编译错误，修正后再跑通过，未记作生产优化失败或性能通过。

其它owner当前NativeFontOwner/Registry相比db06又有源变化，原样纳入本包manifest，未修改其实现；Host输入仍是ab87119b…，不能将整包时延差全归adapter。旧包、原失败、旧机器索引及main进程均未改；无Git/依赖安装/设备或Host操作。

## main唯一新短程

保持原db06进程/nonce与证据不动；本包是独立bundle/sandbox。main选择HP_UDID/HP_HELPER/HP_EVIDENCE后，沿用原AX项目→会话导航，不输入、不加载历史、不pan。

```sh
HP_INDEX="packages/nsh/tests/history-production-uikit/NATIVE-FREEZE-ARTIFACT.json"
HP_BUILD=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["buildDirectory"])' "$HP_INDEX")
HP_BUNDLE_ID="example.nsh.history-production.run-b2d61f28"
xcrun simctl install "$HP_UDID" "$HP_BUILD/HistoryProductionUIKit.app"
env -u SIMCTL_CHILD_HISTORY_SYNTHETIC_RUN_MODE -u SIMCTL_CHILD_HISTORY_SYNTHETIC_DENSITY -u SIMCTL_CHILD_HISTORY_SYNTHETIC_APPEARANCE -u SIMCTL_CHILD_HISTORY_SYNTHETIC_DIFF_LAYOUT xcrun simctl launch "$HP_UDID" "$HP_BUNDLE_ID"
```

导航细节沿用 [原AX控件协议](SCROLL-INSETS-MAIN.md)，但本包ready应为diagnosticRevision=native-freeze-v1、scrollInsetsRevision=scroll-insets-v1、readPhases=true、identity-only、periodicSampling=false、automaticInput=false。

```sh
HP_DATA=$(xcrun simctl get_app_container "$HP_UDID" "$HP_BUNDLE_ID" data)/Documents/history-production-v4
python3 "$HP_BUILD/tools/identity-probe.py" --build "$HP_BUILD" --data "$HP_DATA" --output "$HP_EVIDENCE/identity-sequence" --helper-origin "$HP_HELPER" --udid "$HP_UDID"
```

严格一次prepare→read→AX→read，仍保所有首帧、坏帧、gap、control及完整prefix。readPhases新增CPU只作对照：windowEndThreadCPUms−windowStartThreadCPUms与windowFreezeEndThreadCPUms−windowEndThreadCPUms分别看window读取和freeze；smallFrameFreezeEndThreadCPUms−smallFrameFreezeStartThreadCPUms看小frame；readEndThreadCPUms−readStartThreadCPUms看总区间近似CPU。wall/CPU测量点有少量时钟开销和边界差，不将差额武断认作全部调度。真实wall仍须≤5ms，不减诊断成本。若再失败保全后停止，不二次prepare抢绿；SDK adoption unknown、原−53红、自动pan暂停。
