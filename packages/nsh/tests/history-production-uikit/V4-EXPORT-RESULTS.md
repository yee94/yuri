# v4 分段导出：本轮实现、成本与交接

这是合成历史诊断载体的存储修正，不是生产−53pt问题的关闭。原2,419,177,788-byte capture保留；本轮没有复制、hash整包或解析它。只使用422,568-byte native-before小输入的9-binding深层结构。没有运行设备、NSH compiler/engine、真实Host、Git或安装依赖；完整App构建、安装和真实RSS/读窗/flush验证仍由main独占。

## 已完成的实现

详见 [v4合同](v4/README.md)。新增不可变typed SnapshotValue、直接生成typed binding geometry的periodic读取、单actor串行分段writer、最多一个编码batch＋一个累积batch、真实prefix fence及独立严格stream reader。所有UIKit读取仍在main，periodic readEnd保守包含DTO构造；原≤5ms/250ms/1.1pt/gap/18000/三body门槛未改。所有坏帧和实际字段保留，不按验收结果过滤。

默认App参数为frame ceiling16、batch allocator计账32MiB、下一read预留4MiB；字节预算可先于frame ceiling切段。近期准备baseline最多64帧且350ms，持久化记录不受近期窗口裁剪。profile的8/16/32实验分别配置32/64/128MiB的batch计账预算，**不是把128MiB实验预算下发到默认App**；计账不等于RSS。

v3默认仍走其原合同；v4必须显式新入口、新目录、新schema和reader。旧native-v3自动driver及strict smoke按合同拒绝v4，未给旧reader加偷兼容。没有修改main的ui-parity main/Host/schema，NativeInputMetadata与Spellcheck安装及构建输入均保留。footer experiment仍OFF，无固定53或inset/JS offset补偿。

## 连续18000帧压力基线

`v4/run-pressure.py --mode typed` 重建每帧完整纯值容器，逐帧改变geometry，注入真实测试值中的坏读窗/非连续时间和nativeFailure标记；不会同时构造18000个Any图。这个fixture使用真实深层形状，但时间和变化是明确生成的测试输入，不是UIKit重放或真实60fps性能证明。每batch存在producer durability barrier，不能据elapsed或seq反推显示fps。

以下为加显式autoreleasepool之前的完整三组结果；三组源SHA由runner保存且结束时核对一致：

| frame ceiling / batch计账预算 | 帧 / 总record | Swift进程max RSS | peak queued计账 | 生产＋落盘秒（不含Python reader） | DTO生产median / p95 / max ms | 测试磁盘bytes |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| 8 / 32MiB | 18000 / 19218 | 29,753,344 | 28,127,632 | 179.564 | 0.477 / 0.840 / 62.239 | 4,447,930,035 |
| 16 / 64MiB | 18000 / 19218 | 32,948,224 | 53,130,336 | 295.711 | 0.698 / 1.261 / 113.278 | 4,100,747,849 |
| 32 / 128MiB | 18000 / 19218 | 500,023,296 | 103,137,130 | 185.397 | 0.562 / 0.801 / 64.511 | 4,013,631,444 |

每组独立reader完整消费18000帧、1058个event、159个control、1个terminator，验证ordinal/seq/segment边界/hash；216个>5ms坏帧、185个gap标记全部保留。每128帧及末帧对展开后的完整值做独立编码hash比对，三组均为 `9eb81cfd1b761ab038ccbd8e0a5acebc7b491b8ab1403b03a52536dfa259fd34`。另有boxed/native/typed三种128帧模型，逐字段直接对照小型原始JSON的独立source oracle，包含control和全部祖先行；不是只用Swift编码器自己的hash证明自身。

这些结果证明此次纯值模型保全了记录并避免整包驻留，不证明真实UIKit读窗≤5ms。max延迟没有删除，32帧RSS接近477MiB也没有隐藏。binary bit保真和测试每batch发布manifest增加磁盘成本，不能宣称压缩或体积改善；真实App的flush频率也与测试barrier不同。

针对32帧的计账/RSS差距，本轮进一步只在writer每段与每fence同步编码/I/O外限定autoreleasepool，避免Foundation临时对象跨段累积。它不改变schema、字段、seq、引用或ACK时点；复测及最终SDK结果在本文件后续冻结节记录。不能仅凭一次前后RSS差异签成唯一allocator根因。

### 释放范围收紧后的32帧复测

最终writer显式pool版本再次完整跑18000帧/19218 records：max RSS **497,745,920 bytes（约474.69MiB）**，peak queued计账103,137,130 bytes，Swift生产＋落盘168.513s，DTO median/p95/max **0.484 / 0.763 / 41.925ms**，磁盘4,013,631,444 bytes。全部帧、216个超5ms读窗、185个gap及终止记录再次保留，展开hash仍为上面的9eb81c…。

