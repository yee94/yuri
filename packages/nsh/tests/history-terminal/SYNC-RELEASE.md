# 同步释放 fixture · build 5（静态交付，未运行）

**生产 53pt 仍 red。这里只完成诊断接线和纯逻辑回归；同步释放的 UIKit、录像、完整 Host/history scope 均未验收。**

## 本轮唯一交付包

- App：`packages/nsh/.nsh/history-terminal/build-7LnRdi/HistoryTerminalFixture.app`
- manifest：`packages/nsh/.nsh/history-terminal/build-7LnRdi/manifest.json`
- Bundle ID：`com.yee94.yuri.nsh.history-terminal`；config build **5**；arm64 iPhoneSimulator；NSH 0.4.0；SDK 26.5。
- bytecode SHA256：`c8cb744eababaf13998ddad8c5423ff9bc4b60923f89ea253ef4b9a771c52601`
- executable SHA256：`42955da99799b23985a192f6a3a31d059775844979d4c0a7540792ad3a865564`
- 默认 `footerExperiment=false`、`releaseMode=sync`；metadata/footer 内容开关仍默认 ON。

旧 build4 `build-63t70l`、全部旧 captures/MP4/审计目录未改。`build-Xv72lh`、`build-3MCAso` 为本轮中间静态产物，保留但不交付；只使用上述 `build-7LnRdi`。builder 每次 mkdtemp，并在编译/签名后重新核对 source hashes，防止构建中源码变化仍冒充一致包。最终包与当前 manifest 的全部列出源码、bytecode、executable 哈希已独立核对。

## 实际控件与 main 串行复验

所有 selector 均为原生 accessibilityIdentifier / `testID`：

| selector | 用法 |
| --- | --- |
| `terminal-counters` | AX JSON：先核对 `status=READY`、`releaseMode=sync`、`footerExperiment=false`、新包身份在 captures 中一致 |
| `terminal-toggle-release-mode` | 冷启动后、请求/hold 之前切换；文字“同步释放”=sync，“诊断等待”=旧 await 模式。ON hold 期间不可切换 |
| `terminal-toggle-hold` | 显式启用/禁用实验；默认 OFF，不因切换 releaseMode 自动开启 |
| `terminal-toggle-metadata` | 做单因子 footer 矩阵时切为 OFF |
| `terminal-probe` | “仅控制项”：挂起控制项提交；仍是 requests/adopted=0 的隔离实验 |
| `terminal-commit` | 手动提交挂起结果 |
| `terminal-capture` | “读取几何”：异步保存当前 native 采样快照；不是采样开关，不得在释放前强制等待它 |
| `terminal-transcript` | 原生倒序 List，唯一 scroll/anchor writer |
| `terminal-footer` | 仅外层 footprint / minHeight owner |
| `terminal-footer-natural` | 独立内层自然 ref/onLayout，**不带 minHeight** |

main 可沿用现有 probe 的 OFF/ON、旧端阅读定位、手动 commit 与真实 `drag(-.06,400)` 手势；新包冷启动默认 sync，无需点模式切换。现有 probe 最后等待后点 `terminal-capture` 再复制文件的步骤必须保留：continuous 模式不再四秒自动停采/flush。此等待只是 **事后取证**，不参与 fixture 的释放判定。

三轮均冷启动本交付包，串行录制 OFF→commit / ON→commit→真实 drag→release；不要并行操作设备。启动录像在 request 之前，结束在最后事后样本之后。每轮保存新目录的 captures、release-captures、AX/probe log、原始 MP4，不能覆盖旧材料。完整录像帧时轴还须独立核对；native checker 不授予视频无瞬态通过。

### 新离线判定器

在仓库根，仅读取 main 已采集的文件：

```sh
M=packages/nsh/.nsh/history-terminal/build-7LnRdi/manifest.json
bun packages/nsh/tests/history-terminal/check-sync-capture.ts <新OFF或ON/captures.json> "$M"
bun packages/nsh/tests/history-terminal/check-sync-capture.ts <新ON/release-captures.json> "$M" --release
```

