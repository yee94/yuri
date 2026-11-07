# UIKit 历史滚动专项夹具

仅补充真实 Host 验收，不取代它。所有内容均为确定性合成记录；无网络、模型、语音、连接配置或凭据访问。测试控件和机器计数不是产品 UI，不纳入产品本地化。Swift 入口只有 `NshAppView.loadBundle`，不编译生产 `ios/*.swift`，没有 RuntimeBridge、ConnectionStore、Keychain 或 URL/deep-link 入口。

## 构建（仓库根目录）

```sh
export NSH_BIN="/path/to/nsh/bin/nsh"
# 可选；默认由 NSH_BIN 推导
export NSH_DIST="/path/to/nsh"
node packages/nsh/scripts/build-history-uikit.mjs --bundle-only
node packages/nsh/scripts/build-history-uikit.mjs
```

要求 NSH 0.4.0 distribution、macOS arm64 和 Xcode iOS 26+ SDK。脚本只构建 arm64 Simulator App，ad-hoc 签名；不读取生产签名环境变量，不安装、不启动、不操作模拟器。所有生成文件（包括 NSH 生成的类型）均在 `packages/nsh/.nsh/history-uikit/`：

- `project/`：仅夹具配置（空 capabilities），不继承生产 `nsh.json`。
- `bundle/`：独立 bundle；不是生产 `.nsh/bundle`。
- `HistoryUIKitFixture.app`：独立产物；不覆盖生产 `.nsh/out`、图标或签名。
- Bundle ID：`com.yee94.yuri.nsh.history-fixture`。

纯 TS 检查（不会调用 NSH CLI/engine，也不会拉起任何 App）：

```sh
bunx vitest run --config packages/nsh/tests/history-uikit/vitest.config.ts
node --check packages/nsh/scripts/build-history-uikit.mjs
# 先做 --bundle-only，让 NSH 生成独立类型；随后仅检查夹具及其依赖闭包
bunx tsc --noEmit -p packages/nsh/tests/history-uikit/tsconfig.json
```

不要在 main 的设备验收窗口运行 `nsh test`，包括看似 headless 的 engine/UI Vitest；它也可能将 NshDev 拉到前台。这里的 Vitest config 只匹配本目录纯 TS 测试，不加载生产 App。

## 仅由 main 执行的设备操作

由 main 选择已经启动的目标 Simulator UDID；此脚本不创建/启动模拟器。以下命令只供 main 串行执行：

```sh
xcrun simctl install "$UDID" packages/nsh/.nsh/history-uikit/HistoryUIKitFixture.app
xcrun simctl launch --console-pty "$UDID" com.yee94.yuri.nsh.history-fixture
# 每次冷启动试验前，在 main 终端另行 terminate，再重新 launch
xcrun simctl terminate "$UDID" com.yee94.yuri.nsh.history-fixture
```

`launch --console-pty` 保持连接，可将输出重定向到 `.nsh/history-uikit/console.log`。退出日志连接不等于终止 App。建议每个场景至少三次冷启动；记录设备、iOS、NSH 版本、方向、截图/录像和 AX frames。不要在其他代理操作同一设备时运行 engine 测试。

## 数据和生产接线

合成全集 **400 条 / 20 页 / 每页 20 条**；初始第 1 页为 381–400，之后每页前插 20 条，最终 1–400。单条正文、角色、ID 和时间均固定，不使用随机数、模型或真实 Host。交替 user/assistant，不出现业务链接/工具。额外尾部为 401、402……；增高不改变消息身份。

夹具直接使用生产 `createNativeHistoryRows`、`createNativeHistoryScroll` 和真实 NSH `List inverted`。`contentClass`、`loadMoreThreshold={0.5}`、`keyboardDismissMode="interactive"`、`keyExtractor` 及五个滚动事件与生产 Chat 相同。仅 `onScrollDragStart` 增加计数和已布防的手动数据注入，再交给同一个生产 owner。没有 `scrollTo`、`scrollValue`、位置补偿、测量回写或第二 scroll writer。

这里刻意使用可控高度的 `Text` 行（86/102/118/134pt），不挂载 `NativeTranscriptBody`：其依赖链包含业务 state/appearance/runtime。这样无须 mock 生产模块或接触真实配置。每行首部有独立、固定 AX marker，例如 `history-marker-0385`，`testID` 和 `accessibilityLabel` 均为该字符串；AX 追踪必须同时核对 identity 和屏幕 frame，而非只数文本。

## 场景和预期计数

顶部 `history-uikit-counters` 是完整 JSON，accessibilityLabel 同步为同一 JSON；无需读取 App 沙箱。每次数据/控制状态变化还输出一行 `HISTORY_UIKIT {JSON}`，不逐滚动帧刷日志。可从 main 已有 AX 工具按 testID 取 label 并 `JSON.parse`，或从 console 提取：

```sh
python3 -c 'import json,sys; tag="HISTORY_UIKIT "; rows=[json.loads(s.split(tag,1)[1]) for s in sys.stdin if tag in s]; print(json.dumps(rows[-1] if rows else {},ensure_ascii=False))' < packages/nsh/.nsh/history-uikit/console.log
```

