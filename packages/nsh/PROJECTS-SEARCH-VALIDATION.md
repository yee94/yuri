# Native Projects 全局搜索

## 范围与所有权

- `projects-search.tsx` 拥有搜索页、分组预览/展开、独立失败与显式重试；`projects-search-core.ts` 拥有响应校验、搜索排序和会话合并。
- application 仍拥有实际导航和完整 command/settings actions；本次不修改 application、state 或 Projects owner。
- 本页不修改 `history-focus`。`onOpenChat(target, { messageID })` 继续把 exact messageID 交给现有定位链。

## 与 Web 相同的数据语义

- 会话标题、正文全局搜索；项目来自已注册 Host catalog；commands/settings 来自 main 注入。只有文件需要明确 Focus directory，没有 Focus 就不发 `/api/fs/find`，绝不遍历项目目录。
- 同一 session 的标题/正文只显示一行，保留标题结果的原序；正文按 `createdAt` 最新、同时间 `messageID` 最大选中一次，正文独有会话追加。点击仍携带该命中的真实 directory/messageID。
- 复用 Web `scoreByFuzzyQuery`，commands/settings 为 substring，项目和文件为现有 fuzzy 排序。保持 Web 的 commands/settings/projects 七项、files 十项、本页标题/正文各三十项的查询/展示上限；原生既有 find wire 四十项不变。
- 有 query 时每组先展示五项，“更多”仅展开本次结果，不发额外请求，也不取消其他域。空 query 只显示最近会话与 commands，不显示 settings/projects/files。
- 同 Host、query、Focus 的失败刷新保留对应旧快照，成功的其他域独立替换；Host/query 变化清除旧 authority，Focus 变化仅清除旧文件结果。旧 query、旧 Host、已取消/销毁请求不能写回。
- 标题、分组、角色、更多、失败和重试均复用 `i18n.ts` 的十语字典，无新增词条或英语 fallback。

## main 必须接线

`ProjectsSearchPage` 新增：

```tsx
projects={app.projects()}
onOpenProject={project => {
  nav.pop();
  nav.push({ kind: 'new-session', project, directory: project.path });
}}
```

`projects` 可省略（读取根 catalog 快照）；`onOpenProject` 未提供时不展示不可点击的项目结果。为完成项目搜索入口，main 必须传回调。Web `handleOpenProject` 实际打开的是该项目的未发送新会话草稿，**不是立即 POST create session**。

已有 `onOpenChat` 必须保留 `options.messageID`。已有 `onOpenFile` 保留 `openResourceFile` 的范围校验。所有 command/settings 回调同样应先关闭搜索再路由，防止 back 时落回已失效搜索页面。

### application `projectSearchCommands` 的真实 Web 手机动作清单

依据 `packages/ui/src/components/ui/CommandPalette.tsx` 的 commands 和 settings metadata；不要以现有两项自定义动作代替完整清单。

| Web id | 十语 title key | 真实动作 / Native 接线要求 |
| --- | --- | --- |
| `new-session` | `commandPalette.item.newSession` | 打开 `new-session` 草稿页，保持 Focus/project；不在进入页时创建会话 |
| `new-worktree` | `commandPalette.item.newWorktreeDraft` | 进入当前项目已有工作树创建流程；使用实际 Focus 对应项目，不猜首个项目 |
| `add-project` | `commandPalette.item.addProject` | `project-directory` 目录注册/克隆页 |
| `toggle-sidebar` | `commandPalette.item.showSessionSwitcher` | 手机端实际会话切换入口，不能把它改为全局搜索或普通设置 |
| `toggle-right-sidebar` | `commandPalette.item.toggleRightSidebar` | 当前 Focus 的实际 context/file panel；Native 需用真实等价入口接线 |
| `toggle-terminal` | `commandPalette.item.toggleTerminal` | 当前 Focus 的真实终端面板 |
| `new-terminal-tab` | `commandPalette.item.newTerminalTab` | 当前 Focus 新终端 tab；无有效 scope 不发送请求 |
| `context-usage` | `commandPalette.item.showContextUsage` | 当前 Focus 的 context usage overview |
| `open-settings` | `commandPalette.item.openSettings` | 设置首页 |
| `setup-tour` | `tour.open` | 实际首次引导流程，Web 手机非 VS Code 也有此动作 |
| `settings:<slug>` | 现有 settings metadata / 本地 `SETTINGS_ENTRIES` title | 每个当前 runtime 可用的实际二级设置页；`group: 'settings'`，keywords 继续传入，不把页面全归 commands |

