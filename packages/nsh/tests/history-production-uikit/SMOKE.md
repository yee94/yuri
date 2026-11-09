# main 短时真实反馈循环

main 已报告 normal `1bb480cd` 真实安装启动成功：完整 production root→Chat、fresh nonce clock 握手、startupSweeps=1/rejected=0/mutations=0，实际正文与UIView实例可见。旧探索闲置超过5分钟达到18000样本并overflow；该轮继续保留invalid，不能登记通过。冻结的 `1bb480cd` 不修改，新pan字段仅进入下一独立artifact。

main后续新包 `cec5b612` 的smoke a1也保留invalid：真实Chat已到，startupSweeps=2/rejected=0/mutations=0；AX正文StaticText的ID为null，body-part testID仅存在native UIView。旧driver错误等待AX body-part前缀导致超时。本轮仅修driver/纯测/文档，不改production AX、Observer、SDK或冻结artifact。a1 recorder另报 `Source changed during locked read` 且没有完成manifest，来源工具由独立owner审查，不能忽略或补造finalized。

新入口为 `python3 tools/smoke.py --config smoke-config.json --output <全新目录> --execute-main-only`。它不会build/install、启动helper/engine、改Host/Keychain或写production；仅由main对已经安装的**新OFF包**执行。worker本轮禁止运行此入口。启动时官方simctl终止该隔离bundle旧进程再启动，要求新的processNonce；旧包没有nonce/pan字段会明确invalid，不能假装兼容。

main先沿用 `NSH_BIN=/path/to/nsh node packages/nsh/scripts/build-history-production-uikit.mjs --scenario normal` 生成新独立包（manifest含 `observerContract=pan-read-v1;…`），自行安装后再填写下列config。driver会在任何设备命令前拒绝旧manifest；无需覆盖 `1bb480cd`。本轮worker没有运行新构建、engine或设备。

配置示例（均替换为main实际路径/设备/尺寸；不下载依赖）：

```json
{
  "build": "/path/to/new-frozen-artifact",
  "clockClient": "/path/to/new-frozen-artifact/tools/clock-client",
  "data": "/path/to/its-sandbox/Documents/history-production",
  "udid": "MAIN_OWNED_BOOTED_SIMULATOR",
  "helperOrigin": "http://127.0.0.1:3101",
  "serveSim": ["node", "/path/to/existing/serve-sim-launcher.mjs"],
  "recordBinary": "/path/to/verified/record-source",
  "recordCheck": "/path/to/verified/record-check.py",
  "developerDir": "/path/to/Xcode.app/Contents/Developer",
  "width": 1206,
  "height": 2622,
  "maxGestures": 6
}
```

尺寸只是示例，必须核对真实framebuffer。serveSim为主已有官方CLI的argv数组，可用已有兼容launcher；没有shell拼接。tap和gesture沿用main已运行的官方入口，动作坐标由当次AX计算。Context7本轮配额耗尽，已对照本机已安装CLI源码和main成功脚本；仍需main实际smoke确认CLI/runtime行为。

脚本保存旧capture/ready/failure副本，启动fresh process，先启动live recorder并等它的实际source-reading ready，再做before clock、真实项目/session点击。Chat readiness使用可见生产 `chat-header-metadata` 与 `chat-selection`，以及**同processNonce/identity、干净Host审计**的实际native transcript/body，不要求UIView testID出现在AX。`chat-ready.json`记录确认所用native sequence及正文对应关系。

手势起点来自真正可见的AX StaticText自然文本范围：`ANCHOR hp-*`存在时还校验messageID；没有marker时要求范围只落在唯一实际native body-part内。AX/root与native window/surface坐标先核对，范围必须处于屏内和真实transcript内；不以copy图标或空白猜坐标。命中内层code Scroll的范围不得冒充外层transcript手势；a1离线重放实际选择hp-0498 heading/body，而非hp-0497 code Scroll。起点及native实例/rect保存在 `gesture-body-*.json`，不修改production AX。

导航与验收分为两个明确阶段，每次都保存 `phases.json` 和带phase的 `actions.json`。不足三个完整独立正文时允许有界 `exploration` 导航，包含真实原分页动作，但不mark、不进入任何稳定/三anchor验收，也不因探索分页成功结束为通过。每次下一动作前等真实native rest并重新读AX/native；仅当当前确有三个完整可见、非重叠、不同消息的body-part实例时，才在动作前固定mark进入 `assessment`。拒绝copy/action图标替补、降anchor数或事后补mark。后续窗口只归属该次mark至动作后capture之间；探索响应不能挂到较早mark下。原加载按钮完整可见时official tap，否则从验证过的可见正文开始原向旧端pan。导航次数/时间耗尽仍无合格事前窗口，则invalid并保留探索原始文件。

