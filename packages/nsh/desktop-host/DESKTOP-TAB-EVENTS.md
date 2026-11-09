# 桌面 tab 原生事件：独立 Host 接线合同

实现文件为 `src/desktop_tab.rs`、`desktop_tab_macos.rs`、`desktop_tab_windows.rs`；独立入口为 `examples/desktop_tab_contract.rs`。没有修改 Host main、bridge、native_ui、host_services、Cargo、application 或 panel 入口。已有 README 的网络、凭据、文件 journal、系统关闭与平台未验边界不变。

## Host owner 的确切接口

```rust
// 创建 AppView 前；两平台均为 Result<Registration>。
let tabs = desktop_tab::register(&components)?;
// clone 给既有 committed-authority publisher；不要再读 Vault 或信 JS scope。
tabs.set_scope(committed_scope.as_ref())?;

// macOS：已有真实 NSWindow 与 AppView（UI 主线程）。
let observer = desktop_tab::install_observer(&tabs, &window, &view.view(), mtm)?;
// Windows：hwnd 为现有 AppView HWND 的 *mut c_void，不创建子 HWND。
let observer = desktop_tab::install_observer(&tabs, hwnd)?;
// Windows 原有 window_proc 中调用，保留其原来的 DefSubclassProc 分发。
desktop_tab::observe_window_message(hwnd, msg, wparam, lparam);

// 既有 UI loop：真实窗口前台态与实际 native dialog/picker/save/modal 遮挡。
observer.poll(actual_foreground, native_modal_blocked);

// 每次 Host/lease 退役必须先同步失效（含连接切换、撤权、shutdown）。
tabs.set_scope(None)?;
// UI teardown，在 view.stop()/窗口销毁之前；retire/drop 幂等。
observer.retire();
drop(observer);
```

`Registration` 与 terminal 相同，只接 native 已提交的 exact `{hostID,lease}`；相同 scope 不退役，换 scope/None 清除 hit entries、pressed、focus 并轮 epoch。旧组件的迟到 props 即使遇到同 scope ABA 也不能重新注册，需新 scope 下的新组件。注册不安装任何 HostChannel 方法或 JS close command。Observer 每个 registration/window 只允许一个；Mac Drop 移除 local monitor，Windows Drop 只撤自己的 map，不安装/移除额外 subclass。

真实 host_services publication 测试可调用 `Registration::current_scope(&self) -> Option<Value>`；该方法仅 `#[cfg(test)] pub(crate)`，返回现有 scope 的 clone，不增加第二份 authority、生产接口或 JS API。可用于核验 publish/metadata-only/retire/shutdown 的 scope 是否保持或清空；它不代表 observer 几何/物理 UI 状态。锁中毒直接令测试失败，不伪装成已撤权的 None。

## 零命中面积，不是透明 overlay

- component 名为 `yuri.desktop.tab-events`；仅 `binding` prop，事件为 `middleClose/tabFocus/tabBlur`。无 command handler。Mac 自定义 NSView 强制 `setFrame/setFrameSize` 为 **0×0**，不改变 first responder；Windows 不实现 `window()`，使用 NSH 默认 None，不产生 HWND。
- TS `desktop-panel-tabs-events.tsx` 以 `style.pointerEvents='none'`、width/height=0、absolute 挂载该组件。只有实际 tab target 被测量；close 按钮/rail 不注册。native logical hit 不依靠 `hitTest:nil`，不能改成覆盖 tab 的可见 native view。
- strip 在 layout、scroll、membership、拖排结束后收集 target page rect，裁剪到 Scroll viewport。先失效旧 revision，再最多两条并发 measure；手势移动不重复测量 native hit map，左键拖排期间不重新注册。此 metadata 不存 Storage、不请求网络，不持有第二套 tab state。

binding 为 `{owner,generation,revision,expectedHost,rect:{x,y,width,height},active}`。owner 为 TS 本进程 opaque id，不含 tab/file/session 身份；native 内部 key 与 TS owner 分开。只登记当前 scope 的 active hit（另保留已聚焦项以便 blur），最多 256 个；重叠/非法/无范围/失效 hit 均不产生动作，不关闭或截断 live tabs。

## 原生事件与双门禁

