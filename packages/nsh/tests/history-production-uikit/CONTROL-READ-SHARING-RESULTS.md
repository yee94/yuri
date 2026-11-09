# control-read-sharing-v1：92aa红反馈与同轮coverage事实共享

本revision实现control同轮无损共享与完整freeze计时，并修正构建阶段的进程看门狗。**SDK身份写入仍未修复**：当前公开API没有将既有NSH TextView的UIKit setter写入其test_id backing的入口。保留所有尝试、十个binding、失败读回和完整几何/遮挡审计，不把缺端口伪写成成功。

## main实际92aa结果

`.scratch/nsh/identity-92aa2cd2-sequence/`为main严格唯一prepare→read→AX→read，无pan/输入；pid28818，nonce `4DF271EA-8962-4FD6-B0C0-9182DA96F71B`。main已耗尽三个fence：prepare为214 event/14 frame/1 control，最终219 event/14 frame/3 control。worker未触碰该进程。

14个baseline frame全部≤5ms：首帧2.8271666765213013ms，min2.3340415954589844/max2.906000018119812ms。这只签收本轮14帧、0 bindings基线，不签长时压力、带bindings周期帧、SDK adoption或原−53pt。

新增真实失败：10次identifier写入即时getter均nil，prepared=false、readback=0。两个完整control读窗为225.37262511253357/229.2133333683014ms，各10 bindings；首读liveCoverage.inspectedCoverageNodes合计2877（含路径/根发现计账，不能当作2877次完整geometry调用）。每个binding的完整ancestorVisibility约28层；之前无binding的control绿不能覆盖这个规模。

| 原始证据 | SHA-256 |
| --- | --- |
| prepare.json | `f2a83da83326e005288dd3bd16615fdb43594414639780ce45df8e1531fb69d9` |
| native-before.json | `9ae060fee90297106ed6569d6955df922b0c48e78631ff7b6bcaa88013ec6793` |
| native-after.json | `cd9b03f5fe1fdd7d962723f7b3b4ab6d2725d33cdf1f2e8ce0ecb0ee3aacf89d` |
| frame-control-costs.json | `d4478b8ee9da56131b61d2c828ba15b59ef94b013d829650ba12c4cd9d711957` |

已执行一次仅读取上述小receipts的红反馈命令，断言10/10 nil、两次control都10 bindings，输出 `RED actual92aa: getter nil 10/10; complete control reads ms: [225.37262511253357, 229.2133333683014]; original budget 5ms`，exit1。没有新设备操作或第二次prepare。

## SDK getter/setter根因与证据边界

读取本机已冻结的公开e626a8d源码：

- `crates/nsh-platform-ios/src/native_view.rs:124–127`：NshView覆写公开accessibilityIdentifier getter，直接读 `self.ivars().props.borrow().test_id`，没有调用UIKit superclass getter。源码中没有对应setAccessibilityIdentifier覆盖。
- `crates/nsh-platform-ios/src/text_view.rs:194`：TextView继承NshView；只另行覆盖isAccessibilityElement、label及traits，没有替代identifier backing。
- `crates/nsh-js/src/declarations.rs:263`：公开ViewRef只有focus/blur/measure，没有对任意已有节点setProp/testID的入口。
- `crates/nsh-base/src/text_view/view.rs:22`：TextView支持root的标准testID、特殊code/custom renderer等，没有通用正文叶子testID/render hook；root testID不能假装叶子身份。

SDK源文件SHA：native_view.rs=`0f7dbe95ac843c1496cc0fcd143a2962c23deb3ab4d6bbcd8d0f7c0a58465ae8`，text_view.rs=`44b254f593624379c5293f305db3f81a6b51358b37d5db59212e096e42b34fa7`，declarations.rs=`28a13211c689bf48f4caf98f75a624426bf9a3e0b77b719b74224a3709e2b879`，TextView view.rs=`a1f0815499ddecc9060d20011eedea05c7c94b4fcf2a383ce10fe5192b18000d`。

同时读取实际92aa可执行文件的nm/disassembly，确有NshView.accessibility_identifier符号，地址0x10020ed2c；该函数读取Rust ivar内字符串，可见空值直接返回0、有值调用NSString::from_str。没有到UIKit superclass getter的调用，与e626a8d源码及main即时nil证据一致。直接nm静态archive遇到Apple LLVM不识别Rust LTO attribute，因此二进制核对使用的是**实际已链接92aa App**，没有将失败的archive命令算作证据。Context7当时quota不可用，结论来自上述精确版本公开源码、已链接二进制和main实测。

UIKit继承setter没有写到NSH getter读取的props.test_id，因此赋值后getter仍nil不是“稍后才adopt”或可以反复抢写的问题。不能用私有类补丁、swizzle、KVC、覆写方法、AX overlay、label匹配或body wrapper冒充正文token来绕过。缺的是SDK公开且与getter同backing的写入路径；边界和可交给SDK owner的最小合同见 [SDK-IDENTIFIER-PORT.md](SDK-IDENTIFIER-PORT.md)。

## control重复工作的根因与最窄改动

