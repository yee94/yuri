# Header：实际 App consumer

`Root.tsx` 直接 `mount(YuriNativeApp)`，不注入 Header、Chat、services 或数据 owner；具名测试 gate 在公开 `host.call` / `AlertDialog.show` 已返回后暂停 MCP / 文件确认结果的交付。`desktop-header-application-native.test.ts` 在独立临时配置运行实际生产树的 Mac/Windows 模型各十三场景；不改共享 `.nsh/test`。

## 已覆盖入口

- 实际 restored Chat 的唯一 metadata owner、context ring、完整 Context 入口与原 composer。主历史和唯一 Header 各有一次有界 message GET；唯一 Header 的 light Git read 不因输入重建。
- 50 次 clear/paste 零附加 Header、quota 或 services 请求；使用手动时钟区分输入工作和既有周期轮询。
- Usage 首次打开显式读，已加载重开不自动刷新；显式失败保 prior/stale、按钮恢复可重试，mode 无真实写 owner 时禁用。
- Usage family 在外层 keyed Header 保留：展开后关闭/重开与 Settings 覆盖不丢失；不同 family 不互相展开。正式 provider payload 驱动 marker、pace 和成功刷新时间，50 次 Composer 编辑零附加 quota/metadata 读取。
- Browser 首次空地址不猜 URL、不创建 viewport、不交系统 fallback；临时 Settings、关闭重开保地址草稿。
- 实际 services tab 通知驱动原 retained runtime owner；MCP 仅可见时读正式 config/status。部分失败保兄弟行，离开 Tab/打开外部模态/关闭后无后台读取。
- MCP 未知 POST 只锁对应行，关闭重开不重发；显式 retry 仅 GET，后续新用户动作才可再次 POST。原 Chat/草稿不被替换。
- MCP 在途响应被 Settings 撤权后不发布，关闭 Settings 不自动重开 services；下一次用户打开才启动新读 lane。
- Instance 只读 committed app 与唯一 SSH root，未证明的类型显示 Unknown；显式 refresh 零额外 Host read，不猜 default/new-window/更新能力。
- 同一连接 Switch 为零 native select 的 no-op；clean Switch 仅选择 exact 目标一次。Add 委托原 Saved connections 设置页，关闭后保主稿。
- 实际 native file journal 冷恢复的脏文件 Cancel 保 editor/主稿；Discard 后允许已准入根 ticket 继续，不依赖已关闭的 Header 弹层。原确认结果暂停期间打开再关闭 Settings，或离开 Chat，都会永久撤权旧 Switch，零 native select。

`Host.js` 扩展严格 Navigation Host，只接受精确目录、具名 endpoint、GET/POST/body 与 captured `{hostID,lease}`。MCP 写入仅修改测试内存状态，未知结果也是合成丢回执；没有真实账号、Host、模型或 OAuth 操作。GUI 插件不在本轮范围。

## 边界

运行命令：

```sh
NSH_BIN=/path/to/nsh/bin/nsh bunx --no-install vitest run \
  --config packages/nsh/vitest.config.ts \
  packages/nsh/desktop-header-application-native.test.ts
```

这不是真实 OS 窗口、截图对帧、IME、系统菜单、网络中止或 Windows executable。SSH Connect 的真实确认/保护、About 更新 source/native gate、OpenInApp、GitHub、MiniChat 与 quota-mode mutator 仍须独立接线/验证；WorkStatus 的实际根证据单独记在相邻测试目录，不由本文件代签。native writer 新协议接入期间需再次复跑，当前无跨 Engine 可写权限签收。