设备工作预算70秒，清理截止90秒；recorder自身也有70秒上限。所有子命令有剩余预算timeout，不等待18000样本。目标分页实际response到达后保留4.5秒，after clock→flush→SIGINT recorder→等待complete/finalized→终止隔离App。失败同样尝试after clock/flush/停止并保留全部文件；清理失败写invalid，不覆盖旧录影或冻结artifact。`actions.json`记录CLI调用前后时间、坐标、真实进程stdout/returncode；这是host发送/返回记录，**不是UIKit触摸接收ACK**。Python monotonic不参与Foundation/video时钟换算。

仅assessment中的新older-cursor响应可完成目标采集步骤，探索分页或latest轮询不计。recorder存活在每个工作命令前后、AX读取前后、ready等待、native rest等待和4.5秒观察循环检查；提前退出即停止后续导航并写 `recorder-exit.json`。清理仍尝试保存clock/native和真实退出状态；缺manifest/finalized继续invalid，不篡改source ledger、录影或来源工具。

`smoke-result=smoke-captured-awaiting-checkers`只表示完成采集流程，绝不表示稳定通过。`final-capture.json`、`native-sync.json`、全部AX、mark、actions、原录像/ledger/PTS保持原始数据。设备停止后离线列举每个真实request的连续changed区间，自动调用moving checker生成 `moving-*.json`；没有满足条件的区间或证据则invalid。离线解码可能超过90秒，App和live采集已在截止前停止。

## 独立 moving 红灯

Observer新增只读 `panGestureRecognizer.translation(in: surface)`、velocity、state、recognizer实例及实际read bracket；增加只读target记录began代际和非changed边界revision，不设置recognizer state、不换delegate、不写offset/inset。每个native sample仍是UIKit main同步无yield读取。记录screenScale以对两个坐标端点保守扣除2像素误差。`velocity`仅记录，绝不积分、插值或作为未证明的速度上界。

`moving-check.py`必须拥有事前mark、同generation/recognizer、全窗口连续changed、tracking/dragging且无decel，三个原body实例完整可见且尺寸不变；每个read≤5ms、连续gap≤50ms，分页request/20条response确实处于该窗口。边界revision变化会拒绝两个采样之间出现的release/new gesture。身份复用、缺正文、重复消息/图标、遮罩、时钟不一致及不够独立anchor均invalid。

每采样三块分别计算 `screenYDelta − nativePanTranslationYDelta`，只有三者同方向时，取三者绝对值最小值再扣除2/scale pt作为额外位移下界；任一采样下界>1.1pt即红，即使最终复位。全窗口先校验，不能剔除release/坏帧后拼接。非红结果为inconclusive，退出码2；红为moving-diagnostic-red，退出码1。没有PASS分支。

CLI还要求同artifact/process的真实前后nonce/JS roundtrip、原live recorder checker的hash/源读取bracket/零drop/fresh decode/PTS一一对应和原clock50ms误差预算；没有nominal fps或平滑补帧。本轮moving只报告native读数下界，**未做coded pixel相对pan的时域配准**，不能声称像素已减去输入；原录像仍保留。原 `check.py` stationary门槛和像素路径完全不改。

```sh
python3 "$HP_BUILD/tools/moving-check.py" "$OUT/final-capture.json" \
  --manifest "$OUT/artifact-manifest.json" --sync "$OUT/native-sync.json" \
  --mark-nonce "$MARK_NONCE" --first-sequence "$FIRST" --last-sequence "$LAST" --request-id "$REQUEST" \
  --recording "$OUT/recording" --record-check "$REC/record-check.py" --record-binary "$REC/record-source"
```

三个完整独立正文同时可见并非总能满足；a1最后只有hp-0498完整body与hp-0497 partial，三anchor验收严格失败。可以先有界探索导航，仍不能把探索当作稳定窗口，预算耗尽时停止是有效失败反馈。moving只辅助定位红信号，不能替代stationary pass、完整footer/partial/growth范围或原53pt验收。SDK adoption仍未知，原53pt与生产默认OFF保持原结论。

前一交付验证为6文件12项Vitest（反馈项含10项Python纯测）及SDK静态检查通过；它没有覆盖a1暴露的null AX ID，不能当作本轮设备通过。本轮focused Vitest反馈项通过，内部执行16项Python纯测，包含真实a1形状回归、探索/assessment隔离和recorder退出早停；另直接以a1原始AX/native存档离线重放，Chat与hp-0498手势对应成功，三anchor仍严格失败。只读核对cec5b612冻结App/tools哈希，原stationary和moving checker逐字节不变。未运行SDK/build、engine、设备或Host，未改source工具。主需新独立build/重跑；moving像素配准未实现，不宣称UIKit/runtime通过。
