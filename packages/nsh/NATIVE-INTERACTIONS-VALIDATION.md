# Fork、系统材质、进度入口与新会话目录（2026-11-07）

本轮处理用户报告的 fork 报错、顶底部不透明、输入框进度无法点击、键盘贴边及新会话模型/Agent 空列表。另一线程同时修改此工作区，下面分开记录实际构建与后续源码检查，不能将某次成功覆盖到后来变化的源码。

## 修复与证据

- **fork**：原实现先要求单条正文读取成功，再读取同一条消息所属的有序分页历史。fork 本身只需要后者的身份和执行边界。现在在操作开始时捕获选中消息，以真实分页历史验证消息存在，再用共享 `resolveNativeForkBoundary` 计算 exclusive boundary；保留 Host/page fence、选中消息变化检查、未完成 live turn 拒绝及唯一 mutation lock。新增回归证明精确正文读取不可用时仍可从有效历史分叉，消息不在历史中则零写入。未对用户真实 Host 创建分叉；截图所在 Host 的精确 GET 失败原因未独立复现，不将合成测试称为真实 Host 根因证明。
- **新会话目录**：组件在 Sheet 的 `native-opening` 阶段挂载，初次 load 因 inactive 被跳过，`onOpen` 后没有再加载。模型/Agent 两条生产闭包回归修前均为 0 次请求，修后呈现切换加载一次，50 次无关更新不增加读取。使用 effect 监听 active 边界，读取置于 untracked；目录原有错误/部分结果和恢复语义保留。
- **进度点击**：展开 chrome 原来 progress 一大于 0 就禁用所有子控件，即使此时仍大部分可见；现在到展开部分不可见时才禁用，透明容器不拦截子控件。Tasks/Changes 触区扩至 32pt 并添加 6pt hitSlop。实际 UIKit 首轮 Tasks 点击曾触发 `cannot read property 'height' of undefined` 并退出；headless 未稳定复现同样问题。将窗口高度在输入框 owner 派生并传入列表后，最终 UIKit 包中 Tasks 可打开、关闭、重开，AX 能读到真实任务行，设备控制台未出现该 JS 错误。临时几何日志已移除。单次及少量重开不足以证明所有时序问题已消失。
- **键盘**：Chat 与新会话使用 NSH 官方支持的 `env(keyboard-inset-height)`/`calc`，由原生执行键盘动画；键盘上方间距为 12pt。去掉按 JS keyboardFrame.height 数值补偿和 transitionDuration。隐藏键盘时只使用页面的 home-indicator inset，不修改 window safe area、additionalSafeAreaInsets 或全局键盘通知。
- **系统材质/Tab**：UIKit appearance 使用默认系统材质、透明底色、无 shadow 分隔线；Home TabBar 浮在视口底部，四 Tab 的滚动内容使用实测 bar 高度增加尾部空间，视口本身保持完整。未重绘原生导航/Tab 或添加仿玻璃层。正常内容仍有必要的安全区保护，背景不再因 Tab 的布局占位被截断。

## 实际 UIKit

使用本轮独立创建的 iPhone 17 Pro / iOS 26.5 模拟器，不复用其他线程的设备或真实 Host 凭据。

- `new-session-uikit` build `2026-11-07T15-27-03-878Z-244fa4d1`：经真实只读 snapshot admission 打开生产新会话页面。实际 tap 模型按钮后 AX 显示 favorite/recent/provider 行；实际 650ms 长按 Agent 按钮后显示 build、plan 和长名 primary Agent，全部 enabled。只操作合成内存目录和本地草稿，没有模型请求。
- 同包聚焦真实输入框后，截图显示输入框与系统键盘之间有清晰间距。该包之后另一线程继续修改搜索组件和目录缓存，需在接续包中再验这些后续改动。
- `native-chrome-uikit` 最终包 `example.nsh.chrome.qa-1794065889146`：真实坐标来自当次 AX 的 Tasks 按钮 frame。tap 后 AX 出现 `composer-task-qa-task:0`；关闭/重开仍显示任务行，结束前控制台无对应 JS 异常。载体包含生产 `NativeComposerChrome`、`NativeComposerTasks`、材质和原生键盘避让。
- 主模拟器整包曾成功构建、安装并启动；新连接空状态下的 Tab 为系统浮动胶囊，未出现独立矩形实色底栏。主包构建发生在最终 Tasks 高度参数改动之前。最后重建被同时接入的 `stage-native-application.mjs` 路径检查拦住：命中十语 `/Users/you/...` placeholder，以及压缩 JavaScript 的 `t:/` 三元表达式（后者被当作 Windows drive）。没有删除检查、改写无关 locale 或绕过门禁。无真实已连接四 Tab 全内容的视觉签收。

本地截图/控制台记录在本机工具临时目录，未作为仓库资产提交。独立载体不等于真实 Host 端到端验收。Changes 实际生产入口有 headless 打开验证，未单独完成其真实 UIKit 触摸闭环。

## 验证入口与限制

```sh
bunx --no-install vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/transcript-actions.test.ts packages/nsh/transcript-actions-state.test.ts \
  packages/nsh/new-session-ui.test.ts packages/nsh/new-session-selection.test.ts \
  packages/nsh/chat-chrome.test.ts packages/nsh/chat-chrome-wiring.test.ts

NSH_BIN=/path/to/nsh/bin/nsh bunx --no-install vitest run \
  --config packages/nsh/vitest.config.ts packages/nsh/goal-tasks-chat.test.ts \
  -t 'own production triggers'

bunx --no-install tsc --noEmit --project packages/nsh/tsconfig.json --pretty false
NSH_BIN=/path/to/nsh/bin/nsh node packages/nsh/scripts/build-ios.mjs
```

聚焦的五文件批次曾 62/62 通过；后续复验期间另一个线程引入目录缓存及共享 Sheet search，VM port 与旧 search 元素断言已随真实依赖更新，未替换生产逻辑。最终七文件（上述六文件加 `chat-tasks-model.test.ts`）**91/91 通过**，类型检查再次通过。Tasks/Changes 新增生产入口 headless 测试单独通过。

`goal-tasks-chat.test.ts` 整文件基线曾有 8 失败（Goal row/配置/发送等），本轮没有通过删测试或放宽 Goal 断言消除；新测试单独验证 Tasks 与 Changes 的真实生产触发器和互斥打开。`bun run dead-code` 已运行，仍有现存 unused/duplicate 报告，其脚本使用 `--no-exit-code`，退出 0 不表示报告为空。

尚未完成物理设备、真实 Host fork 写入、全部已连接页面的材质视觉对照、50 次输入事件性能采样及全工作区回归；本轮不改变原有完整 parity 的未签收状态。
