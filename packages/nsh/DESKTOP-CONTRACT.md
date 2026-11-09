# NSH 0.4 desktop chrome

`desktop.tsx` 是独立的桌面基础模块，不读取 application/state/Host、不创建业务路由。入口尚需主应用接线；本模块没有更改 `App.tsx`、`application.tsx`、package 或共享语言字典。

## 根装配

在根 NSH component owner 内安装一次菜单，并在导航区域之前放置一次标题栏：

```tsx
const menu = installNativeDesktopMenu(() => ({
  newSession: { run: openNewSession, disabled: !canOpenNewSession() },
  search: { run: openSearch },
  switchSession: { run: openSessionSwitcher },
  settings: { run: openSettings },
  toggleSidebar: { run: toggleSidebar },
  togglePanel: { run: togglePanel },
  toggleTerminal: { run: toggleTerminal },
  closeTab: { run: closeActiveTabOrWindow },
}));

return <View class="flex-1">
  <NativeDesktopTitleBar title={windowTitle()} menu={menu} />
  {/* application-owned navigation */}
</View>;
```

- 导出：`installNativeDesktopMenu`、`NativeDesktopTitleBar`；回调类型在 `desktop-core.ts`。未传回调的业务命令不显示；`disabled` 同时阻止菜单回调执行。业务操作自己的权限/导航资格仍由主流程校验。
- 安装函数必须在活跃 NSH owner 内调用。菜单和标题栏均禁止重复 native 根 owner。不要在各 route 中安装，避免覆盖全局菜单和错误清理。
- `actions` accessor 与现有 `t` 都是响应式输入。导航资格、回调或语言变化会重装菜单，并使旧 JS 回调失效；输入正文不应成为这个 accessor 的依赖。
- 应用动作：新会话 `mod+n`、搜索 `mod+p`、设置 `mod+,`、侧栏 `mod+b`、面板 `mod+alt+b`、终端 ``ctrl+` ``、关闭标签 `mod+w`。`switchSession` 仅提供菜单入口，不绑定快捷键；不沿用 mobile 的 `mod+b`。NSH 将 `mod` 解释为 Mac Command / Windows Ctrl。已有 `keymap` 的同键绑定优先于菜单；菜单先于普通组件键处理，主流程不要保留相互矛盾的绑定。
- 只要提供 `closeTab`（包括 disabled 状态），就不安装默认占用 `mod+w` 的 native `close` role，避免快捷键错误关闭窗口；系统原生窗口关闭控件不受影响。没有传入 `closeTab` 时保留平台原生关闭窗口菜单。
- 主流程集中绑定 `mod+w`，并给菜单传入同一个 `closeTab.run`：先关闭当前 panel tab/settings，均无可关闭内容时才在 `isAvailable` 为 true 时 `Window.close()`。本模块不安装任何 keymap，不另建导航判断或回退，避免同键双发；这部分实际主流程接线不在独立模块的测试范围。
- 仅 `platform.desktop` 决定标题栏布局。浏览器的 desktop idiom 可展示标题，但不表示有 native window。每个 Window/Menu 调用都由 `nsh/desktop.isAvailable` gate；mobile/headless 不操作窗口、不安装或清空菜单。

## 原生职责

- `Window.setTitle` 更新窗口标题；`Window.setTitleBar({style:'hidden',height:40})` 保留真实系统窗口控件。没有仿制红绿灯或最小化/最大化/关闭按钮。
- 高度及两端预留直接读响应式 `titleBar()`；实际 native 高度优先于请求高度，左右只加 8pt 内容间距。Mac traffic lights、Windows caption buttons、fullscreen/resize 的真实区域由 NSH 提供，不以按钮是否显示猜能力。
- 标题区用 `desktop.windowDrag` 交还系统拖动/双击/窗口菜单行为。原生 Button 的 press handler 本身排除拖动；children slot 显式 `windowDrag:false`，适合搜索框等交互内容。`height` 可调整请求高度，不承诺 Mac 实际高度与请求相等。
- Mac 使用系统应用菜单；Windows/Linux 隐藏标题栏后，以标题区按钮调用真正的 `Menu.popup`，不是自绘菜单。popup 默认出现在指针处。原生 menu bar 快捷键仍有效，不依赖按钮呈现。
- 编辑项保持 `undo/redo/cut/copy/paste/selectAll` 原生 role，不添加替代 `onSelect` 或 shortcut，因此聚焦编辑器拥有原生语义（Mac redo 为 Command+Shift+Z，Windows 为 Ctrl+Y）。窗口操作也直接使用 native role。
- 业务和顶层标签复用现有 locale；产品名为 Yuri。系统 role 标签由 NSH/平台提供，不宣称全部跟随 Yuri 的语言设置。当前字典没有专门的 File/View/Window 菜单标题，故窗口角色放在 Yuri 菜单内，不硬编码新标题或扩张字典。
- 根销毁时 `Menu.setApplicationMenu(null)` 恢复平台默认菜单，`Window.setTitleBar({style:'default'})` 恢复系统标题栏。NSH 没有读取旧窗口标题/旧菜单 API，因此不伪造“还原之前任意外部 owner”。窗口标题仍是最后设置值。宿主应将本模块视为此窗口的唯一 chrome owner。
- 已打开 popup 没有公开 dismiss API；销毁/替换后其旧业务 JS 回调已被 revision fence 禁止，底层 popup 仍等系统关闭。popup promise 失败向上传播，不伪装成功。

## 验证与边界

依据精确 NSH 0.4.0 `e626a8dd` 的 `website/modules/nsh-desktop.md`、JS desktop decoder、core roles 与 Mac/Windows chrome 源码。

已运行：

```sh
NSH_BIN=/path/to/nsh/bin/nsh bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/desktop-core.test.ts packages/nsh/desktop-engine.test.ts
bunx tsc -p packages/nsh/tests/desktop-types.tsconfig.json --pretty false
```

共 13 项通过：纯菜单/桌面命令冲突/geometry/capability/替换失败/过期回调/清理，以及真实 0.4.0 headless 的 off-native 导入、语言更新、卸载重挂。独立 fixture 没有网络或凭据能力。`bun run dead-code` 已尝试，但仓库现有 `vite.config.ts` 无法加载 `vite-plugin-pwa`，未补装依赖。

未运行 Mac AppKit、Windows Win32/GPUI、浏览器 desktop 或发布包验收。headless 的 `isAvailable=false`，不能证明 native 控件点击、snap layout、窗口拖动/双击、fullscreen insets、IME/编辑角色或真实菜单的键盘行为。Windows 0.4.0 embedded child surface 会拒绝除 popup 外的窗口命令；Mac embedding 已有 toolbar 时保持宿主 toolbar 的实际高度。不要由 `isAvailable` 推断宿主允许接管全部 chrome；本接口针对主应用拥有的顶层窗口，嵌入宿主须自行选择是否挂载。
