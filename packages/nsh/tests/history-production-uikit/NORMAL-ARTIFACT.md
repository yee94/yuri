# 冻结正常分页入口：交 main 首验

后续main已真实install/launch此冻结包，完整production root→Chat成功；fresh nonce握手通过，startupSweeps=1/rejected=0/mutations=0，正文和实际UIView实例可见。探索时history-load-older仍在屏幕外，idle超过5分钟达到18000样本并overflow；该轮严格invalid，未通过53pt验收。下一轮限时驱动与moving红灯入口见 [SMOKE.md](SMOKE.md)，需新独立artifact；本包及其tools保持原hash。下文“未安装/启动”是首次交付时worker执行边界，不覆盖本段main实测反馈。

已实际build、静态typecheck、签名并独立核对hash；**未安装/启动、未运行engine或设备，原53pt/OFF仍红**。这是新的500条中性合成源，production App/Chat不替换，不能作为原53pt关闭证据。

```sh
HP_BUILD=packages/nsh/.nsh/history-production-uikit/2026-11-07T16-59-30-591Z-1bb480cd
HP_BUNDLE_ID=example.nsh.history-production.run-06b4f0b4
# HP_UDID 使用main独占的已booted设备，不由worker操作。
xcrun simctl install "$HP_UDID" "$HP_BUILD/HistoryProductionUIKit.app"
xcrun simctl launch "$HP_UDID" "$HP_BUNDLE_ID"
xcrun simctl get_app_container "$HP_UDID" "$HP_BUNDLE_ID" data
```

最后命令返回的sandbox内 `Documents/history-production` 设为HP_DATA。本次实际产物：

| 项 | 冻结值 |
| --- | --- |
| scenario / experiment | normal / OFF |
| 生产源 / 已安装依赖 | 515文件 / 56依赖，逐文件hash |
| bytecode SHA256 | `b224c34635d653da041bbe928725862aa0f9c0e036e0783dbfcf1d4d16f55777` |
| executable SHA256 | `6a96b22fd7dfb87c1535e471a95b7f00d4929fd354dfbbf38cdc7dea414585e2` |
| clock-client SHA256 | `06059bf5526fcd9480017c01192b2c41fdaf64024a4485572bfe6378b1013ba9` |
| pixel-measure SHA256 | `7a61fdb92bdb89422fb482c8227d6eba3cea7a55a8e65bc950cee5d78033afa5` |
| 精确输入/能力/工具 | `manifest.json`、`independent-audit.json`、冻结的 `tools/README.md` |

独立审计确认source stage、全部依赖、packaged capabilities、实际App双hash和工具binary hash一致；审计时currentWorkspaceDrift为空。main收包后若worktree继续变化，**仍以该冻结stage及实际App为准**，不能将新源码说成此包。不要覆盖stage、App、tools或原证据。

## 首次正常分页 smoke 的最短路径

1. 保留完整AX/截图，确认前台是这个bundle。`ready.json`仅sidecar loaded，不能据此认为startup/业务已放行。
2. App入口原样 `App → NativeStartup → YuriNativeApp`。真实 `AuthorizationCacheCleanupBridge`五handler使用空pending；native sweep完成前Host拒绝connection.list。进入业务后的host snapshot必须 `startupSweeps>=1`，journal中真实空sweep先于connection-snapshot，`rejected=0`，没有伪造retirement ticket或手写app.connection。
3. 从真实首页按需点 `projects-toggle-history-project`，再点 `project-session-history-production-500`。必须看见生产 `transcript` 和正文 `ANCHOR hp-NNNN`，不是诊断List。任何 `hp-native-error`、startup feedback失败、App根错误或缺Session先保存失败；不要点测试替身或修改production root绕过。
4. 真实向旧端拖动，观察生产20条分页。Host journal应有递增requestID、opaque cursor、20个responseIDs，以及native具体UIView首次挂载实例。检查真实 List只保留原滚动writer；不从AX挂载集合推导全部loaded IDs。
5. 保存原始captures和录像，不要立刻给PASS。只有符合下一节的静止窗口才能运行严格正面判定；含用户移动/拖动/减速的窗口保留raw并判invalid，不把用户输入混成被动跳。

