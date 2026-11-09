# NSH reportUsage 消费者核对与渠道阻塞

## 结论与交付边界

本次核对后的状态仍是 **未完成**。`reportUsage` 可以按当前 Host 的设置合同保存并回读，NSH 客户端更新/用量上报没有可接线的真实更新渠道。本次只新增本证据文档，不修改运行时代码、入口、observer、偏好标记或更新能力声明，不新增 reporter、timer、endpoint、统计字段或依赖。

`settings-preferences-core.ts` 的该字段继续是 `consumer: 'unconnected'`、成功缺省为 `false`；`settings-about-core.ts` 与 `ios/DiagnosticsBridge.swift` 的客户端更新继续为 `unsupported`。保存开关不是更新或上报已实现的证据。

## 真实 Web 来源与消费合同

| 环节 | 当前源证据 | 可证明的行为 |
| --- | --- | --- |
| 默认许可 | `packages/ui/src/stores/useUIStore.ts` 的 `reportUsage: false` / `setReportUsage` | 初始许可关闭；不是默认授权 |
| 用户设置 | `packages/ui/src/components/sections/yuri/YuriVisualSettings.tsx` 的 `handleReportUsageChange` | 用户变更先更新 UI store，再 `updateDesktopSettings({reportUsage: enabled})`；不在该 handler 中创建 reporter 或发独立统计请求 |
| Host 设置回读 | `packages/ui/src/lib/persistence.ts` 的 `settings.reportUsage` 分支；`packages/web/server/lib/opencode/settings-helpers.js` 的 boolean sanitizer | 仅 boolean 被接受/采用。Web store 与 Host 同步；不能把这个 store 称作 NSH 的设备内授权来源，也不能假定 Web 有 NSH 的 receipt/Host 退休门禁 |
| Web 更新检查 | `packages/ui/src/stores/useUpdateStore.ts` 的 `mapRuntimeParams` / `checkForWebUpdates` | 每次构造请求读取当前 store，向当前 runtime `/api/yuri/update-check` 传递许可位与已定义的 runtime metadata |
| Host 转发 | `packages/web/server/lib/opencode/yuri-routes.js` 的 `/api/yuri/update-check`；`packages/web/server/lib/package-manager.js` 的 `checkForUpdatesFromUpdateService` | 许可默认 false；转发 payload 为 `appType/deviceClass/platform/arch/channel/currentVersion/installId/instanceMode/reportUsage`。这里的 installId 归该 Host 的 package manager，不可复制为原生设备身份 |
| 手机更新 fallback | `packages/ui/src/stores/useUpdateStore.ts` 的 mobile 分支；`packages/ui/src/lib/mobileClientUpdateCheck.ts` | 有 mobileUpdates 时优先现有 OTA owner；其 unsupported fallback 才直连公共 feed，不经过连接 Host。fallback payload 固定 `appType: 'mobile-capacitor'`，没有 installId；携带 `reportUsage: options.reportUsage === true` |
| 当前仓库公共服务 | `deploy/update-service/lib/update-check.js` 的 `handleUpdateCheck` | 读取 currentVersion/appType/platform 和发布 manifest；Capacitor Android 返回 APK，Capacitor iOS 返回既有 TestFlight 地址。此 handler 没有读取 reportUsage、统计写入、统计队列或独立上报 endpoint。不能把传了许可位称为已验证服务端统计消费，也不能推断部署外部服务的实现 |

关闭许可并不等于 Web 停止更新检查：上述构造器仍可以发送 `reportUsage: false` 的更新请求。用户本次要求 NSH 未启用绝不发送上报，应约束未来真实上报 owner；不能将 Web 的版本查询行为解释成默认统计授权。

## NSH 现状与不能复用的渠道

