# NSH Native 阶段交接（2026-11-07）

> **这是实验性阶段检查点，不是完整可发布版本，也不是功能、视觉或设备交互 1:1 签收。**
> 本次按用户要求整理当前全部 changes 并提交；另一个线程继续实施。本 fork 只做交接和提交，不管理、冻结或等待其他线程。提交边界以 Git commit 中的文件为准，提交后工作区可能继续产生修改。

## 原始需求与验收边界

原始目标按前序会话整理如下（这是需求归纳，不冒充逐字原文）：用 NSH Native 开发完整 Yuri 原生客户端，参考 Noop 的跨端组织方式，优先 iOS，完整还原当前 Web 手机端的能力、交互和样式。四个主入口、所有二级页面、弹层、状态变化、异常处理及恢复行为均在范围内，优先级不等于删减范围。

- Chat、输入框、Changes、Projects、Bots、定时任务及全部设置逐区对照真实 Web 手机端。保留真实模型 Logo、Agent 标记；普通 Chat 不自行增加 Web 没有的 Yuri 消息头像或署名。
- 主界面使用 Native，不能用主 WebView 冒充；导航、返回、表单和半浮层优先系统原生能力，Tab 与输入区域采用 Liquid Glass。终端及插件允许独立、窄职责的 Web 容器。
- 历史加载保持阅读位置，不接受已知跳动；首页拖拽需要真实手势对照。能运行、能构建、fixture 通过或局部测试绿均不等于完成还原。
- 保留真实功能与失败恢复，不按 MVP 裁剪，不自行设计替代入口后声称相同。性能提升保持无损。
- 实施与独立复审曾采用多层 Agent；测试、复审和设备验收必须分别记账。

最新功能反馈原文：

> 得注意看首页里面的拖拽那些能力，感觉现在都有点问题。

本次交付请求原文：

> 我想让你把当前的所有 changes 做个 HANDOFF 的阶段性总结，整理提交一下声明我的原始需求，诚实的说明，目前做了哪些没做哪些

后续纠正原文：

> 你无需管哪些 Subagent ，另外一个线程还在处理，目前你只是我的 fork

本阶段没有授权新增付费模型或语音调用、真实凭据删除、有损 Host 配置、服务端 Git 写入或发布。交接本身不执行这些动作。

## 本次 changes 的完整范围

首次暂存快照为 **1067 个文件，98125 行新增、1338 行删除**，其中 `packages/nsh` 整体此前未跟踪；这不是 1067 个文件都已逐项验收的声明。新增本 HANDOFF 后，以 commit 统计为最终数量。

| 范围 | 首次暂存文件数 | 内容与责任 |
| --- | ---: | --- |
| `packages/nsh` | 924 | Native TSX/signals 页面、Swift 认证/传输/资源桥、构建脚本、资产、纯测试/headless/UIKit 载体及专项验证文档 |
| `packages/ui` | 108 | 可共享纯逻辑与类型抽取，消息/Activity/工具/时间/头像/Provider/搜索/retention/queue 等逻辑及回归，十语文案；部分 Web 消费者随之调整 |
| `packages/web` | 32 | GitHub 授权生命周期、通知 admission/runtime、preview proxy、Relay tunnel、OpenCode settings、定时任务及对应测试/文档 |
| 根目录 | 3 | `AGENTS.md` 的 NSH 所属边界、`knip.json` 的扫描范围、`vitest.config.ts` 的项目配置 |

完整文件清单可对本检查点 commit 运行 `git show --format= --name-status <commit>` 获取。源码、测试、文档与必要原始字体/图形资产包含在检查点中；忽略的 `.nsh/`、`target/`、`.scratch` 本地证据、模拟器 sandbox、录屏与构建输出不包含在提交中。本地证据路径仅用于已有环境接续，其他机器需重新生成。

## 当前实现与未完成范围

“已实现”表示代码存在及相关局部验证，不表示设备行为或完整 parity 通过。各专项文档也可能早于最新修改；判断当前行为必须核对提交源码与重跑结果。

