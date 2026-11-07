# 独立 UIKit 终页诊断载体

> 最新为 [build6 持久化修正与三轮实测](./BUILD6.md)，实验仍默认 OFF；三ON原生连续窗口通过，完整视频未通过，生产53pt仍red。[build5 同步释放合同](./SYNC-RELEASE.md)保留。下文与原验证文档保留旧诊断/四秒采样历史；不能用旧 checker 的绿替代同步模式验证。

仅诊断，不是修复。依据真实录像独立审查 `.scratch/nsh/production-history-review-1794040314/README.md`：静止后的三块旧内容共同 −53pt；footer 消失及「已处理」→「用时 29m 31s」同个编码事件出现，但权威 adoption 身份不全。本夹具补可控变量、原生读取和采用记录，不能替代真实 Host 验收。

**首次交付 `build-ewhxQ0` 被 main 实际启动后发现授权失败：`terminal.record is not granted`。该旧 App 不可用，构建成功未捕获此问题。** 当前授权修正版及待复验状态见 [VALIDATION.md](./VALIDATION.md)。

当前新增 **默认 OFF** 的实测 footer 面积暂留候选，AX `terminal-toggle-hold`；没有接生产。main 已用授权修正版测出 footer-only 36pt red、合成同高 metadata-only 0pt，不能等同真实 Host 53pt。候选合同、最小接线和三轮暂留/释放矩阵见 [FOOTER-EXPERIMENT.md](./FOOTER-EXPERIMENT.md)。

main 随后实跑 `build-wtJRBv` 的 ON 仍36pt红，首次layout早于active导致测量被拒绝。本轮修正该生命周期，保留错误证据与2579旧UI快照/0实际事件缓存的区分，见 [MEASUREMENT-LIFECYCLE.md](./MEASUREMENT-LIFECYCLE.md)。

## 边界及成本

- 仅本目录、新 `history-terminal-fixture.tsx`、新 builder；不改原 fixture、application、scroll 实现或其它 owner。
- **真实 NSH `List inverted` + 生产 `createNativeHistoryRows` / `createNativeHistoryScroll`**；原 List 内容边距、五类事件、threshold、keyboard mode 不变。唯一 scroll writer 是 List，无 scrollTo/offset/inset 回写。
- 正文是**自然高度的真实 `nsh/base TextView`**，不是生产 `NativeTranscriptBody`。生产正文闭包包含 appearance/state/runtime，本夹具为强隔离选择获准的最小载体。metadata 也是合成文本，不是生产 Activity 投影；不得声称已覆盖生产工具分组/耗时的完整闭包。
- 400 条中性合成内容，20 页 × 20 条。初始 381–400，之后到 1–400。自然正文长度按编号变化，无固定 row height、固定 footer spacer 或假补偿。顶部固定 **144pt**、底部固定 **152pt**，与旧夹具相同，safe area 另计。
- **默认 Footer/Metadata ON、Hold OFF，最终页 `more/loading: true/true → false/false`，footer 内容真实移除**。默认根 footer View 不保高；只有显式实验 ON 才接 `history-footer.ts` 的实测暂留候选。无自动 PASS。
- 无真实 Host、HTTP、Keychain、连接、用户配置读取、文件上传、网络桥。Swift 只注册本地观测 `terminal.record` / `terminal.capture`，`nsh.json` 只授予这两个精确 host calls；不授权 network/fs/process。Swift 直接读取 App 内 `nsh/capabilities.json` 作为 grant ceiling，与 manifest/实际编译输出同字节。生成包会链接 SDK 自带系统框架，不等于启用这些服务。观测写入仅为 Swift 自己的沙箱 debug 文件，不开放 JS 文件能力。
- 观察预算：仅事件后 4 秒 CADisplayLink 请求 60Hz，最多保留 600 个原生实际回调与 512 个事件。原生帧遍历当前 UIKit 子树，不随全量消息遍历；JS core measure 只遍历挂载 cells。每帧只存原生观测到的 counters 摘要，完整 IDs 留在事件/AX；一个 label 缓存只在其变化时重新解析，长度受本合成 400 条上限约束，随 observer 销毁释放。观察会有成本，未测量，不宣称 60fps 实达。