- `settings-preferences.tsx` 用当前页面/operation scope 读取、PUT 并验证 GET；未知或失败不能当 false 已确认，ACK/unknown receipt 继续归原 owner。已有 production mock 覆盖成功缺省 false、true/false 保存、失败冷读不暴露确认控件和恢复。这是 Host 设置保存闭环，不是原生 reporter 生命周期。
- `settings-about-core.ts` 只从 `native.clientMetadata` 获取客户端 Bundle 版本；Host 的 `/api/system/update` 管理的是 Host 计划/任务。不能在此 CGI 上追加 NSH 统计，不能拿 Host 的版本代替原生版本。
- `ios/DiagnosticsBridge.swift` 的 `NativeAboutSnapshot.metadata` 明确返回 `updates.status: 'unsupported'`，blockers 是 `signed-artifact`、`trusted-update-origin`、`signed-manifest-verifier`、`native-install-lifecycle`。详细发布/安装未完成边界见 [settings-about-contract.md](./settings-about-contract.md)。
- `mobileClientUpdateCheck.ts` 固定 Capacitor 身份，其 iOS fallback/TestFlight 指向既有 Capacitor 产物；`package-manager.js` 的 `normalizeAppType` 也只有 web/desktop-electron/vscode/mobile-capacitor，未知值退回 web。NSH 既不能冒充 Capacitor，也不能发送猜测的 appType 后宣称服务端支持；公共 handler 接受 JSON 本身不证明它有 NSH manifest、签名或安装目的地。
- About 的默认关闭本地安全事件 recorder 是另一项能力；它只在用户明确导出时分享内容受限的事件报告，不消费 reportUsage，不是网络匿名用量上报，不应将二者串联。

## 启停、pending 与重复调度的证据边界

当前 Web 许可 handler 没有独立 reporter 的 start/stop/drain；上述更新 payload 在派发时快照许可。源码不支持宣称“关闭会撤销已发请求/撤回服务端统计”，也未提供可移植的匿名上报 pending journal。`useUpdateStore` 的 checking/generation、App 的 packaged-Electron 检查 timer 和 mobile OTA owner 各归原有更新流程，不能复制成 NSH 的第二套调度。

NSH 本次没有创建上报 flight、pending 队列、发布回调或 timer，因此没有新增 late publish/duplicate scheduled 报告风险；这不构成未来原生 reporter 的关闭中 pending 验收。该项仍未完成，不用仅保存 false 的测试假称覆盖。

后续必须先由真实 NSH 更新渠道 owner 给出该产物的发布身份、版本来源、可信 origin/响应合同、统计许可消费及安装生命周期，再在这个 owner 中消费当前已确认 Host scope 的许可；未知/未启用不派发统计、关闭/后台/Host 退休拒绝迟到发布、single-flight 和唯一 scheduler 都须通过实际生产接线的 mock 回归。不得新增敏感正文、机器路径、凭据或猜测设备身份。当前没有可交给 main 的单行接线，添加未使用模块不能解除阻塞。

## 本次允许的验证

使用现有 standalone Vitest 配置，focused 运行 `settings-preferences-core.test.ts`、`settings-preferences-production.test.ts`、`settings-about-core.test.ts` 和 `settings-about-update.test.ts`。这些是 mock-only 行为回归，覆盖偏好默认/保存/回读、真实生产偏好组件装配、About 元数据与 Host 更新生命周期；不证明原生客户端更新/统计已实现或验证公网服务。

本次实际运行：`./node_modules/.bin/vitest run --config packages/nsh/vitest.config.ts packages/nsh/settings-preferences-core.test.ts packages/nsh/settings-preferences-production.test.ts packages/nsh/settings-about-core.test.ts packages/nsh/settings-about-update.test.ts`，**4 files / 167 tests passed**。这是本次文档新增后的独立 focused 结果，不引用 main 正在运行的全 suite 作为本次验证。

没有执行真实 Host、统计网络、设备/模拟器、付费接口、Git/GitHub、依赖安装或全 suite。本次仅源码阅读与 Markdown 证据整理，没有引入或变更依赖 API，因此不需要基于库 API 的 Context7 查询。
