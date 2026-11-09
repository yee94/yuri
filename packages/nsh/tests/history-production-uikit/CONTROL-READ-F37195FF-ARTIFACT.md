# f37195ff：十binding control复验包（身份未修复）

独立可安装Simulator App已构建：`2026-11-08T01-16-14-820Z-f37195ff`，bundle ID `example.nsh.history-production.run-1c6e0e21`，arm64 iOS Simulator、SDK26.5、ad-hoc签名。包内冻结源码/工具/二进制哈希、Info.plist和codesign strict核验通过；没有安装、运行设备或连接Host。

```text
packages/nsh/.nsh/history-production-uikit-v4-identity/2026-11-08T01-16-14-820Z-f37195ff/
  HistoryProductionUIKit.app
  manifest.json
  native/CoverageReadMemo.swift
  native/ControlReadContext.swift
  tools/identity-probe.py
  tools/clock-client
  tools/stream_reader_v4.py
```

机器索引：[CONTROL-READ-ARTIFACT.json](CONTROL-READ-ARTIFACT.json)。实现和92aa实际红反馈：[CONTROL-READ-SHARING-RESULTS.md](CONTROL-READ-SHARING-RESULTS.md)。身份端口仍需要 [SDK owner的公开合同](SDK-IDENTIFIER-PORT.md)，不把此包称为identity已修复。

| 对象 | SHA-256 |
| --- | --- |
| manifest | `3a809f1d933d60e6f731d94300bed6ef42b562eb11bde24ff91128f492c00d91` |
| signed executable | `2cf6e7a89c5581ac3d09aa828d43edd6e06f30cf555d22f9224bf3a2c1fe9f5a` |
| bytecode | `8007c304e45fa71055dc11182b458c639490fdec954cda8c4f5accdacaa09215` |
| Observer | `8ba6c4880d1af263e284a2eed2c331cc3c96addae41231d264be29c40969a542` |
| coverage memo | `6ba7382ac99114954f2de0bd0a76a817584e054061827efee36d2fd66423c145` |
| control context | `cf42eed972d582a5cfe059e39e4c78d1f8b4aeae88f238ded85b6c1e69072322` |
| build process watchdog | `62c8320932fa181a03199183164bff1c4dabf719a46eaaf78109f46692895bcb` |
| clock-client | `1664e155cea02100dd37a6aae8434d3b7c5071e41c46f375aaac8b05d6e82bba` |
| identity-probe.py | `a8b06f792d65017c3de4f4edc5522dbeece4465f040745a68690ed9c071c795f` |

当前其它owner的production/Host输入原样冻结在manifest；本包565个源文件，56个既有依赖。Host SHA为 `61b6f081786b2b0a7265c87c2dcecded73672598cce4181fd5b0d1a6cd578af1`，与92aa已不同，不将全包差异全部归因control。未修改font/附件/notification等owner源，未安装依赖。

## 单次构建证据

own代码冻结且SDK typecheck/object回归通过后，仅运行一次新build。main旧1b2a4252 partial不覆盖、不重试，不记成功。本轮结构化日志记录：

| 阶段 | 起止UTC | 时长/结果 | 上限 |
| --- | --- | --- | --- |
| Swift typecheck | 01:17:03.881→01:17:25.476 | 21662.642917ms，status0，pid85803 | 240000ms |
| 全输入`-O`链接 | 01:17:25.556→01:20:16.684 | 171202.558958ms，status0，pid86658 | 600000ms |

日期均为2026-11-08。签名、strict验证、clock-client及pixel-measure后续完成，最终appBuilt=true。该次没有触发链接timeout；不能由171s反推旧1b2a timeout不存在或归为compiler bug。600000仅是编译进程看门狗，所有5ms诊断预算、优化级别、Swift输入和测试阈值未改。TERM-resistant子进程的exact-owned cleanup由专项测试验证。

本轮focused两组3文件6项及3文件9项通过，另最终build-process/build两文件4项通过；包含memo谓词/操作数/新read鲜度、SDK probe/object/typecheck、位模式和身份原失败保护。TS检查通过；dead-code退出0、专项0，全仓132 unused files/795 unused exports提示保留。新增UIKit control parity函数仅编译，尚未实际执行。没有另跑完整`v4-sdk.test`的第二次优化链接，避免重复制编消耗；本包实际完整优化链接已完成。

## main唯一序列

原92aa pid28818/nonce4DF271EA…及全部旧证据不动。新包是新bundle/sandbox，默认没有周期采样、自动输入或pan。main按既有AX控件路径进入Chat，不猜坐标；必要时 `projects-toggle-history-project`，再 `project-session-history-production-500`，核实 `chat-header-metadata` / `chat-selection`。

```sh
HP_INDEX="packages/nsh/tests/history-production-uikit/CONTROL-READ-ARTIFACT.json"
HP_BUILD=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["buildDirectory"])' "$HP_INDEX")
HP_BUNDLE_ID="example.nsh.history-production.run-1c6e0e21"
xcrun simctl install "$HP_UDID" "$HP_BUILD/HistoryProductionUIKit.app"
env -u SIMCTL_CHILD_HISTORY_SYNTHETIC_RUN_MODE -u SIMCTL_CHILD_HISTORY_SYNTHETIC_DENSITY -u SIMCTL_CHILD_HISTORY_SYNTHETIC_APPEARANCE -u SIMCTL_CHILD_HISTORY_SYNTHETIC_DIFF_LAYOUT xcrun simctl launch "$HP_UDID" "$HP_BUNDLE_ID"
```

ready应为diagnosticRevision=control-read-sharing-v1、readPhases=true、observerProfile=identity-only、periodicSampling=false、automaticInput=false，build/process identity与新manifest一致。main设置自己的现有HP_UDID/HP_HELPER/HP_EVIDENCE；此处命令worker没有执行。

```sh
HP_DATA=$(xcrun simctl get_app_container "$HP_UDID" "$HP_BUNDLE_ID" data)/Documents/history-production-v4
python3 "$HP_BUILD/tools/identity-probe.py" --build "$HP_BUILD" --data "$HP_DATA" --output "$HP_EVIDENCE/identity-sequence" --helper-origin "$HP_HELPER" --udid "$HP_UDID"
```

只一次prepare→read→AX→read。不因SDK缺端口造成prepared=false再prepare；十个失败binding不能删。完整保全三receipt所指fence的所有frames/events/control，按冻结stream reader耗尽prefix。

两次read-ax重点核对：

- result.readEndNativeMs−readStartNativeMs仍须≤5ms，现在包含整个result纯值freeze及诊断开销，不扣metadata。
- result.readPhases.windowEndNativeMs、bindings[]中的candidate/geometry/coverage区间，以及valueFreezeStart/EndNativeMs与CPU；原window和每个binding完整geometry/ancestorVisibility/liveCoverage都在。
- result.readOperationCounts包含bindings/fullBindingGeometryReads、coverageReads、coverageFactRequests/hits、coveragePublicSampleReads/hits、coverageAncestorSteps及inspectedCoverageNodes。重复采集减少不能通过减少binding/审计字段/改变cap获得。
- 每次read创建独立context，第二次不能复用第一次的动态facts；对比读窗、对象实例与原遮挡安全字段，unknown/blocker不能因memo被清空。

本包缺SDK正式写入口，预计身份仍不通过；它只用于验证完整十binding control的无损成本优化。若原baseline未过，则依原规则无ID写入，不能把0-binding control绿冒充十binding成功；必须明确标注该规模未覆盖。若control仍慢，保留完整新phase，停止，不二次prepare抢绿。SDK adoption unknown、原−53红灯及自动pan暂停继续。