内存Host立即返回，不人为延迟响应、保留loading或屏蔽控件来造静止窗口。自动scroll分页可能在手指/减速中发生，严格stationary checker对此会invalid；它仍是有用的真实生产机制反馈，但不能伪装成静止阅读通过。若真实footer按钮当时完整可见，可用原按钮捕获无scroll输入的窗口；否则保留手势/原生状态/像素原证据，不加程序scroll或假提交按钮。

## audit 与 clock 的直接入口

```sh
"$HP_BUILD/tools/clock-client" "$HP_DATA" flush
# ACK后capture.json已原子落盘，含所有native frames、host journal及真实实例。
"$HP_BUILD/tools/clock-client" "$HP_DATA" clock
```

clock返回当次nonce、macOS hostSend/Receive、模拟器native receive/return/ack、JS send/receive、build identity；没有拿缓存snapshot冒充native时间，也不假定两种uptime同epoch。前后各保留多组完整JSON。若JS未返回或原生watch未处理，10秒后明确失败；不能用旧ACK凑数。

实际captured最后一帧中选三个旧内容ID，**在目标动作前**用：

```sh
"$HP_BUILD/tools/clock-client" "$HP_DATA" mark "$HP_ANCHOR1" "$HP_ANCHOR2" "$HP_ANCHOR3"
```

返回baselineSequence；mark验证三ID当时唯一且完整可见。优先选择带唯一中性ANCHOR文本的 `body-part-*` 与不同旧内容块；重复copy图标的像素配准如果不唯一会invalid。三个ROI必须相互独立且不要选即将更新的目标正文。原 `history-load-older` 触发请求后继续完整采集，最后flush再copy；请求/response/adoption不是同一时刻。

## 录制与失败阈值

复用现有 `.scratch/nsh/record-source-6gTy3C/record-source` 与 `record-check.py`，main独占设备，按真实framebuffer尺寸启动live录制；完整命令及native-sync数组、冻结checker调用都在 **该artifact的 `tools/README.md`**。`tools/clock-client`、`tools/pixel-measure`、`tools/check.py` 已生成，不需要再改production源码。

严格检查保持：native pre250ms、至少180实际post/3秒、4秒观察域、最大gap50ms（含实际曝光宽度及clock不确定度）、同viewport/三旧UIView身份、真实20条响应及native可见效果、位移≤1.1pt、live ledger/encoded PTS/完整解码一一对应、零drop、stop/finalized。coded pixel逐帧检查独立于native框，最终回原位也不能抹掉中间单帧。没有完整时轴/有效时钟或有遮罩/用户运动时不交PASS。

SDK内部List mutation/adoption身份仍未公开，记录null；`native-first-observed`只是具体UIKit实例观察，不冒充ACK。生产footer wrapper无testID，祖先链保留真实实例/几何但不编造natural owner；释放footprint无法精确定位时仍待验。

## 后续范围未缩减

同一实现已有terminal（第25页）、partial（一次真实503后原Retry清错）、growth（同消息完整段落增长/真实Activity exact-fill）场景，默认OFF；独立artifact构建参数及三轮OFF/ON矩阵见README。它们未设备验收，不把正常页通过搬作终页、局部收缩或行高变化通过。原53pt必须回到原真实会话形状/Host/触发场景复验；本载体全绿也不能结项。

worker本轮已执行5文件11项纯测（包含实际Foundation Host、实际sidecar JS、生产message/row projection、真实编码/解码的稳定与单帧53pt校准），静态Swift和正常App一次构建签名通过；没有执行UIKit/runtime smoke。PixelMeasure当前仅有Apple同步tracks API的deprecated warning，不是编译失败。独立review由main后派，未声称已经通过。

补充验证：专项 `tsc --noEmit` 已通过；`bun run dead-code` 已完成并检查报告，未出现 `history-production-uikit` 或 `build-history-production-uikit` 条目。全仓仍报告130个unused files及其他exports/types/duplicates提示；该脚本使用 `--no-exit-code`，不能将命令完成表述为全仓零告警。本次仅更新此交付记录，冻结artifact的stage、App及tools保持不变。
