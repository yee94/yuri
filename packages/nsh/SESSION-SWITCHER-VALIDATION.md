# 会话切换与 context action：交付合同

> 以下为第一阶段交付记录。后续完整 context overview、真实 source adapter 与最新接线合同见 [CONTEXT-USAGE-VALIDATION.md](./CONTEXT-USAGE-VALIDATION.md)；不能继续以本记录的未实现说明判断该模块当前状态。

## 结论与边界

- **没有新增 context usage 计算器、平行 metadata UI 或 usage state。** 已有生产 header 是本次复用目标。
- `NativeSessionSwitcherPage` 只是系统 `NavPage` + 生产 `ProjectsHome`。项目、工作树、会话、菜单、分页、搜索、失败恢复都仍由原模块所有；没有复制 desktop 的七条 recent 算法，也没有新增 catalog 算法/store。每次挂载仍会创建原 `ProjectsHome` 的页面 controller；main 若已能直接展示现有 Projects surface，应直接注入该导航 callback，不为了使用这个 wrapper 再挂载同屏第二份目录。
- 此子任务没有修改 `application.tsx`、`state.ts`、任何 `chat-header*`、共享 UI 或翻译字典。main 尚需接线；不能据此声明两个入口已经出现在生产 App。

## 真实来源（本轮核对）

| 来源 | 合同 |
| --- | --- |
| `packages/ui/src/components/ui/CommandPalette.tsx:242–257` | 手机命令 ID 为 `toggle-sidebar`，标题复用 `commandPalette.item.showSessionSwitcher`。 |
| `packages/ui/src/components/ui/CommandPalette.tsx:286–291` | `context-usage` 调用目录级 `openContextOverview(currentDirectory)`，**不是** metadata ring 的 toggle。 |
| `packages/ui/src/mobile/chat/MobileContextProgressButton.tsx:292–294,313–318,381–402,470–493` | 手机圆环打开 branch/context/quota metadata；实际 session directory 优先，最新 user model/保存选择和 catalog 提供模型 authority。 |
| `packages/ui/src/components/layout/ContextSidebarTab.tsx:278,345–383,411–444,524` | Context overview 是另一个 surface，含 token breakdown/cache/cost/TPS 等；现有 metadata 不等于它。此次没有用一个新“usage 页面”冒充完整 overview。 |
| `packages/ui/src/apps/MobileApp.tsx:2141–2173,2962–2971` | 当前 `MobileHeader` 的 sessions action 与 metadata 互斥；该 sessions sheet 挂载在 iPad sidebar。不能把它误称为所有手机 Chat 的标题点击。 |
| `packages/ui/src/components/session/SessionSwitcherDropdown.tsx:214–222` | 已选 session 只关闭；其他选择带实际 directory。这是保持状态的参照，不搬 desktop 下拉的全部视觉。 |
| `packages/nsh/CHAT-VALIDATION.md:82` | 已有真实 UIKit metadata 28.9K/400.0K、7.2% 与 quota 的证据，不是缺实现。 |
| `packages/nsh/chat-header.tsx:65–95` | 唯一生产 metadata owner 与浮层；`showMetadata(true)` 负责打开和原 owner 的刷新。 |
| `packages/nsh/chat-header-metadata.ts:20–35,38–52,89–129` | 已共享 token-baseline 纯算法，读取20条 newest-first authority、指定目录的 catalog/session/Git；失败显式 stale，保留已有有效快照。无需再抽 seam 或复制算法。 |
| `packages/nsh/projects.tsx:313–362,838–961` | 已有 session-index authority、独立失败保留及完整项目/工作树/会话入口。 |
| `packages/nsh/projects-search.tsx:61–71,92–93` / `application.tsx:146` | 全局搜索与 exact `messageID` 路由已存在，必须保留，不能退化为仅打开 session tail。 |

## main 最小接线

### 会话切换

1. main 增加一个 `session-switcher` route；保存打开时**真实当前 ChatTarget**，不从首项目/recent 猜 directory。
2. 该 route 返回：

   ```tsx
   <NativeSessionSwitcherPage
     currentTarget={route.source}
     current={pageScope()}
     onClose={() => nav.pop()}
     navigation={projectsNavigation}
   />
   ```

   `projectsNavigation.onOpenChat` 继续使用 main 的 `openChat`。组件只先 pop 当前 switcher，然后 push 目的 Chat；原 Chat route/object 不 replace、不 popToRoot，其 createChat/draft owner 保留。选当前 session 仅 pop switcher。系统 `NavPage` 拥有返回键与边缘返回，不叠手写 iOS 返回按钮。

