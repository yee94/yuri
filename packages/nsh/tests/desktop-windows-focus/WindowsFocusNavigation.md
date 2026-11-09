# Windows generic keyboard focus — handoff

## 状态与边界

本专项交付的是 **待集成、待运行验收的源码补丁**，不是完整 Mac/Windows 签收。

**集成冻结**：封装检查发现 `list-scroll-snapshot.patch` 也触及 `crates/nsh-platform-windows/src/mount.rs`、`crates/nsh-testing/src/headless/mod.rs`、`crates/nsh-testing/src/screen.rs`。本候选只针对 e626 基线出 patch/hash，未重基或覆盖 List worker，未在当前 ordered patch chain 上验证。main 必须先协调这些共享文件的顺序与链式 before/after hash，不能直接登记候选 hash。

- 基线：NSH 0.4.0，用户指定 revision `e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3`。
- 上游只在 ignored `.nsh/compat-win-focus-work/copy` 修改；外部 checkout 只读。
- 交付：`packages/nsh/patches/nsh-0.4.0/windows-focus-navigation.patch` 与同目录 `windows-focus-navigation.hashes.json`。
- 未改 manifest、preparer、已登记工具/运行时、application/state、designer fixture/test、core/List、JS ListRef 或 native SSH。
- 没有新增公开 API 或修改生成类型。生产代码未安装任何 TS 全局 keymap，没有卡片专用判断。
- 当前 preparation 只收录既定 source roots；补丁只涉及 `crates/`，不要求修改复制根。行为合同写在 Windows 输入模块注释与本交接记录中。

## 原因与实现

基线 `nsh-testing/src/headless/keyboard.rs::tabs_to_views` 只有 macOS/Web；Win32 `input::tab` 只收集 Input。
因此原生 Button 和 `View role="button" onPress` 都没有普通键盘焦点/激活路径。

补丁沿用 `ViewProps::focus_stop` 和现有 `text_input::FOCUS`，没有新增第二个键盘焦点状态：

1. `owner` 返回唯一的 field-or-view owner；原 `focused` 只投影 Input，保留编辑、caret、IME 和 keymap editing 判断。
2. Tab/Shift+Tab 按树序循环普通 pressable View、显式 focusable View 与 Input，并限制在最新 modal。
3. disabled、hidden、concealed、移除动画、pointerEvents none、AX hidden 及其祖先撤销准入；`accessible={false}` 排除该节点，`focusable={false}` 显式退出。
4. 程序 Focus/Blur、UIA SetFocus/keyboard-focusable、鼠标聚焦、modal 暂停/恢复共享同一 owner。
5. 窗口快捷键与系统 dialog 保持优先；普通路径为 keymap → native menu → Input → generic activation。IME composition 期间编辑键优先于应用 accelerator。
6. generic Enter/Space 首次 key-down 只发送一组 PressDown/PressUp/Press；repeat 被消费，key-up 不再次激活。Space 在滚动前消费，并清掉对应 queued char。
7. Input 的 Return/submit 行为仍走原 `text_input::key`；composition Return 不提交。非活动窗口保留 owner，但暂停 generic traversal/activation。
8. batch end 复验准入；detach/delete、stop/destroy 释放 stale owner。非 owner Blur 不得清掉当前 owner。headless 也清理删除节点的 key focus，防止 ID 复用复活旧焦点。

这里的 AX focus 仍是原有辅助技术语义，不作为键盘激活 owner。没有移除现有系统 gate。

## 验证记录

| 层级 | 本轮结果 |
| --- | --- |
| 原最小 Windows headless 红测 | 已运行且失败：唯一 Button 经 Tab/Enter 后为 `calls:0`，期望 `calls:1`；340ms，进程总计 351ms |
| 红测工具 | 配套 digest `7834beffee6dc6dd588bee99f717366a37dca2282ceb53544b80734e800f97e0` CLI/runtime；没有指定 native target |
| 修改后 Rust 源码解析/格式 | 13 个 Rust 文件的 stable rustfmt 与 `--check` exit 0；nightly-only 配置提示不构成 nightly fmt 或 type-check 通过 |
| Windows 真实 target check 尝试 | `cargo check -p nsh-platform-windows --target x86_64-pc-windows-msvc --no-default-features --offline --locked` exit 101：缓存缺 `gl_generator v0.14.0`，offline 拒绝下载 |
| 工具链事实 | 本次 stable 的 installed target 只有 `aarch64-apple-darwin`；没有安装 Windows target、SDK/link 工具或依赖 |
| 修改后 headless / Rust 单元测试 | **未运行**：副本 AGENTS 的并行 worker 限制要求由 main 串行构建/测试 |
| Windows native 单元测试 / 真实窗口 / 物理键盘 / UIA / IME 实机 | **未验证**；Mac 上不能以空 Windows crate、Darwin metadata 或 headless 结果代替 |
| 补丁 zero-fuzz apply / 完整 SHA roundtrip | 见 `windows-focus-navigation.verification.json`；这是补丁完整性检查，不是运行时验收 |

原 AppKit 五项物理正向、新旧 digest 与旧 binary 红反例不变，本补丁不以它们为 Windows 背书。

## 待 main 串行执行

保留 existing Cargo.lock、`--offline --locked` 与系统准入；缺缓存/target 时报告阻断，不移除约束。

1. 先解决上述三个共享文件 seam；再核对 hashfile 中每个 beforeExists/beforeSha256，协调既有 patch 链，并重新计算链式 hash 与工具 digest。本 worker 未重基、未登记 manifest。
2. 执行 `cargo test -p nsh-testing --lib --offline --locked`：新增 Windows generic traversal/activation/lifecycle 与 Screen AX/modal gates 回归。
3. 在同补丁 CLI/runtime 上执行 `nsh test tests/desktop-windows-focus`（包目录下）：原最小红测和新增 Contracts，均为 Windows **headless**。
4. Windows 环境执行 `cargo test -p nsh-platform-windows --offline --locked`，包含 `input::focus_tests`、`text_input::tests::windows_*`、`chrome::focus_tests`；这些源码单元测试不打开窗口，不是物理输入。
5. Windows 实际窗口另验 key-down/up/repeat、Space 不滚动、Input Return、IME 候选、前后台/多窗口、modal restore、UIA 与动态 disabled/hidden/delete；核对真实系统输入路径，不把 native agent 合成输入直接称为物理键盘。
6. 最后由 designer/main 保持原 `Cards.test.tsx` 正向场景和断言不变，完成 Windows 验证后再解除原 skip；本 worker 没改该文件，也未运行真实 Host。

## 冻结 seam：显式 tabIndex

e626 的 Rust/core/JS 没有 `tabIndex` / `tab_index`，现有合同只有 `focusable` 和树序。**本补丁未实现显式 tabIndex 排序，不能把树序循环算作该项通过。**

需要 main 决定并分配的 seam：`ViewProps`/`Prop` 与 JS 属性绑定、生成声明、共享排序合同（正值顺序、0 的稳定树序、负值是否仅禁止 Tab 而保留 programmatic focus、同值 tie-break），以及各平台/headless 的消费。这里会越过 core/JS 与当前并行工作边界，因此先冻结，未写替代 API、未碰 List/JS ListRef、未覆盖其他 worker。
