# 桌面 Schedule 工作区接线

## 依据与边界

权威为 Web `packages/ui/src/components/session/ScheduledTasksDialog.tsx::ScheduledTasksWorkspace` 的非 mobile 主工作区，不是设置页：Tasks / History 分段、All / Active / Paused、本地搜索、任务行与独立历史入口、右键和更多菜单、右侧编辑面板、全局/单任务运行历史及失败恢复。

`ScheduledHome` 的默认/mobile 路径继续使用原有 JSX、移动详情/ActionSheet 与历史加载按钮；只有 `presentation="desktop"` 使用新呈现。`ScopedHome` 仍拥有唯一 catalog / filter / search；`History` 仍拥有唯一历史 controller、opaque cursor、刷新与运行耗时计时器。`desktop-schedules.tsx` 不创建请求、轮询、stream 或第二 editor controller。

桌面内容上限为 896pt、24pt 横向内距；不复制移动大标题、44pt 圆形工具栏或 swipe。任务行直接请求打开现有 editor，而非 `onOpenTask` 的移动详情导航。右侧面板宽度为 `clamp(380pt,36vw,480pt)`，resize 不重建 editor。运行历史按 Web 显示状态、名称、位置、开始时间、触发来源、耗时、错误及已有会话入口。

## main 最小 props

```tsx
<ScheduledHome
  presentation="desktop"
  active={homeForeground}
  interactive={!desktopInteractionBlocked()}
  editorOpen={existingEditorOpen()}
  editor={<ExistingOwnedEditor />}
  selectedTask={existingSelectedTaskIdentity()}
  requestViewChange={commit => existingEditorDepartureGuard(commit)}
  onCreate={existingCreateAction}
  onEdit={existingSelectTaskAction}
  onOpenSession={existingOpenSessionAction}
/>
```

- `active` 是真实前台/controller lifetime；临时 Dialog 仅更改 `interactive`，不能卸载 `ScheduledHome`、将其换成另一 owner 或撤销现稿。所有显示态操作都有事件时 admission；旧确认返回后还检查 Host/操作代际与 admission。
- **`editorOpen` 必须显式传布尔值**。不能读取 `editor` JSX 判断是否打开：NSH prop getter 会构造内容，存在性检查与实际渲染可能制造两个 editor。桌面分支只在面板内读取一次 `editor`；缺内容明确显示 unavailable。
- `editor` 是既有 editor owner 的内容，不是第二份表单或新的 NavPage。任务选择、create、save、cancel、delete、run、pending/unknown write、dirty veto、选项和错误反馈仍归该 owner。`onCreate` / `onEdit` 必须复用它原有的离页/切实体保护。仅注入现移动 `TaskEditor` 的 NavPage 不等于桌面表单完成。
- `selectedTask` 为 `{ projectId, taskId } | null`，只控制行选中态，不创建第二 catalog 或推断 editor 草稿。
- `requestViewChange(commit)` 用于 Tasks / History、单任务历史和清除历史 filter。现 editor owner 完成 dirty/pending 保护后调用 `commit()`；veto 不调用。如果 editor 已打开却缺 guard，工作区保留面板并报告 unavailable，不绕过保护。
- main 仍负责 editor write 成功后的既有 `noteScheduledCatalogWrite`、刷新/事件与导航。此呈现分支不自动重复写入。

## 行为合同

- 搜索与 filters 仅在现有已加载 catalog 本地派生，不逐输入读取 Host。任务按 Web 的 enabled-first / name 排序。
- Run now 复用 `catalog.mutate(..., 'run')`，只在原地显示真实确认，不自动跳会话；paused/running 状态的入口禁用，core 仍做最终校验。历史行只打开该次 run 的 recorded directory，不猜当前项目目录。
- 暂停/恢复与删除复用同一 catalog 的项目级写入锁、最小 PATCH 与结果校验；删除使用原生确认。失败保 prior，partial 保留失败项目且不显示权威空成功。
- 首次打开历史才构造 `History`；同一 history identity 暂时隐藏仅 suspend，Dialog 不改 active、不另发 GET。切换全局/单任务 identity 才交给相应唯一历史 owner。
- 历史使用原生 List 的 load-more 与现有 opaque cursor；失败停止自动读取，显式 Retry 重试同一页，不把错误转成 empty。

## 已验证与待验收

`desktop-schedules-native.test.ts` 用真实 NSH 0.4 headless 引擎和严格合成 Host 驱动生产组件；macOS / Windows 各覆盖搜索/过滤、菜单、运行原地确认、暂停/恢复、取消/确认删除、详情 slot、800×480 resize、空/错/partial、opaque 分页/失败停止/显式重试、recorded directory 和全局历史 filter 清除。50 次输入、20 次 editor modal toggle 保持一个 editor / 完整草稿且零额外 catalog GET；历史中的 20 次 modal toggle 也零额外请求。dirty veto 不移除 editor。

macOS headless 额外验证原生 Tabs 的 Tab / 左右键导航；Windows 对应测试明确 skip，原因是 NSH 0.4 headless `keyboard.rs::tabs_to_views` 只派发 macOS/Web 的 view traversal。没有为此给生产加入假键绑定，也不视为 Win32 实机键盘通过。

`schedules-ui.test.ts` 原有移动过滤、菜单、详情、分页和会话导航断言保留；其 fixture 仅改为真实 `loadConnections()` readiness bootstrap。`schedules-state.test.ts` 更新旧 mock 的 effect / captured-operation 边界和转发参数断言。后续 TaskEditor 范围已修复 `scope.capture()` 的 alive fence：显式 dispose 后，旧 catalog/history 的请求与返回均拒绝，迟到结果不能修改 runs/cursor/loading/pending/notice；对应原有及新增回归均保留。

没有启动原生窗口，没有连接真实 Host 写入。main 的生产接线、完整桌面 editor 表单/dirty guard、真实运行/恢复、AppKit / Win32 原生绘制、读屏、物理键盘、同状态 Web 对帧尚未验证；不能据 headless 或类型检查声明 1:1 已完成。`bun run dead-code` 已尝试，但被现有缺失 `vite-plugin-pwa` 阻塞，未安装依赖。
