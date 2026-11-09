# Identity-only 5e595357：可安装产物冻结

推荐本轮新包 **5e595357**，arm64 iOS Simulator target，SDK26.5、NSH compiler0.4.0(e626a8d)，完整Swift typecheck/link、bytecode编译、assets/grants/hash检查及ad-hoc签名验证均已完成。没有安装、启动设备、运行engine或连接Host；不把编译写成built Observer实际通过。

产物相对仓库根目录：

```text
packages/nsh/.nsh/history-production-uikit-v4-identity/2026-11-08T00-07-46-928Z-5e595357/
  HistoryProductionUIKit.app
  manifest.json
  tools/clock-client
  tools/identity-probe.py
  tools/stream_reader_v4.py
```

bundle ID：`example.nsh.history-production.run-e6f195ad`。可机读索引见 [IDENTITY-ARTIFACT.json](IDENTITY-ARTIFACT.json)，操作协议与全部控件见 [v4/IDENTITY-ONLY.md](v4/IDENTITY-ONLY.md)。这是Simulator可安装App，不冒充真机development签名。

| 对象 | SHA-256 |
| --- | --- |
| manifest.json | `ba86b10b8a3728d12045599fbb6631bbfa300187da9bfecb91d4182d763bcbca` |
| signed executable | `249cef5b1d3c8a499f265fd1217c72528cff4204d304ef458491258cc0214753` |
| bundle.nshc | `0a246339ff40b3b5682bf1c6450d45be466976dbd255912a28b7a44013673d65` |
| clock-client | `a02a90398d38c66f94d8d9fe18473d73a0e57501dbd73389eff440ad07f2ef2b` |
| identity-probe.py | `a8b06f792d65017c3de4f4edc5522dbeece4465f040745a68690ed9c071c795f` |
| Observer.swift | `ccd7fb08160dafb9b18ad61df44b5c52153f1535dc8abd327f284470eb2e26b9` |
| build.mjs | `28e0c22b322369bda521a3142464875ff07b2d4de201c0ceac175b0a8c13e4f2` |
| v4/build-identity.mjs | `6a444ca1488718b875cb7bc573f4d4a87ec336713a5634b62841d8a8aa456a28` |
| SyntheticHost.swift（其它owner源，原样冻结） | `94ae5500c9df0bff3337428c89ddf4bb037c80840310342af4f25bae65805933` |

首次551df328也构建成功并保留未覆盖；其stage之后其它owner新增两个normal项目配置读取路由，因此另建本包包含该最新输入。没有自行改Host/schema。以本包manifest冻结的native/、tools/、sourceGraph为准；不能将后来变化的live worktree文件误当本包编译输入。

## 默认行为与短程序列

Info.plist实查 `HistoryObserverSchema=v4`、`HistoryObserverProfile=identity-only`，没有CFBundleURLTypes。默认不注册CADisplayLink，没有周期几何采样；只允许main一次prepare触发目标275ms、最多24帧/600ms的真实native基线。原250ms稳定条件与5ms读预算不变，过预算拒绝赋值，不重试抢ID。随后只做read→AX→read；mark直接拒绝，没有pan入口。

精确main命令（先按协议用AX项目/会话控件进入Chat，不点输入、不加载更早消息）：

```sh
HP_BUILD="packages/nsh/.nsh/history-production-uikit-v4-identity/2026-11-08T00-07-46-928Z-5e595357"
HP_BUNDLE_ID="example.nsh.history-production.run-e6f195ad"
xcrun simctl install "$HP_UDID" "$HP_BUILD/HistoryProductionUIKit.app"
env -u SIMCTL_CHILD_HISTORY_SYNTHETIC_RUN_MODE -u SIMCTL_CHILD_HISTORY_SYNTHETIC_DENSITY -u SIMCTL_CHILD_HISTORY_SYNTHETIC_APPEARANCE -u SIMCTL_CHILD_HISTORY_SYNTHETIC_DIFF_LAYOUT xcrun simctl launch "$HP_UDID" "$HP_BUNDLE_ID"
```

main完成AX定位的 `projects-toggle-history-project`（仅需要展开时）→`project-session-history-production-500`，核实Chat的 `chat-header-metadata` / `chat-selection`。没有业务deeplink scheme，不猜控件坐标。

```sh
HP_DATA=$(xcrun simctl get_app_container "$HP_UDID" "$HP_BUNDLE_ID" data)/Documents/history-production-v4
python3 "$HP_BUILD/tools/identity-probe.py" --build "$HP_BUILD" --data "$HP_DATA" --output "$HP_EVIDENCE/identity-sequence" --helper-origin "$HP_HELPER" --udid "$HP_UDID"
```

工具只执行prepare-ax→read-ax→helper AX GET→read-ax，保存原始receipts后检查build/process/fresh nonce与实际durable manifest hash/revision/seq。没有launch/tap/mark/pan或第二次prepare。summary=collected不是PASS；分别查看assignmentReadbacks/readbackConfirmedCount、两次binding.valid/firstRetirementObservation、5ms暴露窗、AX matching count。prepared=false或getter非ours只保留失败证据，不据此打开pan。

## 冻结与验证边界

v4 SnapshotValue/TypedGeometry/SegmentWriter/CapturePipeline四个文件SHA与上一轮完全一致，纯值压力结果不被短程profile改写。sibling扫描正文SHA仍为 `7ad1f4603295649d823646c3e79f669d357862edb286fb93d8eaf79537d18eec`；identity policy enum插在WindowObservation与sampler之间，所以当前提取该片段的结束marker应为 `enum HistoryIdentityProbePolicy {`（仍包含WindowObservation结束括号），不是把新policy也算进旧扫描片段。

main的独立b1fe65f6 Debug UIKit三原函数已经实际pass，sourceHash9a7cf30b…范围无Observer/writer/Host/pan；本包built Observer身份短程尚未由main执行。原−53pt仍红、SDKadopt unknown、自动pan暂停，durable ACK仅为导出完成。

本轮先通过完整SDK link及Observer/probe object编译（4文件11项focused），新增身份序列4个Python反例和本轮focused回归3文件6项通过；源哈希、Info.plist、包内工具/二进制和签名核验完成。编译保留既有UIApplication.windows与AVAsset tracks弃用warning，未为消除warning改无关行为。dead-code退出0、专项条目0；全仓132 unused files/795 unused exports、NSH74 unused配置提示仍在。没有Git、依赖安装或设备/Host操作。

## 后续main实际运行（保留上文构建时冻结）

main已严格一次prepare→read→AX→read，无pan/输入。`.scratch/nsh/identity-5e595357-sequence/`保留原始证据；首帧5.7771666049957275ms超过原5ms，故prepared=false、无ID writes。两次control读窗通过5ms，identityReadbacks=false、AX token=0。完整fence000001 prefix经冻结reader耗尽验证：255 event/13 frame/1 control。SDK linked路径已实际起效，但控制身份未通过，不能再把此包写成“Observer从未运行”，也不能升级身份PASS。详细成本和下一独立revision见 [SCROLL-INSETS-RESULTS.md](SCROLL-INSETS-RESULTS.md)。本包及其机器索引仍保留构建时哈希与状态，不覆盖旧artifact。
