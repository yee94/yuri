# db06f6d2：scroll-insets-v1 + 显式阶段计时

本轮交付包为 `2026-11-08T00-25-42-501Z-db06f6d2`，bundle ID `example.nsh.history-production.run-58595375`，arm64 iOS Simulator、SDK26.5、ad-hoc签名。完整NSH编译/SDK链接、包内冻结源码/工具/二进制hash、Info.plist和codesign --verify --deep --strict已通过。未安装、未运行engine或设备、未连接Host。main一次操作见 [SCROLL-INSETS-MAIN.md](SCROLL-INSETS-MAIN.md)，机器索引见 [SCROLL-INSETS-ARTIFACT.json](SCROLL-INSETS-ARTIFACT.json)。旧5e595357与其它中间包不覆盖。

```text
packages/nsh/.nsh/history-production-uikit-v4-identity/2026-11-08T00-25-42-501Z-db06f6d2/
  HistoryProductionUIKit.app
  manifest.json
  tools/identity-probe.py
  tools/clock-client
  tools/stream_reader_v4.py
```

| 对象 | SHA-256 |
| --- | --- |
| manifest | `2179c417c5f85e2fd8c60b37d70239c0d042c2521388351f3b738b790a667b82` |
| signed executable | `17ff0ab91a587886b962c7191b1c5f655fab9ed38335ed91e4c65165ddd3dedf` |
| bytecode | `908ec7857e8ae2cbcd4c0f7840413fb6e10d7330f59ddc8af8edbaccd6dcc658` |
| Observer.swift | `b449708511b37a927e06aed5ebfdbc619806231f9803fc7aa998e3a13eaebba2` |
| TypedGeometry.swift | `3a9b61cba2ec7e1b4c5cf3b6404d0e1be5c699f9b7f7cf6f5368730aad6dcc0e` |
| builder | `990fb15d3ddfca94b622a98eda94bf199d525264950a4c95c00380eb1209032c` |
| clock-client | `4c38a6aa2722ce89ba778965a03ab772fd1c0c179c7446bd71c544c5beda1bb7` |
| identity-probe.py | `a8b06f792d65017c3de4f4edc5522dbeece4465f040745a68690ed9c071c795f` |
| SyntheticHost.swift（其它owner冻结输入） | `ab87119bb6ac5c3ae60ea439b7c089c5174afe7ed9e7c6642876151f2c71ff9d` |

manifest/Info.plist核实：HistoryObserverSchema=v4、HistoryObserverProfile=identity-only、HistoryDiagnosticRevision=scroll-insets-v1、HistoryReadPhases=true。阶段计时一般构建默认off，本包明确用 `--read-phases` 开启。默认不注册CADisplayLink，唯一prepare才收集有限真实基线，原250ms/5ms/24帧/600ms合同保持；随后read→AX→read，mark拒绝，无pan。本包尚未实际运行，SDK adopt/原−53红灯和首帧根因仍未关闭。

新增字段与阶段范围、main旧5e595357实际失败成本、精确纯值基准见 [SCROLL-INSETS-RESULTS.md](SCROLL-INSETS-RESULTS.md)。每scroll增加248 TLV bytes（inset190＋时间58）及3656保守allocator预算；不等于RSS或完整frame成本。旧18000压力输入422568 bytes、Profile/run-pressure、SnapshotValue/writer/pipeline/reader指纹已复核不变，不拿旧压力签新frame性能。

最终专项3文件6项通过：insets.test.ts两项（位模式、独立reader字段保全、纯值成本及v3/v4默认合同）、identity.test.ts三项（含4个Python mocked反例）、v4-sdk.test.ts完整SDK链接一项。v4.test.ts三项（既有reader、独立staging及真实九binding/fault/source oracle）另轮通过；build.test.ts两项及observer.test.ts亦已通过。新增UIKit inset parity函数仅SDK编译，不计入main先前三原函数实际pass。TS检查通过；dead-code退出0、专项0，保留全仓132 unused files/795 unused exports提示。

曾有一轮reader夹具漏sequence、一轮编译时源码变动，以及字体输入缺失导致失败，均未计为通过或交付失败包。最终builder原样加入其它owner当前NativeFontCatalog/Registry/Owner三个编译输入；未改production或Host实现。包内Host与旧包也已不同，须按冻结manifest归属，不能将整包性能差直接归因inset。旧编译warning保留，无Git、依赖安装或设备操作。
