# 新scroll inset/阶段包：main唯一短程操作

新包身份见 `SCROLL-INSETS-ARTIFACT.json`。它与原5e595357使用不同bundle/sandbox，原进程48717和原nonce/证据保持不动。没有URL deep-link scheme，导航沿用 [IDENTITY-ONLY.md](v4/IDENTITY-ONLY.md) 的AX控件：必要时 `projects-toggle-history-project` → `project-session-history-production-500`，确认 `chat-header-metadata` / `chat-selection`，不输入、不加载历史、不pan。

以下只由main执行；worker没有操作设备或Host。HP_UDID/HP_HELPER/HP_EVIDENCE由main选择现有环境。每个新包只发一次prepare，不重启复用有segments的sandbox，不在失败后重试prepare。

```sh
HP_INDEX="packages/nsh/tests/history-production-uikit/SCROLL-INSETS-ARTIFACT.json"
HP_BUILD=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["buildDirectory"])' "$HP_INDEX")
HP_BUNDLE_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["bundleID"])' "$HP_INDEX")
xcrun simctl install "$HP_UDID" "$HP_BUILD/HistoryProductionUIKit.app"
env -u SIMCTL_CHILD_HISTORY_SYNTHETIC_RUN_MODE -u SIMCTL_CHILD_HISTORY_SYNTHETIC_DENSITY -u SIMCTL_CHILD_HISTORY_SYNTHETIC_APPEARANCE -u SIMCTL_CHILD_HISTORY_SYNTHETIC_DIFF_LAYOUT xcrun simctl launch "$HP_UDID" "$HP_BUNDLE_ID"
```

完成上述AX导航后，读取新sandbox的ready，核对identity与新manifest一致、diagnosticRevision=scroll-insets-v1、readPhases=true、observerProfile=identity-only、periodicSampling=false、automaticInput=false。初始化时间来自pipeline真实构造的前后，不是UIKit预读。

```sh
HP_DATA=$(xcrun simctl get_app_container "$HP_UDID" "$HP_BUNDLE_ID" data)/Documents/history-production-v4
python3 "$HP_BUILD/tools/identity-probe.py" --build "$HP_BUILD" --data "$HP_DATA" --output "$HP_EVIDENCE/identity-sequence" --helper-origin "$HP_HELPER" --udid "$HP_UDID"
```

冻结工具仍只做一次prepare→read→AX GET→read，原始ACK先保存。prepared=false时继续保留两次只读和AX结果，不重试赋值。之后按最后ACK所指fence，用本包冻结的stream_reader_v4.py耗尽整个prefix，保留所有帧、坏帧、gap、事件和control。不要只抽好帧，不要整包读取旧大capture.json。

逐帧核对scrolls[].contentInset/adjustedContentInset八个值与readStartNativeMs/readEndNativeMs；两次control核对result.windowObservation.liveProtection.outerTranscript中相同字段。原offset/contentHeight/frame/pan等仍在，windowSafeArea不是替代值。导出typed DoubleBits为准，不能经JSON重编码丢负零/NaN payload。

首帧及全部帧都计算原readEndNativeMs-nativeUptimeMs，不扣phase开销。阶段差可按以下关系查看，区间有明确包含关系，不能全部相加：

- admissionStart→admissionEnd：现有beforeRead准入，原native读窗前，另显式保留；
- nativeUptime→traversalEnd：public UIView/scroll遍历，含新pan trace初始化；insetGetterTotalMs是其中子区间；
- windowStart→windowEnd：window/header实际读取；windowEnd→windowFreezeEnd：window纯值freeze；
- windowFreezeEnd→bindingGeometryAndHeaderEnd：binding核验、typed geometry与header构造；
- assemblyEnd→smallFrameFreezeEnd：小frame freeze及typed字段装配；随后仍计入phase metadata冻结，最终总readEnd为准；
- event.phase=diagnostic-frame-append：main-actor append准入，不代表异步writer编码/IO完成。

同时看readOperationCounts与ready.initializationPhases，比较首帧和后续完整记录。它们可排查cost落在哪一段，不能单独证明某getter触发布局、调度/首次系统开销或actor lazy cost。若首帧仍超过5ms，继续保留失败；不缓存动态geometry、不将初始化/动态读取移出计时抢绿。原−53pt未闭环、SDK adoption unknown、自动pan暂停。