| 能力 | 已落盘的实现 | 尚未完成或未验收 |
| --- | --- | --- |
| Native 架构与连接 | TSX/signals 渲染 UIKit；Swift 持有凭据、网络与 Relay；四 Tab、系统导航/Sheet、Host scope/lease、固定 sender 与前后台 admission | 全量返回、键盘、前后台及跨页视觉/交互逐帧对照；当前最终整包尚未重建 |
| Chat 与历史 | 消息/Activity/工具投影、分页/gap、唯一倒序 List writer、搜索定位、模型/Agent picker、Goal/queue/Tasks、朗读入口 | **真实生产历史 53pt 跳动仍未修复或签收**；自然高度/持指 release/晚到内容证据不足；超高 grouped row 精确定位、跨 part 连选等仍有差异 |
| 输入与新会话 | 独立草稿、稳定 inputID、首次创建 receipt、handoff、unknown journal、同 Host operation lane 恢复；新会话首次 run/后续 reconcile 接线 | unknown create 不二次创建，缺 request ID 的情形仍待用户核验；完整 slash 本地命令清单及所有真实触摸/键盘路径未完成 |
| 首页快捷项拖拽 | 合法 UIKit 合成 admission 已补；长标签、换行、裁切/取消/几何等回归文件已落盘 | 历史交付曾 1 绿/4 红；本 fork 最新该文件通过不代表 UIKit 已通过。新 baseline 尚未完成构建及手势验收 |
| Projects/工作树 | 目录、会话、搜索、置顶、归档/Undo、工作树生命周期及失败恢复；已有实测 header 几何代替固定 56pt 的修复和代际/click suppression 保护 | 首页会话长按拖排及入口对齐正在另一线程变化；旧排序 Sheet/额外 up/down 等差异记录见专项文档。**本 fork 最新 Projects 测试仍红**，不能使用早先 69/69 作为当前完成证明 |
| Changes/源码 | workspace/历史工具共享 diff Sheet、文件切换、源码行跳转、历史快照与当前 Git 隔离 | 超长 hunk 的精确行落点存在已知差异；真实 UIKit 与写动作未整体验收 |
| Bots/计划/设置 | 列表、编辑、渠道、历史/恢复；Basics/Voice/Models/Context/Quota/Navigation/通知/GitHub/Git credentials/About 等已有大量真实页面与 controller | 全部页面、二级入口、异常/恢复及视觉逐项验收未完成；真实 OAuth、凭据删除、模型下载等有副作用流程未验收 |
| Tour/历史导入 | 模型→扩展工具→历史导入→语音；手机显式入口/原命令重开，后台 jobs 与前台 job 单 owner/缓存/轮询 | 真正历史导入未运行；source-start 回复完全丢失仍 unknown，不猜最新 job、不自动重发 |
| 终端 | 17 capabilities、认证 Runtime、严格 stream/stop scope、生产 bootstrap 与生命周期、Ghostty 资产；曾关闭额外拖排和跨 Tab 队列问题 | 真实 Host PTY/shell、设备键盘与全部生命周期未验收；局部 mux 测试不代表端到端终端可用 |
| GUI 插件/文件预览 | emitted bundle/SDK/FilesAPI/Storage/分块读取；独立认证 Relay reader lane，已修 shared mux 阻塞和部分字节丢失；Native context/factory 已有代码和测试 | context factory 在检查时只见定义及测试引用，尚不能认定生产文件入口闭环；copy/save/openExternal/toast/导出、外部依赖、Host/Relay asset resolver、真实 Eficy/第三方插件与设备内存未完成或未验收 |
| 原生资源/预览/远程桌面 | 资源读取与 loopback HTML 的构造期 scope、精确 owner close/cancel；远程桌面 JPEG 解码后 ACK/恢复等 | 真正设备/真实 Host、长时间流与大媒体未完整验收；NativeWebRTC 未完成 |
| 语音/ASR | 播放与听写生命周期、同 owner、Task 取消传播、finish 越过 start 的缺陷修复 | Host revision/CAS、streaming-ready echo、付费上游物理取消、临时文件物理回收仍有缺口；逐词高亮、常亮、实际合成/听音未完成或未验收 |
| 授权退休/通知 | Store 原子 retirement journal；Runtime 读取 pending→await cleanup→精确 ACK；启动与 resume 重试。通知同文件 tombstone 保留 receipt IDs，等在途 add 和 OS 两份回读后 ACK | 真实 OS 通知物理删除未验收；APNs 的身份/签名/Push origin/token transport/payload Host 授权绑定未闭环；SSE 不替代挂起交付 |
| 清理/更新/发布 | 部分 Host 更新、诊断与保守恢复实现；能力缺失时 fail-closed | 上游清理缺原子资格检查与持久 operation receipt；可信 OTA、安装恢复、TestFlight、系统扩展及发布验收未完成 |

