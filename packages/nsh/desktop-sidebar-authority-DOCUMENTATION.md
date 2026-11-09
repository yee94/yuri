# 根 authority 与 folder 草稿接线

## main 的 exact API

```tsx
import { desktopSidebarAuthority } from './state';
import type { NativeNewSessionFolderTarget } from './new-session';

<DesktopSidebar authority={desktopSidebarAuthority()} ... />
```

`desktopSidebarAuthority(): DesktopSidebarAuthority | null` 直接消费当前根 source。不要再包请求、timer、observer 或另一个 catalog。Host/授权/epoch 退休后旧投影立即不可采用。

`NativeNewSessionPage` 最小增加 **initial-only** prop：

```ts
initialFolder?: NativeNewSessionFolderTarget; // Readonly<{ scope: string; id: string }>
```

页面的现有 `open(project?, directory?)` 允许第三参数 `folder?: NativeNewSessionFolderTarget`，仅在首次 `open(props.project, props.directory, props.initialFolder)` 时传入，并原样加入既有 `creation.set({ project, directory, active: current, draftAuthorityKey, folder })`。用户主动切项目/工作树时仍调用不带第三参数的 `open`；不同目录不会继承路由旧 folder。

main 的 `onNewSessionInFolder(project, folder)` 捕获原样 `{scope,id}` 到本次 route intent，打开 `project.path` 的原草稿页并传 initialFolder；不得只调用普通 new-session 而丢字段。

同目录已经打开的未发送 owner 不需要重建：对其调用 `await owner.setFolder(folder)`，再提交现有导航/聚焦动作。它只改同一 receipt 的 folder metadata，保留输入正文/附件。`phase !== 'draft'`、pending input 或 submitting 时核心拒绝 retarget；不要通过普通 new-session 的同目录早退悄悄忽略 folder intent。若用户离页确认取消，main 不调用 setFolder、不提交路由。

`openNativeNewSession` / `createNativeNewSessionOwnership` 的现有 options 新增：

```ts
folder?: NativeNewSessionFolderTarget;
folderAdmission?: NativeNewSessionFolderAdmission; // 窄测试/已有 owner 注入；生产通常不传
```

生产默认 `admitNativeNewSessionFolder` 已由原 `createProjectsSidebar` 实例注册；按实际 `PageOperation.scope + generation` 解析唯一当前 owner。不需要 main 暴露 controller、改 sidebar JSX，或创建第二个 Projects/folder owner。没有 owner、多个符合的 owner、旧 lease 或已退休 owner 都 fail closed，不猜可用。

## source 所有权

- root `refresh` 的已有 Assistant snapshot 与 `AssistantHome` 的原 `readAssistantSnapshot` receiver 都调用 `adoptAssistantCatalogSnapshot`。保存已知 enabled/revision，联系人投影只保留 ID、saved avatarSeed、preview、working、activeContactTurn、unreadCount。
- 新增 sidebar projection **不是 Home 的 validity gate**。原 Native Home 允许但 sidebar 字段不完整的联系人仍可进入原 Chat；optional projection 保 prior 或未知，不能清空未读/working，也不能阻断主产品。独立 revision receipt 防止随后较旧 root 结果覆盖已采用的 Home catalog。
- 老 array-only 根 catalog 仍供其既有 consumer 使用，但绝不被解释成 enabled authority。
- schedules 使用原 `app.tasks` 提交边界，读取真实 `task.state.lastStatus`，映射到侧栏已有 `task.lastStatus` port；已有扁平投影也被保留。页内原 scheduled catalog 的 GET/confirmed mutation 同样通过这个原 signal 发布。部分失败保本 scope 的 prior；Host/epoch 退休清除 provenance，不把旧授权项目行借给新 source。
- sessions 的 `hasChildren` 在根 `sessionsFrom` 与 Projects 原 `sessionFrom` 中保留。根已有 global event receiver 只投影真实 `eventBusy` execution/status，attention 只订阅原聚合 owner。未收到 own running 时保持未知，原 sidebar controller 自己已有 `/active` authority 继续正常消费。
- 没有新增后台 shell activity 源；`navigationRunning` 保持未知，绝不补零、不从消息历史推导。父链仍由原 sidebar 的共享 live tree 投影拥有。
- 只有 source identities 变化才重建 map；无关输入不扫描 catalog、不新增网络。

