# scroll-insets-v1 与首帧阶段诊断

变更前性能、源码与输入指纹见 [SCROLL-INSETS-BASELINE.md](SCROLL-INSETS-BASELINE.md)。新revision保留原v4全部字段，在periodic scrolls[]及control liveProtection.outerTranscript同一native读取中增加contentInset/adjustedContentInset（top/left/bottom/right），两个public getter各一次，四边转Double纯值，沿用既有freeze/TLV/reader保留位模式。新增scroll readStartNativeMs/readEndNativeMs，frame/control原总窗仍包含实际读取与值构造成本。v3默认关闭新增字段，没有修改旧strict reader、旧包、Host或SDK，也没有setter、layoutIfNeeded或JS/固定53补偿。

## main的5e595357实际运行

main严格一次prepare→read→AX→read，无pan/输入。证据位于 `.scratch/nsh/identity-5e595357-sequence/`：prepared=false，原5ms超限，未写ID；两次control readExposureWithin5ms=true，identityReadbacks=false/AX token=0，是正确拒绝。main已用冻结reader耗尽fence000001完整prefix：255 event/13 frame/1 control。

frame-read-costs.json SHA-256为 `f0f869a3489e8f21ff99decf8882a363c75d8df43c53c7d22d399222a0f6ff04`。首帧564219421.06675→564219426.8439167，差5.7771666049957275ms；其余12帧为2.3485833406448364–2.947666645050049ms。保留失败，不删首帧、不将其排除出预算，不用同进程重复prepare抢绿。main原进程48717/nonce前缀0F62FBFF保留，worker未操作它。SDK linked路径已实际起效，身份准入尚未通过；冷初始化、调度竞争、系统UIView首读成本均未定因。

## 新阶段诊断边界

`--read-phases`默认off，只允许v4，显式开启的新包通过manifest.readPhases、Info.plist.HistoryReadPhases和ready标明。pipeline初始化只在原位置记录前后时间，没有提前UIKit读取。ready及导出metadata保存初始化区间。

frame.readPhases提供main-actor beforeRead准入前后、traversal结束、window读取起止、window freeze结束、binding geometry/header结束、frame assembly结束、small-frame freeze结束；readOperationCounts为视图访问、scroll、inset getter、新建pan trace和binding数量。insetGetterTotalMs仅是traversal内两个getter的累计子区间，不重复计入总时长。原frame readEnd在阶段metadata冻结之后，≤5ms判断不扣诊断开销。既有event通道增加diagnostic-frame-append，记录main-actor append的区间，明确不测异步actor编码/IO。没有新增reader或writer。

阶段时间不能独自证明SDK/getter触发布局或哪个调用发生lazy setup；没有CPU栈或UIKit测量时保留原因unknown。新包main仍只执行一次prepare→read→AX→read，失败即保全，不自动pan、不重试。旧18000压力仅是未加字段的纯值基线；新增字段后真实frame和getter成本必须由main单独验收。原−53pt红灯、SDK adopt unknown及独立文字锚点unknown保留。

## 字段与成本验证范围

新增专项把真实insets纯值helper提取到macOS夹具，以UIEdgeInsets形状stub隔离UIKit依赖，再使用实际SnapshotValue.freeze/encode和未修改的独立reader，核对periodic与control路径、两组八个Double位（负零、NaN payload、正负无穷、subnormal及有限数），并核对原offset/contentHeight/pan字段未丢。该测试不冒充UIKit getter实际执行。独立新增的UIKit parity函数供完整SDK编译，不计入main之前三个原函数pass。

纯值微基准对同一小scroll值分别freeze+encode，交错旧/新增字段各2000次，记录TLV字节和allocator预算增量及median/p95；它不执行UIKit、不读取动态geometry、不修改原压力Profile/run-pressure/输入，也不代表18000完整frame/RSS性能。确切运行结果与新包身份在独立artifact冻结中记录。

首轮独立成本输出：原TLV 81 bytes，新329 bytes，每scroll增248 bytes（两组inset占190 bytes，同轮start/end占58 bytes）；保守allocationBudget增3656 bytes，它不是RSS。旧/new freeze+encode median为6.166636/20.583277µs，p95为7.000053/23.124972µs，2000次/variant交错执行。该轮成本输出实际完成；同轮reader夹具因漏写frame.value.sequence失败，补齐后另跑完整位模式回归，未改变reader来放过夹具。计时是该小fixture在当时机器负载下的测量，不能外推完整frame。

构建过程中其它owner的AppearanceBridge先后依赖NativeFontRegistry/NativeFontOwner。诊断builder只补入当前现有的NativeFontCatalog/Registry/Owner三个Swift输入，不改其实现；最初缺输入的构建失败保留，不交付失败目录。新包manifest冻结它们及AppearanceBridge实际hash。与5e595357相比，这也是非inset的源输入差异，因此新包实时成本即使变化，也不能直接全部归因inset或认定首帧根因。最终完整链接与包内冻结校验另列。
