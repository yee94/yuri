# Production resource page UIKit fixture

syntheticOnly。此目录只拥有隔离启动器、内存只读 I/O 与审计，不替代产品 UI。通过生产 `loadConnections` → `connectionSnapshotFrom` 接纳原生签发的 opaque expectedHost，再挂载真实 `NativeAppearanceSync` 与生产 `ResourcePreviewPage` / `ResourceFilesPage`，其父为真实 NSH `NavStack`。不导入或证明完整 `AppRoutes`，该项仍归主会话验收。

Swift 使用真实 `NshAppView`、`ResourceBridge` 公共 captured transport init、HTML view/exact presenter anchor、SVG factory、`NativeSheetPresentation` 和 GUI bridge/resource owner。完整 production Swift（排除生产 main）参与 SDK 编译；不实例化 RuntimeBridge/ConnectionStore，不使用 SDK shim。GUI registry 读取显式空 inventory，以 actual unmatched 结果允许 HTML preview。构建使用生产 GUI builder 在本轮独立目录重新生成 adapter，避免生产源码已修、fixture 仍复制旧 global bundle；逐项验证资源 manifest 字节/hash。本 fixture 不重新证明 GUI browser 全输入源码的构建来源。

`check-gui-unmatched.mjs` 在纯 DOM 环境加载实际生产 GUI bundle，用严格合成原生 message port 返回原始 JSON `[]`。只有 actual registry 发布 `unmatched`、没有 `error`、唯一 inventory GET 且无未知操作才放行 bundle/app 构建，输出 `gui-unmatched-contract.json`。这个离线合同不运行 NSH/WebKit/UIKit，不把失败改成 unmatched，不包装伪造的 Host `{data:[]}` 响应。

ef12e23c 的设备快照已证明 GUI failed 时显示 HTML 源码、没有默认 embedded WK；同时资源 action row 横向超出视口（GUI button x≈342.7、width≈186.7，视口宽402）。这些是未通过项。对 ef12e23c 原始 adapter 的离线复现，在成功 `GET /api/plugin` → `[]` 后发布两次 `error`。生产 browser 原先读取 SDK 返回的 `.data`，而实际 Promise SDK 直接返回数组；本轮经授权只修 `gui-plugin-browser.ts` 两个方法的 raw 合同，连同 browser/artifact 测试改为真实 HTTP raw payload，不修改 HTML/resources/application owner。新完整 App 仍由主会话独占设备复验，离线转绿不覆盖按钮越界或 UIKit 状态机验收。

运行构建（均不安装、不启动）：

```sh
node packages/nsh/scripts/build-resource-page-uikit.mjs --stage-only
NSH_BIN=/path/to/bin/nsh node packages/nsh/scripts/build-resource-page-uikit.mjs --bundle-only
NSH_BIN=/path/to/bin/nsh node packages/nsh/scripts/build-resource-page-uikit.mjs
```

每次创建 `.nsh/resource-page-uikit/<unique>/`。源码和真实 SDK 冻结到本轮目录，manifest 保存准确 SHA256、bundle 和 executable hash；旧 artifact 不变。`--stage-only` 不调用 NSH，默认额外完成真实 SDK typecheck/link/sign。本轮禁止设备/engine run，成功构建不能算 UIKit 验收。

可点击路线（launcher 的英语是 synthetic 测试内容，不增加产品菜单或词典）：

1. `resource-page-open-index`：默认生产 HTML 内联预览，真实 GUI registry unmatched 后应显示相对 CSS、JS、PNG。
2. DOM 中点击 `mark`，记录 `DOM mark: 1`；点击 `watch` 只读合成 `watch.png`，内存 fixture 增加同一原件的 stat version。等待生产 watcher 后 DOM mark 应保持、`htmlInitial` 不增加。没有 history observer、定时 DOM 抽样或主桥注入。
3. 使用生产 `resource-html-mode` / `resource-html-fullscreen` 切 source、fullscreen，再点真实 header Back（`resource-html-back`）；保存/分享使用生产 `resource-html-save`、`resource-html-share`，只取消系统窗口，原件留在 Swift 临时文件。
4. 普通内联态再点系统父 header Back 回 launcher；launcher `resource-page-audit` 获取最多 48 条原生请求和聚合阶段计数。`resource-page-open-files` 为生产目录页，`resource-page-open-note/plain/art` 覆盖 Markdown/text/SVG（SVG 内含 data PNG）。

所有 runtime 请求核对 exact expectedHost，GET 仅允许显式 route/query；未知 GET 抛错，没有通配成功。业务 Host 写入/RPC 一律拒绝，计入 `deniedHostWrites`。appearance.apply/reset 是本机生产外观桥；合成 stat bump 仅修改测试内存。无 network/openURL/picker/speech 全局 grant，无凭据，HTML 不接入主应用桥。background 使此次 synthetic receipt 永久失效，需重新启动隔离 app，不伪装恢复证据。

待主会话独占模拟器验证：真实 NSH UIKit 挂载、actual GUI unmatched、默认 HTML、source/fullscreen/Back、Save/Share cancel、watcher DOM 保持与 SVG data image。此 fixture 不证明生产 AppRoutes、真实 Host、Relay 或完整 1:1 验收。