RSS没有明显改善，因此**没有证明该峰值的根因就是autorelease对象积累，也不能把32帧试验配置标为低内存或直接采用到App**。默认App仍是ceiling16/32MiB计账预算；32帧/128MiB仅为压力配置。writer显式释放范围保留，实际allocator与App峰值仍由main验证；本轮不为压低指标删字段/降cap/减坏帧或改阈值。

此次复测runner结束时核对全部6份core/reader源码SHA与当前一致。对完整三组基线的源码进行归一化比对，最终writer**仅多两个同步autoreleasepool wrapper**，编码、顺序、写盘、fence算法正文完全相同；其余压力core/reader文件未改。pool后boxed/native/typed逐字段source oracle和全部故障路径另通过focused回归，8/16组没有声称又做过一次18000帧全量重测。

生成压力段在独立temporary test目录完成reader验证后清理，仅保留小型results和manifest摘要；这些是可重建的测试数据，不是原2.42GB红证据，也不交付成可用的真实capture。runtime writer不会清理已发布段或旧artifact。

## 安全修正及未取得的证据

上层sibling越界子树修正独立冻结在 [COVERAGE-SUBTREE-FREEZE.md](COVERAGE-SUBTREE-FREEZE.md)，其两个实现片段SHA保持不变。真实public UIView夹具包含角落越界child、无touch/中心hit仍outer、clip开关，以及发现阶段与子树内部cap耗尽。它已编译，实际UIKit执行和原oracle复核仍待main；没有用Python只消费blocker来冒充发现层已跑设备。

`historyProductionTypedGeometryFieldParityRegression()` 构造public UIView并逐字段/Double位比较v3 geometry与v4 DTO，含hidden/alpha/clip/transform/mask；`historyProductionSnapshotRejectsUIKitRegression()` 验证UIView不能进入DTO。worker仅做SDK编译，main必须实际运行这三项UIKit夹具。

原[-53,-53,-53]仍是同一事件三目标，302→303有1033ms缺口，SDK adopt unknown。SDK源码顺序不能瞎归因；footer footprint h和grouped-row内部几何是候选，未证明h=53或stable key等于文字锚点稳定。现有字段逐项保全与明确缺口见v4合同：没有scroll contentInset、权威row-key adoption或独立row-local text anchor时标unknown。`scroll_applied`不是整页adopt ACK，durable receipt也只证明导出前缀完成。

## main接手

1. 用独立v4入口构建全新bundle；不覆盖旧artifact，也不把ui-parity审计重命名为capture。先运行上述UIKit夹具，保留实际断言和新包身份。
2. main独占短程prepare→read→AX→read，验证立即token读回及P1当前coverage/P2读窗。读回失败按失败分支记录，不重试抢ID，不打开pan。导出receipt不升级成身份或adopt证明。
3. 在独立性能profile实测真实PID RSS、periodic/control exposure、真实gaps和flush ACK响应；核对manifest prefix、全部segment/hash/终止边界，以及cap callback无同步整包导出。纯模型DTO耗时不能替代这一步。
4. main仍保持自动pan暂停，直到原oracle安全复核和真实新包性能证据成立；身份、三body、adopt、连续窗口或原−53pt任一缺口均继续标未完成。SDK public observer port归正式port owner未来补，本轮不改SDK。

## 最终源码冻结

以下是本轮新v4工作区源码SHA-256，独立于旧v3与coverage小修冻结，不覆盖它们。实际App完整依赖图与二进制身份由main的新build manifest继续冻结；此处不冒充已生成App。

