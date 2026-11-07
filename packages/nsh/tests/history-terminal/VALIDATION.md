# 本次交付状态

**当前为修正首次inactive-layout生命周期的默认 OFF 实验 App；纯测试/独立构建完成，UIKit 暂留与释放仍待 main 三轮复验。上一候选 ON 已实测仍36pt红；真实 Host 53pt 仍红，二者不能混同。**

## 首次启动失败，不作为可用包

- 旧包：`packages/nsh/.nsh/history-terminal/build-ewhxQ0/HistoryTerminalFixture.app`，保留未覆盖。
- main 已实际安装/launch，AX `terminal-counters.status` 报错：`Error nsh/host terminal.record is not granted add capabilities.host nsh.json`。
- 根因有两层：builder 写了空 `capabilities`，Swift 又用 `grantCapabilities("{}")`；只注册 handler 并不授予 JS 调用权。前次构建/签名/tsc 成功未覆盖此运行时拒绝，旧 App **不能算可用**。
- 该次授权修正版 `build-fOJeIE` 已让 Swift grant ceiling 直接读取同一份 bundled capabilities；main 随后实际跑通观测并取得下面的红信号。它是当前候选之前的基线，不是本轮最终包。

## main 已取得、本 agent 已离线复核的基线

- `.scratch/nsh/chat-frames/terminal-footer-1794042977692/captures.json`：checker **red / 35.999755859375pt / 239 samples**，三个 marker；offset0不变，footer36→0、contentHeight相差36，adopted=0。
- `.scratch/nsh/chat-frames/terminal-metadata-1794043133679/captures.json`：checker **0pt / 239 samples / within-sampled-window**，只对应合成同高文本，不排除生产 metadata 高度因果。
- 真实 Host 53pt 仍未解决。本轮候选不得冒称修复生产。
- main 实跑 `build-wtJRBv`：OFF `.scratch/nsh/chat-frames/terminal-footer-1794044345279/captures.json` 仍36pt红；ON `.scratch/nsh/chat-frames/terminal-hold-1794044412170/captures.json` 本 agent 离线复核仍 **35.999755859375pt / 239 samples red**，measuredHeight0/minHeight0，不能算候选有效。
- ON旧日志中首次 `footer-layout` 为JS28.786ms、active=false，toggle ON为2641.204ms但无新layout，之后直到hidden才收到0高回调。commit前helper真实事件缓存offset0与native0一致；2579是旧UI发布快照。完整调查与本轮合同见 [MEASUREMENT-LIFECYCLE.md](./MEASUREMENT-LIFECYCLE.md)。

## 最终产物

相对仓库根：

- App：`packages/nsh/.nsh/history-terminal/build-63t70l/HistoryTerminalFixture.app`
- 完整 manifest：`packages/nsh/.nsh/history-terminal/build-63t70l/manifest.json`
- Bundle ID：`com.yee94.yuri.nsh.history-terminal`
- arm64 iPhoneSimulator；NSH `0.4.0 (e626a8d)`；SDK `26.5`。
- bundle SHA256：`eeea35cd1e8d25d571b4ea37a129caf31cecdf8ad07888cf87d505a44ed91a2a`
- executable SHA256：`c0437dcee4762c72a5621f60a2675f33c20acf5fe25b633c692914602f95423b`
- packaged capabilities SHA256：`738e48e7beae503c3bd81b276b97c8f38cf9241df1a5098572c4be34fbf1bea8`
- 独立 config build：`4`；bundle ID 不变。fixture 源 hash `39d4817e2aa3c7cab98b5cc41440063d248866dfabaed4fa8b0894d55820e13d`；helper 源 hash `cc61bab7cfc9cf3f4d90d120ed9dec6b592694aefe5dfbd948be0aaaacedf17c`。
- `experiment.defaultEnabled=false / releaseUIKitVerified=false / noScrollWrites=true`。只新增 helper，生产接线留给 main；application/history-scroll/原 fixture 未改。

此前构建在其它唯一目录，仅保留，不作为最终交付。最终 manifest 的 fixture/Swift/config 源 hash 对应本轮构建。

