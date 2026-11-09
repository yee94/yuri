# Features UIKit 独立验收包

生产 `BotEditor` / `TaskEditor` / `FeaturesTaskHistory` 原样挂载。使用真实 NativeShell UIKit NavStack、AlertDialog、Select，生产 NativeSheetPresentation、NativeDatePicker、AppearanceBridge、ScheduleDateBridge。没有替换 Sheet/Dialog/Button，没有改 application/main/state/settings。Foundation 内存 Host 的 seed 来自既有 `features-memory-host.js`，传入原样 synthetic expectedHost，真实 loadConnections → captureHostOperation → refresh 与生产 mutation admission 必须通过。32 条纯合成历史用于真实滚动；opaque 每页 2 条，第一页后从 memory-opaque-next 继续。所有日期转换由 Foundation 原桥处理。

Swift 不注册 RuntimeBridge/ConnectionStore，不加载 Keychain，不启用网络、语音、模型、Git 或生产 Host。NSH UIKit 无需也不使用 --web-host。UI 外观由实际 AppearanceBridge 核验系统字体及随包 JetBrains Mono，不能把 unsupportedFonts 强行设为空。独立 bundleID 和 App 沙箱隔离 Storage；未知 receipt 复用生产 openDraft CAS。Host 数据是进程内存，**同一次安装/启动完成 receipt 场景**；杀进程会重置 Host，不代表真实服务端跨进程持久化。

## 构建与冻结

```sh
node packages/nsh/scripts/build-features-uikit.mjs --stage-only
NSH_BIN=/existing/nsh/bin/nsh NSH_DIST=/existing/nsh node packages/nsh/scripts/build-features-uikit.mjs --sdk-only
NSH_BIN=/existing/nsh/bin/nsh NSH_DIST=/existing/nsh node packages/nsh/scripts/build-features-uikit.mjs
```

最后命令仅编译并 ad-hoc 签名 Simulator App，绝不安装/启动/操作设备。输出 `.nsh/features-uikit/<buildID>/fixture-build.json` 与 `FeaturesUIKitFixture.app`；每次唯一 `example.nsh.features-uikit.run-<suffix>`。冻结 TS/runtime import 图、依赖包逐文件 SHA、Swift 原始字节、seed、profile、原始 assets manifest、编译后资源与可执行 SHA、公有 Swift interface SHA 和签名验证证据。复用 stage-native-application 的字节/资源验证；默认生产入口仍为 App.tsx。

stage / SDK / build / headless pass 均不意味着 UIKit 或外部端 1:1 验收完成。没有自动标记 uiKitValidated=true。

## main 独占 install / launch / AX / audit

从新 manifest 取实际路径与 bundleID，不能使用旧包坐标或 SHA：

```sh
FEATURES_BUILD=packages/nsh/.nsh/features-uikit/<buildID>
FEATURES_BUNDLE=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).bundleID' "$FEATURES_BUILD/fixture-build.json")
xcrun simctl install booted "$FEATURES_BUILD/FeaturesUIKitFixture.app"
xcrun simctl launch booted "$FEATURES_BUNDLE"
xcrun simctl io booted screenshot "$FEATURES_BUILD/history.png"
# 使用 main 已有的 AX/gesture 工具；若已装 idb，可直接导出当前真实 AX：
idb ui describe-all --udid <booted-UDID> --json > "$FEATURES_BUILD/current-ax.json"
# UI 返回根，点击 features-uikit-open-audit / features-uikit-audit-refresh 后：
FEATURES_DATA=$(xcrun simctl get_app_container booted "$FEATURES_BUNDLE" data)
cat "$FEATURES_DATA/Documents/features-audit.json"
```

不要求安装 idb。可使用 main 已有 AX 工具读取下列 testID 的当前 frame 和 label。audit-json 的 accessibilityLabel 为完整 JSON，文件与 UI 同一 snapshot，刷新只增加 auditSequence 不增加任何业务写次数。

## 真实验收顺序与稳定点

