# Window metadata 与设备偏好准入

`desktop-window-metadata.ts` 只拥有原生稳定窗口描述符的 TS 消费。它不是 Host authority、Vault、文件/聊天 journal 或多窗口 writer grant。

## UI metadata

- 原生 `windowKey/windowKind` 在 Engine load 前注入；只接受 `main` 与 1–128 位 ASCII `[A-Za-z0-9_.:-]` key。随机 HTTP `windowID` 不是持久身份。
- 为已有单窗 embed/headless 保留“两字段完全缺失”的 primary metadata 兼容；partial、非法路径、未知 kind 均拒绝。实际 App 在连接和 runtime 请求之前显示不可用，不覆盖旧记录。
- 白名单仅有 `desktop.navigation.v1`、`desktop.layout.v1`、`desktop.panel-tabs.v1`。primary 保原 key；其它 key 使用 `desktop.window.v1:${encodeURIComponent(windowKey)}:${key}`。
- 第二个窗口不复制 primary metadata。所有 Storage 失败原样进入原 navigation/layout/tabs owner 的 prior、retry、flush 和 close veto。
- 草稿、文件 journal、语言、字体、快捷键与 Diff 等设备偏好不能经过此 adapter。分区不等于跨 Engine 写安全。

## 原生协调模式

`desktopWindowPreferenceCoordination(params)` 只在完整有效的原生描述符显式提供 `windowCoordination:'single-engine'` 时返回单 Engine。`multi-engine`、缺失、未知或畸形策略均走已有 unsupported 多 Engine 偏好 lane，不能凭 primary、窗口数量或 JS singleton 猜可写。

实际 App 将该值传给唯一 Diff preference owner；多 Engine/未知策略下不读写全局 Diff key、不提供可变控件，仍保留正文、草稿与窗口 metadata。旧描述符的 primary metadata 可恢复，不意味着设备偏好也获准写入。策略由 native process 从首个 Engine 固定，TS 不把关闭到只剩一窗当成降级许可。

## 证据与未完成

- `desktop-window-metadata.test.ts`：primary 兼容、稳定 key 冷恢复、三类 namespace、输入不可变捕获、失败透传、白名单拒绝、coordination 不从 key 猜测。
- `desktop-navigation-application-engine.test.ts` 的实际 `Navigation.test.tsx`：Mac/Windows 模型中 secondary 使用自己的导航/布局/空 browser 标签，primary 字节不变；非法描述符零 connection/runtime 请求。
- `desktop-diff-application-native.test.ts`：显式 single-engine 保留原设置/工作台/unknown close 合同；primary 的 multi-engine/缺失策略均零 Diff preference Storage I/O。

以上是合成 Host、NSH headless 与 Storage API 证据，不是 AppKit/Win32、多生产可写窗口、磁盘 fsync 或跨 Engine CAS 验收。原生 Process、journal/catalog namespace、同会话 writer 互斥和窗口恢复剩余项由 `desktop-host/WINDOW-KERNEL.md` 单独记账。