`new-mini-chat` 是 Electron-only，不属于手机清单。原有 `connect`、目录动作不能误删，但它们不代表上述缺失动作已完成。

当前核对的 application Route 尚无 terminal/context usage/setup-tour/session-switcher 等对应 owner；这些是 main 的接线/能力缺口，不能用空函数、改名跳设置或假成功标记“完整 1:1”。本模块未越界补这些页面。

## 可重复验证

已运行（不启动 NSH 引擎）：

```sh
bunx --no-install vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/projects-search.test.ts \
  packages/nsh/projects-search-core.test.ts \
  packages/nsh/projects-search-fixture.test.ts \
  packages/nsh/projects-search-navigation.test.ts
```

- pure：会话去重、时间/ID tie、五组独立预览、Web 排序复用、空 query、10,000 会话重叠 fixture、malformed authority。
- VM：生产 controller 的 wire、部分失败保引用、显式重试、Host/query/Focus/cancel/dispose fence；实际 strict Host bundle 在没有 `URL`、`URLSearchParams`、require/import resolver 或浏览器 polyfill 的 VM 运行。
- fixture Host 使用现有严格 `fixtureRequest`；拒绝未知路由、方法、scope widening、重复/未知 query 和 malformed 编码，不提供 fake fallback。
- Bun：每个用例独立临时 Host ESM bundle/config/Storage namespace，成功/异常均清理；共享 fuzzy core 另做独立 bundle 并在同样无 URL 全局 VM 执行。生产 `nsh.json` 不增加 audit capability。
- TypeScript：以生产 tsconfig 检查 `projects-search.tsx`、fixture 及其完整依赖闭包，不启动 NSH 编译器或引擎。
- 虚拟列表测试导航：`.nsh/types/nsh/test.d.ts` 的真实 API 为 `app.scroll(selector, distance)`（负值回滚）、`app.shows`、`app.waitFor`；不存在 `wheel/scrollUntil`。`tests/projects-search-navigation.ts` 先检查 mounted 目标，再对生产 List 的稳定 `projects-search-results` testID 作有界双向滚动，找到后才 wait/press。缺失行或真实 scroll 异常仍使测试失败，不跳过“更多”。VM 用 mounted-window 模型复现旧 wait 的红例，并执行原样 stdin helper；该 helper 另经 Bun bundle 后在无 URL 全局 VM 验证。
- `bun run dead-code` 已运行；报告含仓库既有大量提示，以及仅由测试引用的 controller 和独立 fixture，不据此删除其它 owner 文件。

### 留给 main 的真实引擎测试（本子任务未运行）

```sh
bunx --no-install vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/projects-search-engine.test.ts
```

测试通过 `tests/projects-search-runner.js` 独立临时 app 装配 `projects-search-fixture.tsx`，只授权 synthetic Host 的 request/read-only audit。覆盖五组“更多”及各组展开后的尾结果、同 session 单行、失败保快照/重试、exact message/project/file/command 导航、无 Focus 不查文件。

main 初跑报告：no-Focus 通过；五域用例在展开 sessions 后等待 commands 的“更多”超时，mounted 文本只包含 commands 部分行，不能据此断言数据缺失。现改为真实 List 滚动定位全部“更多”和后续消息/项目/文件/命令目标；生产仅增加 List testID，没有在无运行证据时改写顺序、锚点或 virtualization。当前修订仍由 main 统一复跑，本子任务未启动引擎，不能声明已修复真实引擎问题；即使通过也不代表 UIKit 视觉、生产 Host、真实 Relay 或 terminal/context/tour 能力已验收。
