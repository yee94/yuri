# Usage：生产 App consumer 闭环

这里只新增测试，不修改 production。不是组件 fixture 或单独挂载 SettingsUsage。

## 真实入口与 owning 边界

- 前三个场景在原始 `packages/nsh/App.tsx` 上运行，实际挂载 `YuriNativeApp`；点击产品 `desktop-settings` → 设置搜索 `Usage` → `desktop-settings-page:usage`。没有 entity、dependencies、publisher、SettingsRoot 或 route 注入。
- 第四个场景由 `DelayedRoot.tsx` 直接 `mount(YuriNativeApp)`。它只按现有 `NavigationRoot.tsx` 的公开 Host 边界 gate 模式，原样转发 native request，再挂起一份已经返回的 Google GET 响应；不改请求 DTO、operation、scope、生命周期或页面。
- 挂起不能放在 `nsh/test` 的 Host handler Promise 内：那会让驱动等待自己的 callback，后续步骤无法继续。该 harness 限制不是生产 App 缺陷。公开 Host 返回边界的 gate 只用于精确迟到响应场景。
- `Host.js` 扩展现有严格 `NavigationHost.js`；quota 使用真实注册 provider 清单与既有纯 fixture DTO，不重复创建 component fixture。每个 quota GET 必须携带精确 `{hostID, lease}`；builtin 不接受额外 query；Magpie 只接受 `refresh=1` 和实际项目目录。
- 所有 settings/quota 写入、创建会话、模型发送及未知 runtime 请求均拒绝。真实 Chat 的原生 Goal **只读** RPC 仍由现有 `isNavigationReadOnlyGoalRPC` 精确核验 method/path/body，不以允许任意 POST 冒充只读。
- HTTP/独立 stream capability 显式 unsupported，SSH 返回正式 unsupported DTO；沿用原 fallback，不开启 native 服务。通知只提供正式 denied status 与禁用 configure DTO/内存 lease，不发送通知。
- 临时 manifest 继承产品的具名 capability 数组，唯一额外 grant 为测试 gate 的 `usage.application.test`；没有 `host:true` 或 wildcard。配置、入口与 `.nsh/test` 都在独立 temp 目录生成，结束后仅删除本次目录。

## Mac / Windows 各四项

1. 实际无 entity 的设置路由启用一个 `desktop-usage-scroll`，不是移动 `usage-scroll` 或实体 split；首次每个注册 Provider 和 Magpie 各读取一次。Provider 切换不新增读取、不重建路由；Magpie 草稿和 Gemini family 折叠保留；真实 dirty close Cancel 保稿，同身份前后台恢复只新增一批读取。
2. 从真实侧栏 `Saved exact conversation` 点击进入真实 Chat，而不是注入导航记录。Settings、全局搜索、帮助顺序覆盖后仍只有一个实际 `composer`，草稿不变；50 次真实 Input clear/paste 后 **全部 runtime request 数与 quota 数均不增加**，不是只检查 callback identity 或组件 helper。
3. 初次 Google 503 不显示成功 no-data/no-windows；恢复 GET 采用真实账户/余额；再次 503 保留既有 `$19.25` 与账户，不把失败变成权威空集合。每次手动 refresh 每个 Provider 仅一个读取。
4. 刷新中的 Settings 关闭保持禁用，测试不点击或绕过它。通过原 native connection-list 前后台刷新接收同连接的新 authorization/lease，真实根退休旧 Settings。新 Usage 显示 `Rotated Google Usage` 后放行旧响应，不能覆盖新 owner，也不能新增旧 scope 请求；原 lease Google 共两次，新 lease 仅一次。

每个场景都断言 native network request 为空、未发生 runtime mutation、严格 Host 拒绝记录为空。账户、域名、目录、用量和连接身份全部为 synthetic；没有读取凭据、调用真实 Host/账号/付费服务或执行 Git。

## 重跑

```sh
NSH_BIN=/path/to/nsh-0.4.0/bin/nsh \
  bunx --no-install vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/desktop-usage-application-native.test.ts
```

wrapper 除检查 exit code 外，还检查内部 `8 passed`。精确复现某一类场景可额外设置 `NSH_USAGE_APPLICATION_FILTER` 为 `entity-free`、`50 edits`、`provider read failure` 或 `native authority retirement`；不要把筛选运行冒称全套通过。

本轮真实根 **8/8 GREEN**。这是 NSH headless 的 Mac/Windows 逻辑模型与真实生产 consumer 证据，不代表 AppKit/Win32 系统窗口、像素视觉、读屏/物理键盘、真实 native transport/凭据、网络或磁盘持久化签收。没有发现需要本测试 owner 修改 production 的问题；并行 production 变化后 main 仍须重跑。

最后一次配套检查：`tsc --noEmit --project packages/nsh/tsconfig.json` GREEN。`bun run dead-code` 已执行，仍被现有 `packages/web/vite.config.ts` 缺少 `vite-plugin-pwa` 阻断，未为此安装依赖或修改配置。
