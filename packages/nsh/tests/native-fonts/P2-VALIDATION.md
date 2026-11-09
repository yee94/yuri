# Font owner oracle P2 修复（2026-11-08）

原 artifact `84528a1e`、其 stage 冻结源码与 `.scratch/nsh/fonts-84528a1e-uikit` 的 main 设备证据均保留，不覆盖。main 已证明旧包八组 UIFont、47 baseline face 与 cache cycle；该证据不抵销 oracle 指出的两个 process ownership / recovery 缺陷，也不作为新包或 CTRun 的验收。

## 两项 RED → GREEN

- `retired-bundled` 先实际失败：A 的异步 JetBrains 加载在 owner 退休后仍把 B 的新建 CTFont 改为 2.211。现把共享 single-flight 限为 SHA 验证的字节读取；`load(...authorized:)` 的调用者在 byte await 后、每次实际注册/替换前核验独立 live selection authority。真实回归 A deferred → invalidate → B bundled → A completion，**重新创建** B 的 CTFont 仍为 2.304；B 后续显式选择可用已校验字节注册 2.211，总读取仍三 face。另有两个 consumer 共用同一 byte flight、A 退休但 C 合法选择的真实回归，C 可以注册，A 被取消，不无限下载。
- `partial-recovery` 先实际失败：一个 Medium face 被外部注册替换后，移除 conflict 再 retry 仍在自有 Regular 上 collision。现 `owned(face)` 按 source identity、注册 URL、文件 SHA/长度、实际 PSName 核验并逐 face 复用。rollback journal 只记录本次新增/替换。真实回归 register 三 face → Medium 注销/foreign collision → reject → 移除 conflict → retry 恢复完整集合；Regular/SemiBold 的 fresh CTFont URL 在失败及恢复后保持原自有 URL，且无额外字节读取。未放宽任何外部 family/PSName 信任。

## 新 artifact

- App：`packages/nsh/.nsh/native-fonts/2026-11-08T01-01-50-473Z-bba6824b/NativeFontsFixture.app`
- Bundle ID：`example.nsh.native-fonts.run-bba6824b`
- Manifest：同目录 `fixture-build.json`，全部 47 fixture SHA、source SHA、可执行 SHA 与原 SDK interface SHA 已冻结。
- 旧 executable SHA：`11259a252ca164d04a9d5e6fb8b1a28866c71f710868a2761eab0a68a70c3714`
- 新 executable SHA：`73a6395acac0513ad8d22ba4032f06e9be6ebe38d1db5be107cd0c79cf10c3a4`
- NativeFontRegistry：`b67d92caf2a7a59940bbff177f74d134f02506315a0ca8ced5b25b48dbc2fb59` → `7566e0f3a9acb0fef08ef14f8f4602156a7ace7235390133ec36b03abeae6fc5`
- NativeFontOwner：`46861c6a082fefeeddf52ee9ff907a081bddee45a7d6db104e21f8ddfc64effb` → `f4fa1ef820d6d3c99c44951d6dbcb49e1f24016e7b9587c512979dc81281cdfb`
- AppearanceBridge、native-font-projection、appearance.tsx 与旧 manifest 对应 SHA 相同；未改原 palette / ACK / rebind、application/state/RuntimeBridge、Input/selection 或发行 SDK。

聚焦 12 文件 **102 项通过**；完整 NSH tsc 通过；原发行 iOS SDK typecheck、NSH bundle、链接、签名完成。新包没有安装或启动，设备仍由 main 独占。dead-code 首次 120s timeout，后台重跑已完成（exit 0，non-blocking）；报告仍有既有 unused 与 NSH entry 覆盖提示，没有据此删除其它 owner 文件。

CTRun 精确读回是后续独立 SDK diagnostic carrier；本包仍没有宣称自绘 Text run 已验收。固定字体 fixture 只有离线 byte reader，未发真实 Host/CDN/Relay 请求，未执行 Git、依赖安装或模型调用。
