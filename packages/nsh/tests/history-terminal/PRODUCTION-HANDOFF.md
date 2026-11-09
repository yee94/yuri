# 生产 53pt：离线反馈与测量 source fence

后续已落地生产controller与不可复用节点source，正式合同见 [HISTORY-FOOTER.md](../../HISTORY-FOOTER.md)。下文首次交接中的fixture `captureLayout` 接线已被独立oracle指出P2：可变槽位给旧事件换名；现在以不可变 `captureSource` 取代，并由执行实际fixture TSX回调的回归先红后绿锁定。reader实现已归属生产 `history-footer-natural.ts`，tests同名文件只是兼容重导出；生产 `history-footer-controller.ts` 不导入tests。生产53pt仍红，App接线和UIKit尚未验收。

当前生产故障仍未关闭。实验默认 OFF；本轮只修改独立 history 诊断 reader、fixture、专项测试及本目录文件。未改 `application.tsx`、`state.ts`、生产 Swift、NSH SDK 或 `../opencode`，未构建/启动 engine、设备或真实 Host，未运行 Git。

## 可以直接运行的真实红信号

从仓库根运行：

```sh
python3 packages/nsh/tests/history-terminal/check-production-pixels.py .scratch/nsh/production-history-review-1794040314
```

已实际运行：退出码 **1**，三个旧内容块均 **−53pt**。此命令只读原视频、297–303 七个解码帧、registration CSV、timing、metadata，并按原存档 SHA256 核对；计算来自真实旧会话像素配准记录，不从 AX、helper 数值或合成高度推导。302→303 的实际编码间隔仍为 **1033.333ms**。该命令不重新解码/配准，不能独立验证原分析算法；算法与原始帧来源仍是原审查目录的 `measure.swift`、`extract.swift` 和录像。原档不覆盖。

这是已知失败证据的快速重放。退出码 1=检测到超 1.1pt；2=证据失效/不匹配/没有该负控制的红信号。**没有 PASS 分支**，不得将其用作新 build 的正面验收。原视频的严格分页 adoption 身份仍未证明，稀疏编码仍不能证明完整显示时轴；这些缺口不抹除确实录入的 53pt。

## 本轮最小修正

`footer-natural.ts` 过去只检查当前 scope/key/ref 是否相等。若真实 deactivate→reactivate、content A→B→A、ref A→null→A、scope A→B→A 或 visible→hidden→visible，旧的 layout 闭包能重新匹配并把旧高度写回当前 owner。已有异步 `measure()` ticket 对这些变化有效，但**不覆盖回调 source 的身份**。

现在 `captureLayout(node, scope, contentKey)` 捕获独立 source generation。上述边界使 source 永久失效；普通测量 ticket、同内容更新、初次 inactive→active 不退役 mounted source。新真实 layout 仍使正在等待的 ref read 失效。fixture 的自然内容 `onLayout` 使用这个捕获闭包；外围暂留 wrapper 不参与自然高度测量。保留同步 direct `layout` 方法供纯合同测试，真实回调必须走 `captureLayout`。

这只是拒绝迟到高度的确定性修正。它不增加 offset/inset writer、timer、缓存、裁剪或数据提交延迟，不证明该 race 曾发生在生产 53pt 录像中。现有原生 SDK 的 `onLayout` 只有 bounds，没有 native mutation generation；若引擎把旧事件派给**重新绑定后的新闭包**，JS 无法识别其原生来源。不能把 JS source fence 夸大为引擎事件序号保证。

真实失活后未重新绑定的旧 source 会继续拒绝 layout；恢复需要当前自然 ref 的显式确认，或者真实新 source，而不能从旧高度恢复。fixture 已有 `footerNeedsActiveRead` / `confirmFooterHeight` 路径。该路径自身的 active/ref/content ticket、同帧批次和发布次序仍需 UIKit 复验。

## main 的准确共享 seam（本轮只读）

截至本轮读取，`application.tsx` 的 `Chat`：

1. `beforeHistoryPresentationFlush` 已向 footer helper 传完整 scope、footer predicate 和 successful-history authority，实验仍 `signal(false)`。继续保持同步、数据提交前的同 batch，不从该 callback 发起 `await measure()`，也不读取尚未赋值的 `chat`。
2. List footer 目前只有一个 `minHeight` wrapper 和真实按钮/错误/修复入口；缺少**内部自然内容 View** 的 ref/onLayout 接线。外层 held minHeight 与内层 natural bounds 必须分离。生产 contentKey 覆盖 more/error/boundary/repair/gap，加载文案与字体/宽度变化也可能改高；不能拿 button-only 的 key 或合成36pt替代。
3. List 的 drag-start/scroll/end 目前只交给 historyScroll/chrome；footer owner 未收到 offset/gesture/end，也未在原 latest admission 中收到 onLatest。在原事件链原位加只读输入和同步 release，各原 owner 仍各调用一次；保留 `onLoadMoreAtStart`，不装第二个 scroll writer。不能在任意 latest callback 中绕过原 current/loading admission 清理面积。
4. 页面/Host/history source 的真实退役需要同时失效 reader、待处理 ref 结果、layout source、helper 和旧 List event 闭包。`operations.onRetire` / cleanup 已 reset helper，但不等同每次 route/lifecycle 隐藏；需要实际 active→inactive 边界。旧回调必须携带捕获身份，不能在执行时读取新 scope 给旧结果换名。
5. source/ref 更换后必须重新确认自然高度；仅相同 scope/contentKey 不保证测量属于新自然节点。若确认被更新的 layout/ticket 超越，要消费该新有效测量或明确保持未确认，不能将旧异步返回的 false 当作正常确认，更不能沿用旧面积。实验缺测量应显式显示未保护，不能阻止权威历史加载来制造稳定画面。