## 构建与产物

仓库根运行，NSH 0.4 SDK、iOS 26+ SDK：

```sh
NSH_BIN=/path/to/nsh/bin/nsh node packages/nsh/scripts/build-history-terminal-uikit.mjs
# 也支持 --bundle-only；NSH_DIST 可指定发行包根。
```

每次新建唯一 `packages/nsh/.nsh/history-terminal/build-XXXXXX/`，**不覆盖任何旧输出**。目录内 `manifest.json` 给出 `.app` / bundle 路径、bundle ID、SHA256、源文件/生产模块 hashes、SDK/NSH、精确 AX、实际能力声明与 `capabilityContract`。builder 分别读取 config、实际 bundle、App 内复制的 capabilities：只允许两条精确调用，拒绝 wildcard/额外调用及 network/fs/process 授权，并校验 packaged capabilities SHA256 与 manifest 一致。Swift 从本目录动态收集，绝不编译生产 `ios/*.swift`。arm64 Simulator、ad-hoc 签名，**不是物理设备 App**。

builder 不安装、不启动、不运行 engine。只有 main 可以选择 UDID 后串行安装 `.app`、启动 `com.yee94.yuri.nsh.history-terminal`；此交付没有执行这些操作。

## 精确 AX 合同

| testID | 含义 |
| --- | --- |
| `terminal-transcript` | 真实倒序 List |
| `terminal-top` / `terminal-bottom` | 144 / 152pt 固定区 |
| `terminal-counters` | **accessibilityLabel 是完整 JSON**；视觉文本只是 compact 摘要 |
| `terminal-marker-record-0381` 等 | 每个真实 row key 的中性稳定 marker；testID/label 相同 |
| `terminal-row-record-NNNN` | 行容器 |
| `terminal-body-record-NNNN` | 真实 TextView |
| `terminal-metadata-record-NNNN` | 合成 metadata |
| `terminal-footer` | footer 根（内容可能为空，不通过 AX 缺席猜 more） |
| `history-load-older` | 加载/较早记录按钮，loading 时禁用 |
| `terminal-next` | 延迟 1200ms 后采用下一页 |
| `terminal-arm-page` | 建立 loading flight 后**等待显式提交** |
| `terminal-commit` | 提交当前挂起 page/controls；提交前后真读取几何 |
| `terminal-probe` | 挂起**仅控制项**，不增加/替换消息 IDs，不伪造 adoption |
| `terminal-toggle-footer` | 控制本次 commit 是否改变 more（非生产诊断开关） |
| `terminal-toggle-metadata` | 控制本次 commit 是否把旧端首个 assistant metadata 改为耗时 |
| `terminal-toggle-hold` | 默认 OFF 的实测面积暂留候选；必须显式 ON，不是生产修复已通过 |
| `terminal-capture` | 显式真读取几何 |
| `terminal-native-error` | Swift/加载失败，不能当空成功 |

控制开关在 loading 时不可改；重启得到干净默认。controls footer 关闭后仍可作 metadata-only probe，但不能继续翻页；做独立对照请冷启动。

## main 的录像/测量次序（未执行）