## 本 fork 本次实际检查（提交准备期间）

另一个线程继续写入，因此下面是运行时工作区观察，**不是对最终 commit 全部内容的全绿背书**；最终提交仍应按相同命令复验。失败原样保留，本 fork 未为阶段提交修改功能或放宽测试。

| 检查 | 结果 | 解释 |
| --- | --- | --- |
| `bunx --no-install tsc --noEmit --project packages/nsh/tsconfig.json --pretty false` | 通过 | NSH TS 类型闭包；不验证 Swift/UIKit 运行 |
| `git diff --check` | 通过 | 当时未暂存差异的空白检查；另对暂存快照执行检查 |
| `git diff --cached --check` | **失败，10 处空白问题** | 涉及 `agent-avatar-runtime.generated.js` 的 EOF 空行、原始字体 `OFL.txt`、`gui-plugin-native.test.ts` 和 `settings-usage-quota.ts` 的尾随空白；阶段交接保留原始资产和已有实现，未为提交改写 |
| `bunx --no-install vitest run --config packages/nsh/gui-plugin-context.vitest.config.mts` | 2 文件、39/39 通过 | GUI context 合同测试，不证明生产入口已调用 |
| 下方五文件专项命令 | 3 文件通过、2 文件失败；34 通过、62 失败 | 新会话拖拽和两份通知测试通过；Projects 53 项被 VM loader 缺 `./projects-order-touch` 挡住；手势文件 9 通过/9 失败，含函数抽取失效、树遍历错误及首页额外入口断言失败 |

```sh
bunx --no-install vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/new-session-starters-drag.test.ts \
  packages/nsh/projects.test.ts \
  packages/nsh/projects-order-gesture.test.ts \
  packages/nsh/notification-retirement-native.test.ts \
  packages/nsh/notification-swift.test.ts
```

提交准备期间对候选文件做了常见私钥/GitHub token/AWS access key 模式检查，没有匹配；机器路径匹配位于原有 locale 示例和路径解析规则，未借交接改写无关内容。此模式检查不等于完整安全审计。没有大于 2 MB 的单个候选文件。

本 fork **未重跑**全工作区测试、完整 NSH headless/engine、最终 Swift 整包构建、模拟器手势、真实 Host 副作用流程或发布。未执行 push。

暂存后已观察到另一线程继续修改 appearance/context、新会话和 Projects 的源码/测试，并新增 Projects touch 测试。这些晚到内容按工作区保留，不再次整树暂存；最终有哪些晚到修改，以提交后的 `git status --short` 为准。上表测试读取工作区而非隔离 checkout，所以不得声明最终暂存快照通过同样测试。

## 历史验证证据及其限制

以下批次来自前序会话与专项文档，时间/源码版本不同，**不可相加，不构成当前全包全绿**：

