# Composer 队列与状态区对齐

日期：2026-11-08。只记录本轮实现与实际验证，不代表全应用 1:1 验收。

## Web 基准与本轮修改

- 当前 `ChatInput.tsx`：`MemoStatusRow` 在 `QueuedMessageChips` 之前，Goal 通过 `trailing` 放在 queue shell 内。`QueuedMessageChips.tsx` 的手机底卡为 20px 圆角；浅色半透明边框，暗色使用 background/foreground 4% 混色。原生 iOS composer 分支不使用 Web/Android 的负 margin 和 overlap spacer。
- 已读取当前运行 Web 手机入口的实际 DOM，确认 `px-2`、20px 圆角、暗色透明边框和 body inset。该次浏览器窗口不是 402px 同尺寸基准，不能用来宣称像素对帧通过。
- 原生改为 Changes/Tasks → queue/Goal 共用底卡 → 单一玻璃 editor。queue-only、Goal-only、两者都有、只有错误、完全空集合分别处理；仅两者都有时显示 divider。
- inbox 使用单行预览（多行追加 `...`），左侧删除、右侧图标与 edit/steer 标签；steer 保留到权威消费并显示动画，后台/减弱动画停止旋转。删除仍在 steer 状态可见。原生 inbox 不支持排序，与 Web inbox 的禁用拖柄一致，未新增排序协议。
- 去除独立 queue 标题、多行消息卡片与继承选择副标题。附件仍显示数量；没有改写原始 payload、编辑恢复、取消确认、发送或 Goal 命令协议。Web inline reference chip 装饰尚未移植，不能把当前纯文本预览冒称完整引用装饰。
- Goal 文字单行左对齐，状态/rounds/操作不收缩；目标图标按同一 Host 主题的 active info / paused muted / complete success 着色。详情仍使用原生系统 Sheet。

## 已通过

| 检查 | 结果与证据 |
| --- | --- |
| Queue/Goal/Tasks 定向回归 | 6 文件 / 120 passed；`.scratch/nsh/queue-parity-delivery-tests.log` |
| Changes 回归 | 31 passed / 1 skipped；`.scratch/nsh/queue-parity-changes-tests.log`；skip 为未开启的 UIKit driver |
| 最终展示回归（补主题热切换） | 4 passed；`.scratch/nsh/queue-parity-theme-tests.log` |
| Web closed-picker 操作量守卫 | 4 passed；`.scratch/nsh/queue-parity-closed-pickers.log`；保留既有 act/Vite 配置警告 |
| Native type check | `.scratch/nsh/queue-parity-check-final.log` 通过 |
| 完整 arm64 模拟器构建/安装 | `.scratch/nsh/queue-parity-build-delivery.log` 成功；已覆盖安装原用户模拟器并启动，未重新配对 |
| 产物对应源码 | 已核对 application、chat-queue、chat-goal、chat-tasks、chat-changes 的包内 source map 与当前源码一致 |
| dead-code | 已运行并检查 `.scratch/nsh/queue-parity-dead-code.log`；保留既有 fixture/Goal 导出报告，未删除并行工作 |

布局回归直接挂生产 `NativeChatQueue` / `NativeGoalRow`，覆盖 320/375/402pt、三项总高不超过 160pt、主题切换、50 次无关草稿修改、单行预览、Steering/移除操作、空壳与 divider 消失。AST 回归检查生产 App 的区域顺序及 Goal 确实由 queue 的 trailing 所有。生产 App 引擎回归保留编辑失败恢复、steer、删除重试、Goal 原生命令与零选择写入断言。

此前 Goal/Tasks 8 项红灯来自严格 fixture 未同步原生 runtime scope、新增只读 diagnostics/history-import 启动入口，以及 root state/带 scope 的 GET 预期。本轮补精确 fixture 响应和断言，不改生产安全门、不 skip；该文件最终 22 项全部通过，新增 fixture 合同拒绝错误 scope、diagnostics 参数和 import 写入。

## 真实 UIKit

- 完整 App + 原有真实 Host，未发模型/语音请求、未改 Goal、模型或收藏。
- 真实已有 Goal：Changes 在其上，Goal 在共用底卡内，长目标截断且 Active/rounds/Pause 完整；打开详情正常，未执行写动作。截图 `.scratch/nsh/queue-parity-goal-final.png`。
- 真实 Tasks 与 Changes 均可展开，打开 Changes 后 Tasks 浮层关闭；截图 `queue-parity-tasks-final.png`、`queue-parity-changes-final.png`。
- 深色回到最新位置后，Changes/Tasks 与 Goal 底卡均可见且可读；截图 `queue-parity-goal-dark-final.png`。离底阅读时附属区按既有 dock 规则隐藏，向最新端滚动后恢复；早期 dark/reopen 截图处于离底状态，不作为底卡颜色验收图。收尾恢复原浅色系统外观。
- 一个最终构建因并行修改 `PasskeyBridge.swift` 失败，未覆盖该工作；重试后的完整包成功。未提交、未推送、未新增依赖。

## 尚未证明

- 真实 Host 当前没有可供无副作用验证的待发 inbox；未人为发送/注入队列。因此真实多项 queue + Goal 同屏及实际网络失败/杀进程恢复尚未验收，不能用合成引擎代替。
- 全语言极长标签、真实软键盘/中文 IME、50 次真实输入时延、同尺寸 Web/UIKit 逐像素对帧未完成。
- 本轮不关闭历史滚动、全应用能力及其它模块已记录的验收缺口。
