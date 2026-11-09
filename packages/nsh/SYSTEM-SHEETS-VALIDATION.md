# 系统 Sheet 与滚动 Chrome 验证

2026-11-07。本轮补齐系统半浮层呈现和 Chat Header/Composer 的滚动联动，不将其它未迁移能力删出验收范围。

## 实现边界

- `NativeSheet` 的 iOS 路径是真正 UIKit pageSheet，系统负责 detents、grabber、拖动、背景和滚动交接。旧手绘抓手与 Diff resize responder 只留在非 iOS fallback。
- 模型/Agent、新会话、Goal、Diff、项目操作、Provider/Skill 编辑、MCP/历史导入与 onboarding README 直接使用该 owner。系统 Select 使用同一呈现，计划单日期使用 `UIDatePicker.inline`。
- 每代实际 controller 的 completion 才能释放 root；取消/关闭中的重开排队，不用 timer 伪造关闭。pending 的关闭保护在 UIKit 执行。新会话的原业务 intent/generation fence 保留。
- Chrome 共用 Web 纯规则，Header 和两态 Composer 的显示只改 transform/opacity，倒序 List 仍是唯一滚动 writer；List header 保留 expanded 占位。最新动作定位反序后的第 0 行，不用 `scrollToEnd` 或额外占位补偿。
- 锚定的 `@`/`/`、Tasks/Changes summary 仍为原生 Overlay；没有冒称已经改成系统 Menu/Popover。选择器键盘规则已接入，真实外接键盘仍需设备验收。

## 本次已取得的证据

最终专用设备为 `85080B56-11C0-445C-BF0C-55590104E8BF`，iOS 26.5 / 402×874pt；未操作用户主模拟器。原隔离设备出现并行 App 切换，受干扰的取样不计验收，最终四组回归均已在新设备重跑。实际 QA manifest 见 `.scratch/nsh/system-sheet-final-manifest.json`。独立 Chrome QA 无 Host/网络/Keychain/模型/语音能力，500 行仅为合成文本，直接复用生产呈现与 Chrome 模块。

- 实际 presentation class 为 `_UIPageSheetPresentationController`，不是窗口内 View 面板；三个 custom detents、系统 grabber、42%→72% 的真实触摸拖动均可观察。
- 锁定时 `isModalInPresentation=true`，下拖不能 dismiss；程序关闭后等待实际 controller 消失，再重开成功。新会话生产 modal adapter 的独立载体也实际关闭/重开成功。
- 上翻后 Header alpha=0、translation=-86pt；返回最新后恢复 1/0。点击 compact 仍编辑 `Retained draft`；不是另建 Input 或复制编辑文本。
- 返回最新已读取真实第 0 行的 AX 几何，并确认其底部位于 expanded editor 上方；早先 `scrollToEnd` 到旧端的截图作废，不充当成功证据。
- Select 实际输入 `12` 后过滤到 Choice 12/112/120 等，选择 Choice 12 后系统容器关闭；系统日历选 11 月 8 日后关闭。已查看 `native-select-search.png` 与 `native-date-selection-result.png`，后者实际显示 `Select 12` 和 `2026-11-08`；不是只由日历截图推出提交成功。完整 AX/controller 结果在 `.scratch/nsh/native-select-uikit-evidence-final.json`。英文串输入曾进入系统拼音 composing 候选，不能算英文或中文 IME 完整验收。
- 定向 Vitest **13 files / 76 passed**，覆盖 Sheet generation/completion、生产 modal/Page callbacks、真实 Input AX 合同、键盘核心/Select 接线、Chrome/最新按钮、历史意图及发送：最终结果记录于 `.scratch/nsh/native-system-focused-final.log`。这些不是 UIKit 手势测试。最终完整 `ios:build` **成功**，产物 `.nsh/out/YuriNative.app`，未将 QA 安装冒称生产包安装；dead-code 已执行并检查，旧专用 presentation export 已移除，其它 CLI fixture 等报告保留。

## 明确保留的红灯和未验项

- `new-session-native.test.ts` 最终 **4 passed / 4 failed**；headless iOS 没有执行注册的 UIKit nativeComponent completion，不能替生产伪造 `onOpen/onClose`，也没有删除或 skip 原来的失败场景。输出见 `.scratch/nsh/native-system-headless-final.log`。
- 额外编译的完整新会话 UIKit carrier 在专用设备复验仍在打开模型 Sheet 前呈选择器禁用，未取得实际模型目录/搜索的系统 Sheet 证据；前置禁用原因未定位，不据此推断系统 Sheet 的故障位置。本轮不把通用 modal QA 或 VM 回归冒充生产页面完整成功；最终现场保留在 `.scratch/nsh/native-production-new-system-uikit-evidence-final.json`、`new-session-system-modal-private-ax.json` 和 `chat-frames/new-session-system-modal-private.png`。旧设备受并行切 App 干扰的样本不用于该结论。
- `nsh:check` 当前被共享 Relay `tunnel-client.ts:65/124` 的 BufferSource 类型错误阻断，不声称整包类型检查通过。完整生产构建与 dead-code 输出分别见 `.scratch/nsh/native-sheet-ios-build-final.log`、`.scratch/nsh/native-chrome-dead-code-final.log`。
- 真实 Host/Relay、软键盘/中文 IME、外接键盘设备行为、50 次输入处理/下一帧预算、真机和全应用 1:1 对帧未完成。先前真实历史 53pt 跳动没有因此关闭；本轮未新增 offset 补偿，也不以合成 500 行替代真实历史采用验证。

所有 QA 写入只在独立沙箱或 synthetic 内存；未发起付费模型/语音调用、真实 session 创建或真实配置变更。