3. 所有非会话动作继续传 main 的完整 `ProjectsNavigation`，尤其 `onNewSession` 必须传入未发送草稿路由，避免 `ProjectsHome` 的旧 `createSession` fallback。`onOpenSearch` 可继续使用 main 的全局搜索；明确 Focus 时传真实当前 directory，否则保持 undefined。
4. 当前 Chat 搜索结果的 selection 可使用 `createSessionSwitcherSelection`；传入原样 `{ messageID }`。即使 same session，有 exact messageID 时也不能走“只关闭”分支。不要再额外 pop 第二次。

### 命令面板 / context action

`chatNavigationSearchCommands({ t, current, closeSearch, openSessions, openContextUsage? })` 返回两个现有 ID/翻译的命令描述。将它们追加到 main 的 `projectSearchCommands`，只在搜索页存在时构造。

- `closeSearch` **只关闭当前搜索路由**；随后调用实际注入的 open callback，组件不触碰目录、历史、模型或 usage。
- 标题/命令复用已有十语键 `commandPalette.item.showSessionSwitcher`、`commandPalette.item.showContextUsage`；本轮核对十份字典均已有正式翻译，无新增文案或英文占位。
- `openSessions` push 上述系统 route，携带打开搜索前的真实 ChatTarget。
- `openContextUsage` 是**显式 open**，不是合成点击/切换 ring。若产品在手机上使用现有 metadata，请 main 暴露现有 `ChatHeaderActions` 的 `showMetadata(true)`，等原 Chat 恢复 active 后执行；同一 header 仍拥有唯一 `open`/menu 互斥/刷新/Quota controller，两个 native/fallback header 必须一致。回调须以 Host generation + target ID/directory 做 fence；不能在 search 覆盖期间调用后被 `current()` 静默丢掉，也不能创建第二个 metadata controller。
- 如果验收项严格要求 Web `openContextOverview` 的完整内容，则**该 surface 仍是未对齐门槛**。不能只接 metadata callback 就把 overview 标为完成。没有真实 owner 时不传 `openContextUsage`，不会渲染一个无效命令；这只是防止假成功，不是删减验收范围。

## focused synthetic fixture

- `session-switcher-fixture.tsx` 使用生产 `ProjectsHome`、`ChatHeaderActions`、`createChat` 与 NSH `NavStack`；没有复制 production UI。只有审计/打开按钮为合成测试 scaffolding。
- 故意将活跃目录设为目录 catalog 的第二项，防止“首项目”猜测；metadata catalog 只接受这个真实目录。
- `tests/session-switcher-fixture-config.mjs` 给每次运行生成唯一临时 identity/config、单个 bundled Host、独立 Storage 和临时产物。Host 复用已有 `fixtureRequest`，运行环境不提供 URL/URLSearchParams；未知 route/query、重复编码参数、错误 directory/page budget、所有创建/模型/配置/消息写入均拒绝。
- `session-switcher-engine.test.ts` 只有显式 `NSH_SESSION_SWITCHER_ENGINE=1` 才启动引擎。本次没有设置、没有运行引擎。预置流程覆盖生产 Chat 草稿→当前选择→其他选择→系统 Back，以及真实生产 metadata 文案与只读审计。它不是完整 `YuriNativeApp` 集成测试；main 接线后还需补生产 route 路径。

## 本轮验证

- `bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/session-switcher.test.ts packages/nsh/session-switcher-engine.test.ts`：21 passed，1 engine case skipped。
- `node packages/nsh/tests/session-switcher-check.mjs`：通过 focused TypeScript（包含 production import closure）。
- pure tests 执行**原有** metadata controller，覆盖 active second-directory authority、失败保prior、compaction pending、成功无baseline不伪造0、退役响应 fence；50次并发 refresh 共4个请求、catalog缓存只读一次；200次命令构造/派发没有额外网络/目录/历史读取。该 operation guard 不等于设备输入时延证据。
- Bun fixture graph 已构建并检查：包含真实 owning modules，无 application entrypoint、React、浏览器 SDK/Capacitor 树。
- `bun run dead-code` 已运行、检查报告；新 page/字符串 fixture entry 暂未由 main 引用，被列 unused，不能据此删除。报告含大量仓库既有 unused/duplicate export，不声称零告警。
- 独立 NSH bytecode build 尝试失败：当前 `NSH_BIN` 未提供、PATH 无 `nsh`（`ENOENT`）；没有安装工具或依赖。

## 尚未验收

main 生产接线、完整 overview 语义、NSH bytecode、引擎、UIKit/设备返回与手势、真实 Host/direct/Relay、全部会话菜单/分页/失败恢复的同状态视觉、IME/输入 P95 均未验证。不运行真实 Host/模型/付费调用、Git 或主应用 build。当前工具目录无真实子任务派发能力，因此未虚构多层下派。