1. 根 `features-uikit-ready` 必须出现；error/native-error 不得存在错误。记录 manifest、初始 audit 与外部端同主题/语言/窗口的基线截图。
2. `features-uikit-open-bot` 打开真实 BotEditor；编辑 features-bot-name，系统 Back/右滑返回与 Cancel 都必须保护草稿。Cancel 留页不写，明确 Discard 离页后不写。重开是原 Host Bot，不把丢弃草稿写回服务端。
3. features-model-picker 打开真实系统 Sheet。验证 72% 初始/98% 展开、拖动、滚动、Done、交互 dismiss、关闭重开；收藏/最近/variant 使用原控制，选择 high 后保存现有 Bot。核对首帧、长标签、输入焦点与外部端；不因 UIKit 能运行就认可 1:1。
4. `features-uikit-lose-bot` → New Bot：填写 Created durable，保存等 features-write-uncertain。audit Bot create POST 总数=1。Back 明确 Discard；`features-uikit-open-new-bot` 恢复原草稿/unknown。刷新状态时只可显式选择新 ID，再次 GET 核验；不得再 POST。回根 audit create 仍=1。
5. `features-uikit-open-task` → features-task-more → Run now。等 overflow 再 enabled；audit run POST=1。History 实际打开后 features-history-close / features-history 可见且 frame 非零；72%/98% detents、长列表纵滚、header/Done 可达，底部不露底层编辑器操作。不能以 opened 回调替代截图和 AX。
6. 点击 features-history-more，看到 memory-history-3；继续 load-more 直到足够多行，真实 scroll 到最后一行，检查顺序/无丢行。Done、拖动 dismiss、侧滑/back 分别验收并重开；读历史/滚动/关闭均不得增加任何写。Task 原草稿不能因历史打开/关闭而变化。
7. 回根 `features-uikit-fail-older`，开 History，第二页失败后已加载第一页保留；features-history-error / retry 显示，retry 只能 GET 相同 opaque cursor。成功后原分页行可见。failure 不得当作空历史，读失败不新增写。
8. Task More → Pause；等再次 enabled。audit task PATCH 增加1。编辑草稿，History 来回再 Back/Cancel，核对原稿保留；明确 Discard 不能保存草稿。
9. `features-uikit-lose-task` → 改任务名/保存，等 uncertain，明确离开；普通 open-task 恢复 unknown，刷新核验只 GET 不再 PATCH。若此前只执行一次 Pause，此时累计 task PATCH=2。create=1、run=1 不变，favoriteModels=1、recentModels[0].variant=high。另行 New Task/删除场景应单独记录 baseline delta。
10. `features-uikit-open-new-task`：真实 Projects / Schedule type / Timezone Select，切 Once 后真实 features-date / UIDatePicker；核对 12h、Monday、最小最大日期、Cancel/Done、键盘与系统 navigation。只在明确 Save 时增加一次 PUT；不能用 fixture按钮直接改生产 draft 替代真实操作。

fixture 根入口 testIDs：features-uikit-open-bot / open-new-bot / open-task / open-new-task / lose-bot / lose-task / fail-older / open-audit。audit：features-uikit-count-bot-create、features-uikit-count-run、features-uikit-count-task-patch、features-uikit-audit-json。生产入口：features-bot-name/save/cancel、features-task-name/save/cancel/more、features-model-picker/close、features-history/close/more/error/retry、features-write-uncertain、features-date。

验收必须附真实 AX frames、72/98 detents 与滚动/关闭/草稿恢复视频或连续截图、audit 前后 delta、同条件外部端 1:1 对照；每个未验项保持未完成。History 尺寸的独立 oracle 与 UIKit 可见性分别记录。跨 Host、真实模型、语音、真实服务端以及杀进程后的 synthetic Host 恢复均不由此包证明。

## main 实跑记录：ed33b479

main 已安装并启动冻结包 `2026-11-07T17-07-57-765Z-ed33b479`，根 ready 出现后，从真实 TaskEditor → More → History 操作。初始 Done、两条历史与 Load more 的 AX 尺寸非零；两次加载更多采用 `memory-opaque-next`、`features-opaque-page-4`，实际出现 history-3 至 history-6。系统抓手上拖后 AX 从 `Half screen` 变为 `Expanded`；history-3 从约 502.7pt 滚到 333.1pt，Done 保持约 112.9pt。Done 关闭、从菜单重开、系统抓手下拖关闭后，历史控件均从 AX 消失。

只读 audit 的 create/run/task-patch 均0，rejected=0；本轮所有请求均为 GET。原始 AX、触摸发送记录和截图位于 `.scratch/nsh/features-uikit-ed33b479-*`。这是本轮可见性、两次分页、展开、滚动及两种关闭的证据；不证明精确 detent 比例、全部32行、失败分页、脏稿/选区保持、键盘交接或外部端同条件样式一致，以上清单继续逐项验收。触摸记录为 Host 发送时刻，不冒充 UIKit 接收 ACK。