旧路径的乘积为：bindings × sibling扫描实际访问节点 × 每节点完整ancestor geometry。coverage只需要frame、真实祖先clip、visible、geometryKnown、clipsChildren，却为每个访问节点调用geometry()，构造所有transform数组、完整ancestorVisibility字典及presentation frame，然后另走一遍clip链。十个binding还重复遍历公共祖先和覆盖子树。

新增Foundation/CoreGraphics的 `v4/CoverageReadMemo.swift` 及UIKit adapter `v4/ControlReadContext.swift`：每次v4 control-read开始创建新context，在这一同步读窗内只缓存实际public只读原始事实及与目标无关的coverage facts。没有跨read、跨nonce或跨帧缓存；context不存入Observer字段或writer。保留leaf→root alpha相乘与clip相交顺序，不重新结合浮点计算。真实attached、祖先隐藏/透明、affine/layer/sublayer transform、animation/presentation差异、mask全部保留。

每个目标的根发现、zPosition/顺序规则、capacity=8192、未知/耗尽判定、blocker顺序和inspected计账仍独立执行；继续调用原HistoryCoverageTraversal.scan。缓存容量8192只限制复用，不限制检查：用完则真实计算但不存，不因容量返回空成功。原hitTest和“hit不覆盖未知”的判定完全复用。完整binding geometry和所有ancestorVisibility仍由原geometry函数输出；没有跳过invalid/retired bindings，没有删除旧字段。

纯值回归以634节点、约28层祖先、十轮请求做逐字段谓词对照：共享原始sampleReads=634，重复fact命中5454；旧模型采样175740次。该数字是明确模型的操作数，**不是**把main缺失的旧operation counters补造成实测。变体覆盖隐藏、临界alpha/NaN、transform、animation、mask、detach、clip、禁用缓存；下一read的新memo必须重新看到变更。它证明复用的操作数与静态谓词一致，不证明真实control已≤5ms。

新增 `historyProductionControlCoverageSharingParityRegression` 只做SDK编译，留给main执行，不并入之前三个原UIKit函数实际pass。旧sibling扫描正文保持不变；原liveCoverage仅增加内部已观测coverage参数，默认仍运行旧路径。历史hash测试只归一化这两处显式seam变更，仍对照原冻结正文，未改旧artifact或v3默认采集。

## 完整control计时和冻结

显式readPhases诊断增加window结束、每binding的candidate/geometry/coverage分段时间、CPU及操作计数。记录coverageFactRequests/hits、真实publicSampleReads/hits、ancestorSteps、coverageReads、完整binding geometry数与inspected总数。所有诊断构造开销仍进入总wall。

v4 read-ax在最终readEndNativeMs之前完成整个result的native纯值freeze，再更新最后结束时刻；persistControl接收并复用这份不可变typed result，只冻结小ACK header。不会为了显示≤5ms把十个binding的转换留在读窗外，也没有第二次深freeze。原actual native clock、control独立当前window、durable fence及ACK职责不变。

5ms、250ms、1.1pt、三完整body及18000等原门槛均未降低。SnapshotValue/typed bit codec、writer、reader、原Profile/run-pressure和压力输入不变。新增字段/诊断和本控制规模需要main实际验收，不能借旧纯值压力或14帧baseline签收。

## 构建看门狗

main的fullnormal 1b2a4252先通过typecheck，之后全Swift `-O`链接在旧240000ms上限超时；partial artifact保留，不能称appBuilt。内存压力与并行Rust build存在，未归为compiler bug，也没有改font/附件owner或删输入/关优化。

builder现在仅完整优化链接为600000ms，typecheck及其它工具仍240000ms。Swift两个阶段用同一看门狗，输出stage/start/end/error、UTC起止、elapsed、exact PID、errorStage及code。超时/取消只从本次spawn取得的PID向下发现后代，逐PID核对birth，再停止并终止这棵实际子树；不按命令名称、全局swiftc或进程组kill。失败保持partial与appBuilt=false。

专项用TERM-resistant driver＋child验证超时清理，仅清理两者、当前测试进程不在ownedPIDs；阶段错误为ETIMEDOUT。没有放宽任何5ms或测试性能断言。新完整构建在SDK typecheck/object回归通过、own源码冻结后只运行一次；具体产物与完整hash另冻。

## 本轮验证与未完成项

control-read/build-process/identity专项3文件6项通过；observer/native-snapshot/insets专项3文件9项通过，包括新增UIKit parity函数与完整builder输入的SDK typecheck、Observer/probe object编译。没有在worker运行UIKit、设备或Host。最初control模型缺CoreGraphics import导致编译失败，补齐后才计入通过；先前外层测试超时后的exact-own编译进程检查未发现残留。

**身份仍未完成，control真实≤5ms仍待main。** 新包继续保留原即时getter失败及所有binding，预计缺SDK端口时prepared仍false；它主要供main验证十binding完整control成本，不能称身份修复包。原5e/db06/92aa证据、pid28818/原nonce、SDK adoption unknown、原−53红灯和自动pan暂停全部保留。

独立 [f37195ff产物冻结](CONTROL-READ-F37195FF-ARTIFACT.md) 已完成：完整优化链接171.202559s，appBuilt=true，未运行。TS通过，dead-code退出0/专项0；原132 unused files/795 unused exports提示保留。构建watchdog最终再跑2文件4项通过，没有另外启动重复的完整优化链接测试。