| 文件 | SHA-256 |
| --- | --- |
| Observer.swift | `22c25a13c104cd8228c913cec06577ce1b790204c10ee07d0dc120dba0580fa2` |
| observer-sdk.swift | `40ee76235ef27c79c0f3f4440def39fd6802c6666112fcebb93ab8e89258a12c` |
| build.mjs | `c28866e8ec453bf700bac1c3f4561dc6ad61915feccedc2228ac448c9d4e0939` |
| observer.test.ts | `b78e4069ce8b8baa953541bcb2d4e9beade453b8853cd7b7093abe8e8fafdc94` |
| v4.test.ts | `756d23bd10e0af12a01ae652f441f2457cc2f7d222acfdadb4dff806a0b7ba89` |
| v4-sdk.test.ts | `400cc77fa6015707543c2cf8e6fb050a6149245b84e3e19e044dfa12beadac7b` |
| native-diagnostic.py（未改） | `16b5213df6947c75a1fa21543095f8298d67767c26ca246c86964abfbd059959` |
| native_diagnostic_v3.py（未改） | `ac0163d72611863044c79514d13693a95cf11e1ba225ad74557801895874a8f6` |
| v4/SnapshotValue.swift | `3784bcb2d0ddd68e98134309638d2b946a1425bbdc0c47ce5616417e24bf9f4a` |
| v4/TypedGeometry.swift | `eb274b6e4ccfa672bcfea429dded4684ac45d6acd1d46cd51f552e23dfdeed7c` |
| v4/SegmentWriter.swift | `b473233b9b213d2d0760aa8395f9b4029e4c876e8e1ace5a7567d0799eadc7fd` |
| v4/CapturePipeline.swift | `f89acc71d70eb1b7b51e6e8c9effe552ba6027787d77fb3e829948f2e94658c5` |
| v4/Profile.swift | `eefbf01ed1bd370cf36537a1e93e4602565cc45fc7391b1926c0923a0d433008` |
| v4/stream_reader.py | `0c72aeef8a18fe32243e779452e21fbc92d9e4676b9251ab86304ad8c8c145dd` |
| v4/stream_reader_test.py | `29ae6c636b8ab697d884252391aca0eeb3ed7945ea4cdcdd56e7e7d5068dee3c` |
| v4/source_oracle.py | `350eae691ee49f403dd7831e1fbffe2b4d667973f19e4ad845a712a28902090c` |
| v4/run-pressure.py | `f8e0b266ab973bf0aa694444167626f00671de3180f7961fb73ca4a81950d240` |
| v4/build.mjs | `0b01b1d31eb5d64b941d43de7ae54e408791bbd3984fed309bf5cf49abc40de6` |

## 最终验证记录

- pool后最终 `v4.test.ts` 1文件3项通过；随后SDK/原护栏回归6文件12项通过，合计当前7文件15项（分两次执行）。pool前同一7文件也曾一次15项通过，不将两次相加夸大覆盖数。
- 完整builder Swift输入集在真实iOS Simulator SDK / arm64-apple-ios15.0-simulator下优化编译并**链接**成功，产出临时flat probe binary后清理，没有执行它、生成/安装App或启动engine。同时通过完整输入typecheck、Observer/SDK probe/ClockClient object compile，前后核对源码字节未变。
- 纯core以Swift6严格并发编译通过；独立reader 5项反例覆盖错seq/ref、control不能引用periodic、类型/截断/重复key、schema/hash/prefix/file引用，以及v3自动driver在control前拒绝v4。
- 实际9-binding深结构回归覆盖boxed/native/typed字段等价、逐字段小源oracle、−0/NaN payload/Infinity、动态geometry、坏帧/gap保留、真实durable ACK gate、重复flush、新nonce/revision、writer/manifest I/O故障、ACK超时、取消等待者、capture取消、读途中资源停止及backpressure前置停止；未知NSObject拒绝，UIKit拒绝夹具仅做SDK编译。
- focused TypeScript tsc通过；Python AST与JS builder syntax通过。`bun run dead-code`退出0，专项条目0；全仓仍有132 unused files、797 unused exports与NSH 74 unused files配置提示，未改动这些其它owner条目。
- main的 `NativeInputMetadataBinding.swift`、`NativeInputMetadataOwner.swift`、`NativeComposerSpellcheckLease.swift`、`NativeComposerSpellcheck.swift` 仍在完整构建输入中。coverage实现片段SHA、未改的v3 driver/helper SHA与本轮表均重新核对。

worker范围的存储实现、纯值压力和SDK验证至此完成。**尚无实际UIKit夹具运行、真实App性能、token设备读回、原oracle复审通过、SDK adopt或strict PASS**；这些不因完整链接通过而升级。自动pan继续暂停，原−53pt仍未关闭。

### 后续main证据补充（不重写上述轮次冻结）

main随后提供 `.scratch/nsh/coverage-uikit-b1fe65f6/result.json`：三个原UIKit函数在Debug断言开启下实际正常return，status=pass，聚合sourceHash=`9a7cf30b3471f17ffcb8490ddb7d71aa46e8a9913a51bf29608e269b2e635b3b`。因此“三个独立UIKit夹具实际运行”已由main补齐；其范围没有Observer、writer、Host或pan，不扩展为长时性能、built Observer token读回或SDK adopt。

新的identity-only可安装包与短程控制协议另记 [v4/IDENTITY-ONLY.md](v4/IDENTITY-ONLY.md) 及本轮独立artifact冻结；不覆盖本文件旧Observer/build SHA。typed SnapshotValue/Geometry/writer/reader核心保持不变，5ms livecontrol和原−53pt红灯保留。