1. 默认冷启动，读取 counters：20 IDs、page=1、more=true、adopted=0。
2. 靠真实向旧端手势或 `terminal-next` 逐页到 page=19（380 IDs、18 次 requests/adopted）。每手势最多一页，布局回调不能自动刷页。
3. 真实滚动到旧端，松手并等 UIKit `dragging/tracking/decelerating=false`。按 `terminal-arm-page`，读取 loading=true、more=true，等待画面稳定。此时仍是 page19/380 IDs。
4. 在三个可见中性 marker 的静止基线上按 `terminal-commit`。必须同时保存 native capture、完整 counters、连续录像，不只比最终截图。
5. 最终 page20/400 IDs、19 requests/adopted、cursor=null、more=false/loading=false。检验同 marker 全过程 ≤1.1pt，不丢单帧、不仅等最终复位。
6. 两个独立冷启动对照：
   - **footer-only**：关闭 metadata，按 `terminal-probe`，静止后提交。`adopted=0 / messageIDs 不变`，more true→false，metadata 不变。
   - **metadata-only**：关闭 footer，按 probe 并提交。`adopted=0 / messageIDs 不变 / more=true`，metadata 已处理→用时。关闭 footer 开关时，也冻结 footer 按钮的文案与 disabled 状态；这是显式非生产隔离控制，不是默认生产路径或保高补丁。挂起期间按钮仍可按，但数据入口由 flight/loading 拒绝重复请求。
   - 同时关闭：列表内容没有 metadata / more / footer 按钮状态变化，是额外负控制；顶部 counters 仍真实更新，不能说整个 App 零 UI mutation。

`terminal-probe` 不等于网络返回或分页 adoption；实际 page 日志与 controls 日志分别计数。副作用开关只用于定位因果，不是生产补丁。

## 时钟、采用、几何的证据分层

- `HISTORY_TERMINAL` console 每条包含 `jsMonotonicMs`、phase、trigger、requestCursor、responseIDs、revision 以及完整 messageIDs/rowKeys/count/cursor/more/loading。seed、request、before/after-js-commit 明确分开；**JS commit 不冒充 UIKit 实际采用时刻**。
- `HISTORY_TERMINAL_MEASURE` 保存 `ViewRef.measure()` 的结果，标为 **coreMeasurements**。NSH 该 API 基于 core layout，不是 UIKit 真实 `UIView` 测量，不能单独给它授予原生通过。
- Swift `UIView.convert(bounds,to:surface)` 真读 UIKit frame（包含 inversion transform），同时读 UIScrollView 实际 offset、contentSize、drag/tracking/decelerating；**从不写回**。CADisplayLink 记录每个实际回调 timestamp、ProcessInfo.systemUptime、观测到的 counters label/revision、native markers。JS/native 时钟不假定同源；同事件 native receipt 用于关联，界面可见 revision 用于录像同步。它仍不是渲染器内部 commit ACK。
- 文件在独立 App `Documents/history-terminal/captures.json`。显式 capture 及观察结束原子写入，最多保留上述 ring window。长跨页录像应在目标事件后及时由 main 复制；不能用最后 ring 冒充整场完整时轴。frame 中看不到 counters/markers 必须 invalid，不能从 AX 缺席猜 footer false。
- 离线红回路准备为：`bun packages/nsh/tests/history-terminal/check-capture.ts <captures.json>`。>1.1pt 给 red；无真实闲置 scroll、少于三个同身份 marker、时钟错误或少于30实际事后采样给 invalid。通过字符串仅为 within-sampled-window，**不是视频 transient / 真实 Host PASS**。还应独立看录像逐帧；稀疏录制不能补帧假绿。

## 聚焦测试

```sh
bunx vitest run --config packages/nsh/tests/history-terminal/vitest.config.ts
# engine.steps.js 仅供 main 在其设备窗口用 stdin 交给 nsh test。
# 不在本次运行，也不由 Vitest 自动发现；CLI 没有独立 Swift observer，不能拿它验收 UIKit 几何。
```

纯单元覆盖 20→400 最后一页、完整 cursor/response/authority、稳定 key、独立变量、生产手势预算及几何红信号；`capabilities.test.ts` 覆盖授权边界。footer 暂留/释放和真实首次inactive-layout生命周期回归均先红后绿，最终本目录纯测试 **26/26 已运行通过**。builder 另执行 config/built/packaged 三层能力断言。`engine.steps.js` 仍仅准备，本 agent 没有运行 engine 或操作设备；main 的旧包启动失败、OFF/ON仍36pt红均保留。