- exit 0 只对应所选 native window；1 包含 red、invalid 或没有相应事件，不能把空结果视为通过。
- 强制 schema2、continuous、executable **和** bytecode 哈希一致、native 时钟单调。
- pre 至少覆盖250ms且至少12个真实周期样本；post 至少180个且跨至少3秒；跨窗口样本间隔不得超过50ms。
- commit 使用显式 `before-js-commit` native baseline，同时验证连续 pre 周期窗口，不把一个 point capture 当 pre-window。
- release 只能引用已存在的 native ring sample；native 接收时年龄≤50ms，scope/minHeight/releases 必须吻合，缓存 offset 距真实 end-event offset≤0.5pt。不新测一帧来补 baseline。
- 需要 native tracking/moving 手势证据。当前严格 release pre-window 要求最后250ms已在 end-event offset 附近静持，可仍 tracking；输出明确不是“已 idle 的 pre-window”。**快速甩动/惯性方案若无这个窗口会 invalid，不代表通过或已覆盖。** 不向 fixture 加 timer/rAF 来制造此窗口。
- 检查原生外层实占面积≈hold、自身空自然内层≈0（无 held min 污染）、release 后原生 footer 实际归零。footer 已离开 viewport 时仍只读记录其 geometry，并标 `intersectsClip`；它不是可见阅读 anchor。
- 选三个可见阅读 marker，逐样本限制1.1pt；`clippedAnchors` 明列部分裁剪项，不能宣称三条完整可见。
- 连续样本中一帧 marker 位移36pt、最终回原位也必须 red；缺 pre、gap、旧包、错scope/offset、无实际footprint一律不能绿。
- 本 checker只判所列 pre/post窗口，不证明所有 request→commit 中段或视频的连续覆盖；完整帧时轴仍交离线审计。

旧 `check-capture.ts --release` 保留，只供诊断等待模式/历史证据，不能拿它给 sync 模式替代验收。已把旧 build4 release 文件喂给新判定器，实际返回 exit1 / invalid / 无sync释放事件，证明旧绿不能混入新结果。

## 同步释放的真实时序

`footer-release.ts` 由 fixture 真正调用，纯测试也走同一入口：

1. 记录 JS `eventAt` 与 helper before snapshot。
2. `cachePre` 只发出 `footer-sync-before-release` 的 fire-and-forget tag，原生侧引用**已经由 CADisplayLink 缓存**的样本；这不是新 native measure/flush，也不等待 bridge ACK。
3. 记录 `releaseStart`，同一调用栈执行 `footer.onScrollEnd(event.offset.y)`，立刻记录 `releaseReturned` 与 after snapshot。
4. `footer-sync-after-release` 按同一 `releaseID` 记录 timeline；仅在实际 `releases+1` 后允许 `measure('after-footer-sync-release')` 异步诊断。其结果不回写 helper、不决定是否释放。

`timeline.releaseStart` / `releaseReturned` 是真实 JS 调用前后时间戳，释放发生在此精确 bracket 内，**不是一个假想的 UIKit commit ACK**。`nativeReceivedUptimeMs` 是原生处理日志的另一个时钟，不能等同 JS 时间或相减当 bridge latency。pre ring 的缓存/索引选取可以在原生收到 tag 时才完成，但取用的只有先前实际周期帧，绝不以新 capture/await 改变 JS 释放时序。前置 tag 自身同步日志/序列化开销可由 `eventAt→releaseStart` 直接看到，不隐藏它。

旧 diagnostic 分支仍先 `await measure('before-footer-release')` 再 release，用于对照诊断等待效应；新 sync 分支不调用它。两种模式的结果必须分开。

## 本 fixture Swift 观测边界