Mac 使用真实 NSWindow 的 `NSEvent` local monitor，验证 windowNumber/buttonNumber=2，以 root `convertPoint:fromView:nil` 归一到左上 page points。monitor 只观察并返回原 event；otherMouseDragged、右键、wheel 等撤销 pending，不接管 NSH 左键、pan 或普通焦点。复制 block 使用现有 Objective-C Blocks ABI，不新增依赖。

Windows 原 `window_proc` 转交真实 `WM_MBUTTONDOWN/UP`、`WM_LBUTTONDOWN` 和取消/失焦消息；client signed px 经 `GetDpiForWindow` 转 page points。没有新 subclass、鼠标 capture、子 HWND、IME 或 keymap owner。普通 View 的 `focus()` 在固定 NSH 0.4 中无效，因此 leftDown 命中时只 emit `tabFocus`，点击外部/失焦 emit `tabBlur`；TS Windows 分支先对普通 target `blur()`（Win32 mount 中调用现有 `text_input::blur_all` 清 Input editing），再设置 strip focused。Mac 保留真实 onFocus/onBlur，不执行此接管。

middle 只有 down/up 命中同一 tab、同 binding revision、同 scope/lease、未 cancel 时才 emit 一次。native payload 为 `{owner,generation,revision,expectedHost,sequence}`，**没有 tabID**。先释放所有 Mutex/RefCell 借用再 emit；每条 delivery 复验 epoch，回调中退役不会继续向旧 context 发事件。

TS event gate 再验 owner/generation/revision、scope/lease、递增 sequence、current、enabled、modalOpen 与 closure 对应的真实 membership，才走 `interaction.pointerClose(capturedID,'middle')` → 现有 `requestClose`/dirty guard。native 字段不能选择要关闭的 tab；不能直接 `tabs.close`、猜 dirty 或重放 Host 写。

native rect **不是完整遮挡树**。Mac key window/attached sheet/application modal、Windows foreground/enabled 与 Host `native_modal_blocked` 是原生门禁；NSH popup、dirty dialog 与业务 overlay 另由 TS current/active/modal 门禁约束。不能宣称仅凭 rect 已证明所有遮挡场景完美。

## 独立验证与边界

`cargo test --example desktop_tab_contract` 通过 `#[path]` 编译实际模块，覆盖 rect/overlap、down/up、no-double、cancel/layout、scope/lease/epoch/ABA、focus/blur、回调重入与 signed DPI 数学。`cargo run --example desktop_tab_contract` 在 macOS 主线程创建真实 AppView/Components/QuickJS 与真实 0×0 NSView，以合成 Rust NativeInput 驱动 ComponentContext.emit；fixture **不创建 NSWindow**，不访问 Vault、网络、用户存储或系统 dialog，也不声称测试了 local monitor 的物理事件。

TS event gate 有纯回归；既有真实 NSH headless fixture 增加合成 receipt → production admission → 真实 editor dirty guard 的 cancel/discard 与去重测试。合成 receipt 不叫物理中键测试。原 NSH headless Windows 对普通 View blur 的模拟不等于 Win32 `blur_all`，不能拿无 Input 的焦点信号测试代替原生 editing/IME 验证。

当前只有 Darwin Rust target。Mac 编译/链接与合成 runtime 不代表 AppKit 物理鼠标、真实窗口 foreground、IME、滚动遮挡或 Windows target/linker/运行时通过。未用 metadata/frontend checker冒充 Windows build，未修改 Cargo 或添加依赖。Host owner 接线和实机验收均须独立记录。

本切片结果：独立 example Rust 11/11（8 条 tab 事件/坐标回归 + 3 条既有 policy）、Mac clippy `-D warnings` 与独占文件 rustfmt check 通过。实际 QuickJS/Components fixture 运行通过，包括 default command 不产生 close、active props 更新与 retired context 的迟到更新；数据目录为本次创建的独立临时目录，cache 关闭，退出仅清理自己创建的目录。Mac linker 的 __eh_frame 体积警告保留，不宣称无 warning 的完整产品构建。strip/core/event-gate 的 Vitest 16/16，其内 NSH headless 16/16；合成事件和真实 dirty dialog 的验证不等于物理 UI。
