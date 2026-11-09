# WorkStatus：实际 retained Chat consumer

`Root.tsx` 直接挂生产 `YuriNativeApp`，没有注入 Chat、WorkStatus owner 或消息投影。具名测试 gate 仅在公开 `host.call` 返回后暂停 exact-parent GET 的交付，模拟模态撤权后的迟到响应；不持有真实凭据或调用模型。

`desktop-work-status-application-native.test.ts` 使用独立临时配置，执行 Mac/Windows 模型各五个场景：

- 原 Chat tasks、完成/取消/待办、原 Header 唯一 light Git 投影与 exact-parent child GET；历史 running tool 不显示成 working。50 次真实 Composer 编辑零额外 child 读取。
- 窄窗 Header toggle、Overlay Escape、重开保展开；只读 child 进入原工作台，不导航替换主会话。1200pt 下主内容不足 350pt 时按 Web `ChatWorkspace` 隐藏；关闭工作台恢复原 parent transcript、唯一 Composer 和编辑后的草稿。
- Settings 撤销在途 child lane，迟到结果不发布；关闭后仅新 lane 重新读取，显示新响应，不复活旧 title 或重建 Chat。
- inline→overlay→inline resize 保留 todo/subagent 展开状态；失败刷新保留已确认 child title，不转成权威空。纯几何变化不重复读取。
- 原 root live cache 的 exact child working→idle 即时更新分组；旧 lease/错误目录事件不接纳，缺 expectedHost 降为 unknown。关闭撤订阅，重开读集合后同步采用最新 activity；50 个无关 child/text 事件不增加 child GET 或父历史读取。

测试 Host 严格要求 `location[directory]` 请求上下文与 session.list 的 `directory` 过滤同时存在，parentID/limit/方法/lease 精确匹配。夹具不能漏掉正式过滤条件并将生产 adapter 的拒绝误记为“零读取”。

```sh
NSH_BIN=/path/to/nsh/bin/nsh bunx --no-install vitest run \
  --config packages/nsh/vitest.config.ts \
  packages/nsh/desktop-work-status-application-native.test.ts
```

这些是合成 Host 下真实 NSH/QuickJS 生产树证据，不是 AppKit/Win32 视觉、物理键盘、系统 Clipboard、生产网络 child live 或 Windows executable 验收。session/worktree attachment、后台 shell aggregate、同状态对帧与系统输入性能仍须独立验证，未知不填零。