- sync 从 seed journal 起持续 CADisplayLink `.common` 60Hz 请求，不再四秒停采；ring最多12000帧（60Hz约200秒）、事件最多512，记录 droppedFrames。超出保留窗口时判定器缺材料即 invalid，不补帧。
- observer 只读取 UIKit frame/scroll flags/offset/contentSize，不设置 offset、inset、layout constraint，不改 NSH 外部库/生产桥。
- sync 的 pre/after release tag handler **没有 capture/flush**；只引用已有 ring 和记录接收时戳。
- sync explicit capture 冻结值快照，由独立 Swift actor 串行编码/原子写盘；不在 UIKit 主线程同步 JSON 序列化。版本号避免较旧异步写请求覆盖较新请求。
- diagnostic 模式保留原先四秒周期窗口和 awaited capture；新包的 natural 内层与 authority准入仍共同使用，不宣称是旧二进制的完全相同计时复刻。
- 采样、日志、截图仍有观测成本；未在设备测量其实际帧率/CPU。checker遇到>50ms gap会拒绝，不能因用了CADisplayLink便假设零扰动。

## 自然 ref 的全 fence

`footer-natural.ts` 只用于本 fixture，无 production store/transport：

- 同时比较 scope、active、visible、自然内容 key、ref identity 和递增 ticket；较新 read/layout、真实失活/再激活、内容变更、ref替换、dispose 都使旧结果失效。
- 首次 mounted/inactive 可接自然 layout；首次 active（包括 ref 晚挂载）有 ref.measure 兜底。真实 deactivate 后不复用旧高度，恢复时重新确认。
- stale success/rejection 都不得写入新context或状态；当前读失败保留失败，可显式重试，不伪装高度0的成功。
- 外层只给 minHeight；内层 `gap-2` 包含真实控件，flexShrink=0、无固定高度/填充/held min。ref只挂内层；从 `bounds.size.height` 接纳高度，绝不用 pagePosition 猜 offset。

## helper 最窄 authority 合同（main 接线时必须采用）

```ts
footer.update(nextContext); // 默认 presentation：清错误、retry开始等，不授权新hold
footer.update(nextContext, 'successful-history'); // 仅真实成功history采用/repair的最终同批facts
```

仍须符合：同scope、active/enabled、真实 visible→hidden、无readError、已确认自然高度/真实List offset处于clamp风险区。`successful-history` 不能追认已发生的 presentation-only hide。已持有的hold遇到read failure保持，不因失败创建新hold。

`contentKey` 是自然footer内容身份/版本，不是消息revision、token或scroll频率。可见内容key改变只清旧测量并等待真实新自然高；旧key的layout拒绝。**visible→visible部分收缩不提供补偿**，既不保留旧高恒留空白，也不把整个scope标完成。main仍需把最终多项footer谓词、同batch提交、Host/page/history generation失效与error/rehistory/revert路径接到state seam；本轮未改 `application.tsx` / `state.ts`。

`onScroll` 保持纯命令式缓存，1000次不发布UI；真实drag+rest才释放。没有 `scrollTo`、offset/inset写入或第二滚动writer；没有setTimeout/rAF静止推断。fixture原有延迟分页timer仅用于场景延迟，不参与释放。

## 已实际验证 / 未验证

- 新authority回归先在旧helper跑出2个失败：errorclear误留53pt、partialshrink旧测量未失效；修正后最终 **8文件 / 53纯测试通过**。
- focused `tsc --noEmit -p packages/nsh/tests/history-terminal/tsconfig.json`、builder `node --check` 通过。
- 独立 NSH bytecode＋仅本fixture Swift的SDK编译/链接/ad-hoc签名通过；codesign严格验证、plist lint、otool依赖核对通过。实际 packaged capabilities 恰好两个terminal调用，其余能力关闭。
- 只读重算原六段视频、captures、AX、release输入以及build4 executable/bytecode哈希，均与旧记录一致；旧材料未被改写。
- 运行了本机已缓存Knip5.80.0及根脚本相同flags（无依赖下载）；报告有118 unused files/791 exports/604 types等仓库既有候选，其中fixture/helper因NSH动态入口未纳入Knip入口而被列出。已检查相关项，不删除独立fixture、不据非阻断报告声称全仓无死码。
- Context7额度耗尽；本轮类型和构建使用现有本地NSH0.4 SDK合同，不冒称已取得新在线文档。
- **未执行 engine、UIKit/设备、真实Host、生产/main build、Git、安装或launch、依赖下载。** 新包标记 `built-not-run`，同步 release、实际控件布局、Swift host.call、实际native连续窗口、录像全部交main串行三轮验证。
