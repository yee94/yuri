# 63a6c78d：v2 完整十 binding control 复验包

独立 identity-only Simulator App 已构建并完成包内冻结源码、工具、可执行文件、Info.plist 与 codesign deep/strict 核验。真实 ≤5ms 未验收，未安装或运行设备。机器索引见 [CONTROL-READ-V2-ARTIFACT.json](CONTROL-READ-V2-ARTIFACT.json)，实现与最终离线证据见 [CONTROL-READ-SHARING-V2-RESULTS.md](CONTROL-READ-SHARING-V2-RESULTS.md)。旧索引与失败 fbb58872 产物保留。

产物目录：`packages/nsh/.nsh/history-production-uikit-v4-identity/2026-11-08T03-39-00-826Z-63a6c78d`，App 为 `HistoryProductionUIKit.app`，bundle ID 为 `example.nsh.history-production.run-ca9d37d0`。arm64 iOS Simulator、SDK 26.5、ad-hoc 签名，冻结 565 个源文件和 56 个既有依赖。其它 owner 的生产源码随 staging 冻结，不把全包变化全部归因于 control 优化。

| 对象 | SHA-256 |
| --- | --- |
| manifest | `cb36c8113ae0ef259ca4dbcdab49606e50bcb726e18f442e67fe85b682922d88` |
| signed executable | `28098601e348dc09a778a433974081803016a229468a793a81f3d0614bda859e` |
| bytecode | `6c7f2044ce149561ef1dd274bc3e6d52b5d65ba15783d945faa3e0bb8d5c9589` |
| NativeShell framework | `01bd5a7a44ab72824c3bbb454db6d4a380ebd11fd3173ec77dd26abeacac5f82` |
| Observer | `d42d96dd6139e2b961cd8e9dc343608fc96333585b73097675c1b69712f296b8` |
| control context | `7cf5da1088301d6cfd82db3cbf4ba090e9e9e59b83a43767b4b50f1580abc64a` |
| control value | `1c69bcbc4011ee222b9679be13a41290037720597ec8c02c42ae9f9ee8e9ed24` |

NativeShell 使用原 distribution；没有独立 SDK setter owner 新产物的确认，不声称本包修复了 identifier backing。framework 哈希已流式复核，供该 owner 精确对齐。public getter readback 仍是本次写入的依据，成功写入也不等于 SDK adoption。

## 构建与验证

2026-11-08 UTC，typecheck 03:39:45.481→03:40:06.877，21486.226250ms，status 0；完整全输入 `-O` 链接 03:40:06.972→03:41:44.715，97836.875916ms，status 0。各自看门狗 240000 / 600000ms，未超时。原有 UIKit windows 和 AVAsset tracks 弃用警告保留；未为此改无关实现。后续签名与两个离线工具编译完成，最终 appBuilt=true。

源码专项 4 文件 9 项、去重后 builder/identity/insets 3 文件 7 项通过；TypeScript noEmit、builder 语法检查通过。dead-code 专项 0，仓库既有提示保留。最终纯值实验四份输入中与 App 共用的三份 Swift 文件逐字节匹配冻结产物。UIKit parity 函数只编译，尚未运行；离线 TLV 一致性不签真实几何或性能。

## main 单次序列

以下命令由 main 执行，worker 未执行。沿用 main 自己的 HP_UDID、HP_HELPER、HP_EVIDENCE，进入 Chat 仍用既有 AX 路径，不猜坐标。

```sh
HP_BUILD="packages/nsh/.nsh/history-production-uikit-v4-identity/2026-11-08T03-39-00-826Z-63a6c78d"
HP_BUNDLE_ID="example.nsh.history-production.run-ca9d37d0"
xcrun simctl install "$HP_UDID" "$HP_BUILD/HistoryProductionUIKit.app"
env -u SIMCTL_CHILD_HISTORY_SYNTHETIC_RUN_MODE -u SIMCTL_CHILD_HISTORY_SYNTHETIC_DENSITY -u SIMCTL_CHILD_HISTORY_SYNTHETIC_APPEARANCE -u SIMCTL_CHILD_HISTORY_SYNTHETIC_DIFF_LAYOUT xcrun simctl launch "$HP_UDID" "$HP_BUNDLE_ID"
HP_DATA=$(xcrun simctl get_app_container "$HP_UDID" "$HP_BUNDLE_ID" data)/Documents/history-production-v4
python3 "$HP_BUILD/tools/identity-probe.py" --build "$HP_BUILD" --data "$HP_DATA" --output "$HP_EVIDENCE/identity-sequence" --helper-origin "$HP_HELPER" --udid "$HP_UDID"
```

ready 必须为 diagnosticRevision=control-read-sharing-v2、readPhases=true、observerProfile=identity-only、periodicSampling=false、automaticInput=false，并核对本包 build/process identity。只一次 prepare→read→AX→read，保全三个 fence 的全部 prefix；不因 prepared=false 重 prepare，十个失败 binding 保留。若 baseline 不过导致 0 binding，明确标记十 binding 未覆盖。

两次真实总读窗 readEndNativeMs−readStartNativeMs 均须 ≤5ms，包含诊断、typed shadow、完整 freeze 和 owned cache cleanup，不扣 phase 成本。核对全部 binding geometry / ancestorVisibility / liveCoverage、安全 unknown/blocker、实际十 binding/full geometry/coverage 规模，以及 typedShadowEndNativeMs / contextReleaseEndNativeMs 和逐 binding AX frame/coverage phase。每次 context 独立，不能跨 read 复用。

若仍红，保完整 phase 并停止，不二次 prepare 抢绿、不恢复 pan。SDK adoption、权威 row-key adoption、独立文字锚点仍 unknown，原 −53pt 红灯及 32 pool 高 RSS 限制保留。旧压力通过不能签本包真实 frame；18000/250ms/5ms/1.1pt/三完整 body 门槛不变。