初始 `page=1, rows=20, requests=0, adopted=0, error=""`，seed 不算请求。`requests` 仅计较早页请求，`latest` 单独计返回最新端的模拟刷新；没有真实 HTTP。`auto + manual = requests`，`adopted + failures = requests` 只在没有 in-flight 请求时成立。

| 场景 | main 的实际操作 | 应观察/提取 |
| --- | --- | --- |
| 空闲/布局不刷页 | 冷启动等待 ≥3 秒，记录初始 marker；不拖动 | `requests=0`；不能因为 `onLoadMore` 或布局自己取页 |
| 延迟前插 | 真实向较早消息方向拖动到旧端，松手后等 900ms；另做一轮点击“延迟”切到 1800ms | 每次手势最多一页，`auto`、`adopted` 各 +1，`page` +1；从请求开始、adoption 到稳定后持续追踪同一个可见 marker |
| 20 页 | 每次新手势靠近旧端，或点“手动前插”，等 loading=false 后重复 | 19 次成功后 `page=20, rows=400, adopted=19, requests=19`；再拖不请求，不重复行。一次失败再手动重试则总请求 20、failures=1、retries=1 |
| 失败/手动恢复 | 点“下页失败”，再拖至旧端；失败后继续拖若干次；点“手动重试” | 失败时页码/已有 rows 不变，`failures` +1、error 非空；自动拖动不重试；显式重试 `manual`、`retries` +1，成功清 error。列表 footer 也保留生产同名 `history-load-older`/`history-page-error` |
| 迟到增高 | 选择旧端附近的可见 marker，例如初始 385，使较早的 381 在上方；点“迟到增高”，保持阅读至少 1800ms | `growthMarker` 显示被选中的最早未增长行；1800ms 后该行增加 160pt，`growths` +1。跟踪其他可见 marker 的位移，不把被增高行内位移误作 anchor 漂移 |
| 新增尾部 | 离开最新端后点“新增尾部”，再在最新端重复 | `appended` +1、rows +1；离开尾部时阅读 marker 不被拉回，最新端按 NSH 倒序语义跟随 |
| 手指期间前插 | 点“拖动期间前插”使 armed=true，手指按下开始实际拖动，**保持接触超过 delayMs**，再移动/松手 | 下一次真实 drag 开始 `drags`、`heldPrepends` +1，armed=false；手动请求在延迟后 adoption。必须从录像证明 adoption 时尚未松手；计数本身不证明 held-touch |
| 返回最新端 | 从历史真实拖回最新端 | `latest` 反映生产 `onLoadMoreAtStart` 调用；模拟刷新只计数/延迟，不修改数据，不触发模型 |

“手动前插”和 footer 直接调用与生产按钮相同的数据入口；它们不冒充自动分页，也不合成滚动事件。`onScrollEnd` 是滚动静止，不代表手指松开；夹具不增加生产没有的 drag-end 写入逻辑。布防注入在委托生产 drag-start 前建立 loading flight，生产 owner 不为该手势再开第二页预算。

## 验收与局限

- Vitest 只证明确定性数据、生产 intent gate 接线、请求预算、失败恢复、20 页终止和计数，不证明 UIKit 几何稳定。
- UIKit 必须以 main 的独立 AX frame/连续录像度量同 marker：释放后漂移目标 ≤1.1pt，无 ≥100pt 的单帧被动位移；按住期间扣除用户真实移动，至少记录 adoption 前后完整帧。最终稳定不等于中间没闪跳。
- 没有自动通过标签、应用内测量器或第二补偿器；`heldPrepends` 只是布防触发次数，不是触摸验收次数。`latest` 只是模拟刷新，不是真实 Host 请求。
- 固定高度及人为晚到 +160pt 不能覆盖真实 TextView Markdown、卡片、图片解码、真实 Host 延迟/并发、后台恢复、凭据/Relay、生产导航/键盘或语音。完整 `NativeTranscriptBody` 与真实 Host 上的验收仍由 main 完成。
- 不调用生产 App.tsx headless、不运行生产 ios:build、不安装/启动；独立编译成功只能报告构建成功，不能报告设备专项通过。

## 本次交付验证

- 本目录纯 TS Vitest：7/7 通过；独立夹具 `tsc`、构建脚本 `node --check` 通过。
- `--bundle-only` 通过；生成 capabilities 确认 network/fs/process 授权为空，clipboard/picker/openUrl 关闭。
- 包级 `tsc -p packages/nsh/tsconfig.json` 未通过：现有 `remote-desktop.tsx` Bounds/pointerEvents、`resources.tsx` Text.selectable 及共享 runtime-url 类型错误；未改动这些文件。
- 遵守 main 的设备窗口限制：未运行 engine/UI 测试、NSH CLI test、Swift/App 完整构建、安装、launch、模拟器或浏览器操作；完整 App 构建和设备专项仍待 main 串行执行。未运行超出本次允许命令范围的全仓 dead-code 检查。
