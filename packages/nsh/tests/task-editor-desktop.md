# 实际桌面 TaskEditor

## 装配 API

`features.tsx::TaskEditor` 默认仍返回原移动 `NavPage`。只有 `presentation="desktop"` 使用 View / Scroll / sticky footer，不在右侧工作区动态包装 NavPage。`task-editor-desktop.tsx` 只呈现同一 TaskEditor 所有的完整 signals/catalog；`task-editor-owner.ts` 拥有该 editor 的操作与离页门禁，不创建第二表单或 catalog/stream。

```tsx
<TaskEditor
  presentation="desktop"
  item={capturedInitialItem}
  creationContext={capturedCreationContext}
  active={actualHomeLifetime}
  interactive={!windowInteractionBlocked}
  onNavigation={requestLeave => registerNavigation(requestLeave)}
  onWindowGuard={registration => registerWindowGuard(registration)}
  onClose={closeEditorAfterGuard}
  onDone={confirmedSuccessCleanup}
  onOpenHistory={commitHistoryViewWithoutAnotherGuard}
/>
```

`TaskEditorLeave = (afterLeave?: () => void) => Promise<void>`。注册一次、cleanup 发布 null。根在换实体/切主入口/Tasks–History 前调用 `requestLeave(commit)`，只有 commit 被执行才更新 selection。`item` 是本 owner 的初始实体，不能将另一个实体直接塞进同一已构造 editor；确认后按实体 key 更换 owner。同实体重选、resize、Settings/Search/Help 覆盖均不能重建它。关闭／取消默认使用 `onClose`，不把 `onDone` 当取消成功；`onDone` 只在已确认写入且收尾读取成功时通知。

`onOpenHistory` **已由同一个 editor 的 `navigation.cancel` 保护**，是 commit 通知。根应直接提交历史视图，不能再做第二次 dirty confirm。

临时 Dialog 只变 `interactive`，`active` 保持真实 home/controller lifetime。普通编辑/菜单/导航必须 admitted；已发出写入保留原 captured lane，不能在确认后换成一个新 lane 写入。保留 owner 不代表开放后台交互。

## native window guard

`TaskEditorWindowGuard = { requestClose(): Promise<boolean>; canClose(): boolean }`，通过 `onWindowGuard` 注册，和普通导航 callback 分开。

- `requestClose` 共用唯一 dirty/confirming owner，Cancel 返回 false。Discard 只记一次 exact snapshot + editRevision + captured lane 的授权，不改 pristine、不清 draft、不调用 onClose/onDone、不卸载 editor。
- 根在该检查后仍可等待 files / settings / metadata flush；最终锁定 closeCommitting 后同步调用 `canClose`。native ticket 拒绝/过期不需要恢复 editor，因为从未销毁。
- 编辑（即使再改回原文）、新操作、lane 退休、busy/unknown/confirming 都撤销或阻止授权；clean/current/无 pending 时可直接通过。
- Window close 按 owner 的真实 active/lane 而非 UI interactive 检查，所以 Settings 覆盖时也可向该 owner 询问。普通 `requestLeave` 仍须 interactive。
- 两种确认都在 await 后重验 captured snapshot、editRevision、lane/current。确认期间程序改变 draft 不能被旧 Discard 丢弃。

## 真实 UI 与写入

依据 Web `ScheduledTaskEditorDialog.tsx` 的 `presentation="panel"`：顶部状态 + more/暂停/关闭，名称为无独立 label 的 18pt editable Input；Prompt 位于内容首段的 256pt 原生 multiline Input，无重复 Prompt 大标题。详情为项目、模型（含 required/variant）、Agent、Goal checkbox 四行 grouped card；频率独立 grouped card。24pt 内距，52pt 行节奏，底部 Save/反馈 sticky，中间独立 Scroll。侧面板宽度归 ScheduledHome 的 `clamp(380pt,36vw,480pt)`，不是 Dialog；不存任何用户截图、prompt 或真实路径。

所有字段使用原有 TaskEditor signals：项目/目录、名称、Prompt、provider/model/variant/Agent、Goal/enabled、daily/weekly 多时刻、weekdays、once 日期/时间、Cron/例子/四次真实 parser 预览、timezone。模型与 Agent 目录仍由已有 `modelCatalog` 加载；desktop 首次等真实 operation 就绪后读取，项目变化只换该目录，modal/输入不重读。Prompt 沿用现 plain-text command/file/Agent/Skill autocomplete，desktop 候选用上方锚定 Overlay，不改变草稿协议。