- Settings 公共消费者同轮 9 文件 153/153，含 11 个 Voice engine 场景；仍为 headless actualApp + strict fake。更早 Voice 空白页 explicit JSX 属性修复另有单例证据。
- GUI 修复主复跑 137/137；direct/E2EE mux 曾完整读 33.0625 MiB；browser 14 项、Relay policy/terminal loopback 16 项含 1 MiB 生产 mux。测试传输不等于真实第三方插件验收。
- 共享原生桥曾 7 文件 238/238，发生在后续 durable/context 修改之前；远程桌面显式前台后曾 56/56。
- 通知退休及 SDK 主批次 15/15；另有 worker 28 项事务/子进程/fake OS 证据。真实 OS 删除仍待验收。
- Projects 专项文档曾记录 69/69 和 tsc 通过；本 fork 最新运行已出现上述 62 个 Projects 失败，旧记录只保留历史意义。
- 新会话 UIKit admission 曾有 31 项纯测试和依赖闭包通过；旧 UIKit baseline 的 Add/Agent/Model/项目/send 全部禁用，不能用旧包证明拖拽成功。
- 曾构建签名模拟器整包并核 Ghostty 资产 SHA/size 与 codesign；后续新接线未最终重建。
- build6 合成原生窗口 ON 三轮 commit 漂移 0pt、release 0.000244140625pt，OFF 35.999755859375pt；录像存在缺口，没有完整视频验收，更不能据此关闭生产 53pt 问题。
- IOSurface 采集器 16 项离线测试；8 秒 live smoke 曾 481 fresh reads/encoded/decoded、0 drops、最大 PTS gap 24.570229ms；缺 native clock 同步及生产几何 verdict。
- 曾执行离线 Knip 5.80.0，unused/duplicate/未接入口报告仍存在，没有通过删除代码或隐藏报告消除。

## 接续入口与顺序

1. 先用 commit 获取文件清单并阅读提交后的工作区差异，区分检查点和另一线程后续修改；接续者自行协调正在进行的实现。
2. 优先处理用户最新首页拖拽反馈：逐项对照真实 Web 入口、激活延迟、跨行几何、滚动竞争、拖后误触、Sheet/多指/后台取消和顺序持久化。修复测试 loader/旧函数抽取后，使用合法 admission 的新 UIKit 包验收；保留真实红灯。
3. 复现并关闭生产历史 53pt 跳动，补齐连续 native clock/自然高度/持指 release/晚到内容证据。List 继续为唯一滚动 writer，保留 `onLoadMoreAtStart`；历史 footer 实验默认关闭。
4. 核对 GUI context 在真实文件入口的捕获/注入/清理，再测试真实 Eficy/第三方插件与系统动作。保持独立认证 reader lane 和精确 scope。
5. 重新运行当前源码的类型/聚焦回归/原生桥与最终签名模拟器构建；按页面完成全部 UIKit 导航、键盘、前后台及视觉对照。每项分别记录代码实现、headless、UIKit、真实 Host 和发布证据。
6. 完成剩余 APNs/语音/更新/安装等合同与授权条件后再验收；只有原始范围逐项通过才可宣称完整还原。

主要索引：`README.md`（构建）、`DOCUMENTATION.md`（模块/不变量）、`PARITY.md`（早期范围，需与最新代码核对）、`projects-order-VALIDATION.md`、`NEW-SESSION-VALIDATION.md`、`tests/new-session-uikit/README.md`、`GUI-PLUGIN-CONTRACT.md`、`TERMINAL-RUNTIME-VALIDATION.md`、`AUTHORIZATION-RETIREMENT.md`、`NOTIFICATION-RETIREMENT.md`、`tests/settings-voice-production-contract.md`、`HISTORY-VIDEO-VALIDATION.md`。

本地未提交证据可能仍在 `.scratch/nsh/home-drag-baseline-*`、`.scratch/nsh/build6-observation-audit-*`、`.scratch/nsh/record-source-*` 和 `.scratch/nsh/record-live-smoke-*`。这些记录不随本提交分发，也不能替代当前源码重验。