以上改动归 main 的 application 装配 owner；本轮不改该文件，也不打开实验。fixture 新 source hash 已变化；旧 build6 的二进制及证据不变，旧 manifest 不能冒充当前源码构建。

## main 独占 UIKit 复验路径

先跑新 reader 的实际回调顺序：初始 inactive-layout→active；active 下 attach/ref-read；hide→show；content A→B→A；history generation reset；待测量中替换 ref；新 layout 超越旧 read。分别保留 layout 的 scope/key/source admission、ref read ticket 与 UIKit `convert(bounds,to:surface)`。自然内层高度、暂留外层高度、List contentSize/offset 必须各自记录；不由 core pagePosition 推算 native offset。

然后使用同一真实旧会话、真实生产 transcript 和同 build identity，三轮独立 OFF/ON commit/release。OFF 应保留原故障或说明为何负控制变了。ON 必须覆盖正常分页、最后一页完整隐藏、error→retry 的局部收缩、Activity/metadata 完成、长 Markdown 自然高度变化、持指和减速；helper 当前只覆盖完整 visible→hidden，**局部收缩及行高变化仍未修**。保持完整正文与控件可用，不用隐藏/延迟/裁剪换取平稳。

每个目标事件保存完整 request/response/commit 身份、loaded IDs/row keys/cursor/more 和完整 footer predicate、原生 adopted revision、真实手势/rest 时刻、三个同身份可见阅读块。native 采样沿用现有严格合同：250ms pre、至少180个实际 post/3秒、最大gap50ms、漂移≤1.1pt；释放必须是真实手势后的 same-stack onScrollEnd、实际外层及自然高归零。生产 marker/row 适配不能直接套 fixture 的 `terminal-marker-*` checker 报绿。

录像独立连续解码，事件两侧有共享时钟关联、完整原生与视频 frontier；任何覆盖缺口保留 invalid。IOSurface **481 reads / decoded 0 drops / maxPTS 24.57ms** 目前只有 smoke，缺 native clock exchange，不能变成生产 verdict。build6 三轮 ON 原生窗口通过也不抵消其95–115ms commit gap、430–448ms release gap和约5.5秒末尾缺口。

如果在正确自然测量、同代际接线和完整因果记录后，partial shrink/自然行高变化仍使旧端 clamp 移动阅读块，下一 seam 属于 **NSH 倒序 List 的唯一 keyed reading-anchor owner**：需要在同一次 native layout adoption 中关联旧 anchor、用户输入、header/footer/row 自然高度差及 clamp 行为，公开 mutation/source generation 与 native adoption ACK，保留全部行。当前本地 `.nsh/types/nsh/types.d.ts` 的 onLayout 仅 bounds、onScrollEnd 仅 offset、measure 为 core geometry；这不是可由第二套 JS offset/inset 修补的公开合同。此处未证明必须改 SDK；先用上述生产证据定位，禁止改 `../opencode`。

## 实际验证与独立复核状态

无 fence 的语义等价实现运行15项：**4 failed / 11 passed**，四个 identity round trip 都接受了旧高度；加 fence 后通过，另补 visibility round trip。最终实际执行：

- `./node_modules/.bin/vitest run --config packages/nsh/tests/history-terminal/vitest.config.ts`：**61 passed / 1 skipped**；skip 是未提供旧 build5 raw replay 环境变量。Foundation持久化检查可离线执行，没有UIKit或engine。
- `./node_modules/.bin/tsc -p packages/nsh/tests/history-terminal/tsconfig.json --noEmit`：通过。
- `./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/history-presentation.test.ts`：**15 passed**，只使用模拟signals/batch与真实createChat的数据合同，不运行原生engine。
- 上述 production pixel checker 两次均 **red / −53pt / exit 1**；临时目录修改registration CSV后 **invalid / exit 2**，原证据未改。

没有重新构建原生包、运行 UIKit 或生产验收。

`bun run dead-code` 已执行并检查，报告全仓124 unused files / 799 unused exports，NSH fixture 动态入口仍被列为未使用；未删除其它 owner 的代码。Context7 查询返回 monthly quota reached，本轮 API 核对来自当前安装的本地 `.nsh/types`，不声称已取得新在线文档。

本会话检索不到子代理派发工具，**没有完成独立 readonly reviewer**。供 main 派发的最小审查集合：本轮 `footer-natural.ts` / test、fixture footer closure、像素负控制脚本及此页；要求分别审查 source generation 是否可能被新 ref/闭包换名、自然测量是否污染、同步释放是否被 await 改序，以及是否有人把该局部测试绿挪成生产53pt绿。自审与测试不替代该独立复核。