Save/Delete/Run/暂停均使用真实 project route，`noteScheduledCatalogWrite` 在已确认结果后、刷新之前调用。Run 只原地确认，不额外打开会话。Delete 原生确认；普通 dirty Cancel 保留完整草稿。正常 Save 的成功回调不强制卸载组件；根若保留 editor，同一 owner 更新 pristine 后可继续编辑。

## unknown 与不可伪造的能力边界

- 发送前保留内存中的 exact method/path/body receipt；transport/5xx/畸形 ACK 不当作否定，unknown 期间不可编辑/重放/离页/关窗。明确 4xx 拒绝（408 除外）允许用户显式重试。
- 显式 Refresh Status 只 GET 完整项目 tasks，校验失败/partial/complete:false/重复或缺身份都不能确认。Save/Toggle 必须在稳定 task ID 上逐字段核验，Delete 必须确认完整集合中已不存在；未知结果不自动重新发送。
- 只按当前 `project-config.normalizeExecution` 的已知规则识别 absent empty variant/Agent 与 absent false Goal，不能把缺失真实字段当相等。只读核验不能证明 scheduler 同步，按 committed-but-unsynced 保留 receipt 状态，Done 只重试读取，不重放。
- `schedulerSynced:false` 已是确认写入；不再次 Create/PATCH/DELETE。刷新失败保留 committed state，只有成功收尾才调用 onDone。
- **Run 的未知结果仍是 unknown**：当前协议没有 operation correlation/receipt，不能从历史或 active 猜出本次运行结果。该状态禁止重放和关闭；要完整恢复必须由 owning backend 提供可核验的运行回执，本改动不伪造接口。

## 证据边界

`task-editor-owner.test.ts` 覆盖 callback/DTO 门禁及 await 期间变更、窗口 grant、pending/unknown/commit-only-read、Host/unmount fence。`task-editor-desktop-native.test.ts` 驱动真实 NSH headless 组件与严格合成 Host，覆盖两平台完整字段写入、创建/长 Prompt/Cron/once、菜单、dirty/modal/resize、unknown、窗口授权与 post-grant edit；Windows Tab 明确 skip，因为 NSH 0.4 headless 仅 macOS/Web 派发 view traversal。

默认移动回归包括 `features.test.ts`、`features-ui.test.ts`（真实 Foundation offset 数据 + headless 原 NavPage）和 `task-editor-native-engine.test.ts`。后者的项目 Sheet 选择场景在 iOS headless 被真实 `NativeSelect` admission 拒绝：`yuri.sheet.presentation` 没有 UIKit 的 `opened` completion，不能给生产控件加 fake-ready 绕过。该场景须 UIKit target 复验；没有删断言、改为 Mac 冒充 iOS 或静默 skip。

未启动原生窗口，未进行真实 Host 写入；AppKit/Win32 绘制、物理键盘、UIKit Sheet 和逐像素视觉验收未在这些合成测试中证明。

### 本轮 focused 验证

- 14 个 Vitest 文件：12 通过、2 失败；88 项中 86 通过、2 失败。桌面 wrapper 通过，其内部 macOS/Windows 共 19 场景通过、1 个 Windows Tab 场景明确 skip；owner 14 项、schedules state 33 项通过。
- 失败之一是上述默认 iOS 项目 Sheet admission，仍需 UIKit target。恢复原移动 Prompt inline JSX 后，Agent/Skill 场景在完整批次与另外五次独立重复中均通过；这仅表示本轮未再复现错选，不证明系统触摸行为已验收。
- 另一失败是 `task-editor-types.test.ts` 的完整 Native type graph 边界：`gui-plugin-native-context-factory.ts` → `ui/src/lib/theme/cssGenerator.ts` → `ui/src/lib/desktop.ts`。未放宽边界断言，也未修改该范围外模块；TaskEditor runtime bundle 两项通过不等于完整类型边界通过。
- 最新 `nsh:check` 被范围外 `desktop-remote-connections-fixture.tsx:16` 缺少必需 `syncHistory` 阻塞，不沿用早先通过的结论。`bun run dead-code` 被缺失的 `vite-plugin-pwa` 阻塞；未为验证安装依赖。