## 首次 folder 准入与失败

沿用原 `nsh:new-session:v1` receipt，兼容没有 folder 的旧记录，只新增 `folder:{scope,id,status?}`。正文、附件、引用仍在原 durable draft，不进入新 store。

1. 打开/选择/输入/取消只做本地持久化，不 create、不写 membership。
2. 首次发送先按原流程持久化 input 与 create WAL，确认 create 后保留 exact target。
3. 将 membership 交回原 mounted ProjectsSidebar；它继续拥有注册目录/根 session/归档状态核验、LWW preflight、mutation lane 和 journal。真正 POST 前先持久化 folder unknown。
4. 现有 Host `POST /api/session-folders` 只有直接、成功的 `{success:true}` 响应，才是这次 awaited POST 的因果 ACK。先持久化 acknowledged，再做原 GET readback。ACK 后刷新失败不重 POST，也不阻止已确认 membership 的原 staging/handoff。
5. 丢 ACK、畸形 ACK 或 ACK 本地持久化失败保留 unknown。后续只 GET，即使观察到相同 membership 也不猜该次写成功、不再 POST。当前上游没有 operation-ID receipt 查询，不能自动解除这类 unknown；这是明确的恢复缺口，不是归组完成。
6. 原 API 没有 CAS；preflight/readback 只能检测已观察到的冲突，无法保证跨客户端并发更新不丢失。没有发明 endpoint，也没有自动重放。
7. modal/scope 变化、close、remount 与重启保留创建/folder receipt。所有 staged transfer、admission journal 和 complete 都要求 folder ACK。再次 submit 不重复 create 或已发送的 membership。

协议证据：`packages/web/server/lib/session-folders/routes.js`；Web intent/finalize：`packages/ui/src/sync/session-ui-store.ts#finalizeDraftSession`；原 Native folder owner：`projects-sidebar.ts`。

## 验证与仍未验

Vitest 4 focused：authority 原 root/AssistantHome/原 schedules writer、失败/partial/退休/50 次输入；folder 原 create→mounted owner→ACK→handoff、modal/cancel、restart、create unknown、membership unknown、ACK 后刷新失败、本地 WAL/ACK 写失败、同 owner retarget。原新会话、ProjectsSidebar、notification catalog 回归一并覆盖。

`desktop-sidebar-authority-native.test.ts` 在固定 NSH 0.4.0 真实 headless 引擎运行 Mac/Windows 各两场景，实际挂 root source、AssistantHome、DesktopSidebar 与原 folder owner；50 个原生 Input event 零 catalog 字段扫描、零新增 API 读取。`desktop-sidebar-authority-regression-native.test.ts` 使用原生产 `App.test.tsx` 两个联系人 Chat 场景及未修改 fixture，验证较窄 Native wire 不被新增投影阻断。两 wrapper 均用独立临时 config/generated/output，不写共享 `.nsh/test`。

本轮最后 focused 为 **7 文件 / 104 项通过**（其中两个外层 wrapper 各包含 4/2 个引擎场景）；整包 TypeScript 通过。`bun run dead-code` 已执行，但仍被既有 `vite-plugin-pwa` 缺失阻断，没有有效报告，没有新增依赖。

主根 `application.tsx` 已接 `authority`、folder callback 和 route intent；`new-session-page.tsx` 已接 initialFolder 及 retained-owner 生命周期。活跃同目录 owner 先 checkpoint，再导航；后台页先激活同一个 owner 再 checkpoint，不从 metadata 重建草稿。离页 Cancel 不改 folder；Host/operation/intent 再复验。`folderChanging` 核心同步门禁阻止普通提交、本地 magic、第二次 retarget、切换 selection 和 context staging 越过本地 checkpoint；页面同步禁用发送及选择。新增核心竞态测试通过，实际 App folder 根专项继续补验。AppKit/Win32 实机视觉、物理键盘、真实 Host 并发/断网/崩溃、未知 membership 的人工恢复 UX，以及真实后台 shell aggregate 均未验/仍缺 authority，不可按完整桌面对齐签收。