## 已实际执行

1. `NSH_BIN=<本地发行包>/bin/nsh node packages/nsh/scripts/build-history-terminal-uikit.mjs`：NSH release bundle、仅本目录 Swift、SDK 链接与 ad-hoc 签名成功。
2. `bunx --no-install tsc --noEmit -p packages/nsh/tests/history-terminal/tsconfig.json`：最终通过。初次发现 TextView root 文本样式放错字段，已改为官方 `styles.root` 后重新构建/检查。
3. `node --check packages/nsh/scripts/build-history-terminal-uikit.mjs`：通过。
4. `node --check packages/nsh/tests/history-terminal/engine.steps.js`：仅语法通过，未执行步骤。
5. `codesign --verify --deep --strict <上述 App>`：通过。
6. `plutil -lint <上述 App>/Info.plist`：OK。
7. `otool -L <上述 executable>`：仅系统/Swift 动态库；没有遗漏的外部 `@rpath/NativeShell` 动态 framework。
8. builder 已实际执行 `verifyTerminalConfig`、`verifyBuiltTerminalCapabilities`（bundle 和 packaged App 各一次）：host **恰好** `terminal.record`、`terminal.capture`；network/fs/process 列表均空；clipboard/picker/openUrl/statusBar 为 false。缺少调用、额外调用、wildcard、其它能力字段均拒绝。
9. Swift 改为从 `nsh/capabilities.json` 读取 grant ceiling；builder 对 packaged App 再校验其能力内容及 SHA256，与 manifest 一致。`capabilityContract.verifiedBuiltBundle/verifiedPackagedApp` 均为 true；这证明静态授权链一致，**不冒充已执行 host.call**。
10. 构建后 Node 独立只读审计实际 packaged capabilities、config、manifest 和 fixture hash：通过。随后对同一能力断言输入旧包/新包的实际文件，输出 `old-empty-grants=REJECTED new-exact-two-calls=ACCEPTED (static files only; no engine)`；旧错误配置确实使新断言变红。
11. 第一轮 no-retention adapter 9项中7项失败（实测36但minHeight0）。本轮真实callback顺序回归先跑 **15 tests / 2 failed**（首次inactive-layout丢失及新scope初始layout无法采纳），修正后 `bunx --no-install vitest run --config packages/nsh/tests/history-terminal/vitest.config.ts` **4 files / 26 tests passed**。包括真正hidden返回不得复用旧高度与1000次scroll零发布；纯逻辑检查不冒充原生 geometry。
12. 本轮 focused tsc、独立 NSH+Swift SDK 构建通过；builder严格验证实际 packaged 两调用授权。离线重跑 main 的 ON失败 capture 仍为上述red，不启动任何 engine。

## 明确未执行

- engine smoke **仍只准备，不运行**。纯 unit和旧 ON失败capture的离线 checker 本轮已实际运行。
- 本 agent 本轮未安装/launch/操作模拟器、物理设备、浏览器或真实 Host；未读 Keychain。main 之前启动旧包的失败已单列，不抹除。
- 没有运行生产 App/build 或修改 application、history-scroll、原 fixture 等其它 owner 文件。
- 未跑全仓 dead-code、包级测试或其它与隔离构建不相干的检查，保持本次允许执行范围。
- 新生命周期修正版尚无实际启动/host.call/UIKit capture/录像结果；首次测量采纳、默认 OFF红信号、ON暂留/释放和帧率均待 main 复验。旧版ON失败保留，不将纯测试/构建绿挪作UIKit通过。
- 当前没有下派工具，未派发下层代理。

main 操作合同、精确 AX 和变量隔离次序见 [README.md](./README.md)；新 `terminal-toggle-hold`、最小生产接线及三轮释放矩阵见 [FOOTER-EXPERIMENT.md](./FOOTER-EXPERIMENT.md)。footer 默认真实移除，ON 暂留明确公开其面积，不以永久占位制造绿灯。原生与 core measurement 分开记录，JS commit 未冒充 UIKit commit ACK。
