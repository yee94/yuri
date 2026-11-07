# Outer Projects — 实施、接线与全量缺口

日期：2026-11-07。**本轮不是全量还原完成证明，也不代表 UIKit 已完成。** 只修改 `projects*.ts*`、独占 fixture/host 和本记录；没有修改 application/state/features/settings/chat/其他 iOS 文件。

## main 首次 UI 复验后的修正

以下更新覆盖后文首次交接时的“尚未接线/尚未执行”状态；后文保留初轮实现与验证的历史记录，不把历史阻塞当成当前事实。

- **C**：main 已接 directory/search/worktree/archive routes，已只读核对 `application.tsx` 的组件调用与 callbacks。本轮没有修改 application，也没有重复实施由另一代理负责的 new-draft。目录成功后的最终草稿语义仍由该代理/main 验收。
- **main 报告的 F 失败**：`app.type` 在预填路径后追加，导致 `/workspace//workspace/new-repo`；搜索按钮实际共享英文文案是 `Try again`，测试却按 `Retry` 定位。这是 main 执行结果，本子会话未运行 NSH 引擎。
- **本次修正**：clone UI 脚本先 `app.clear` 再 type 并断言路径值；clone 模式与搜索重试分别用稳定 `projects-directory-mode-toggle` / `projects-search-retry` testID，不修改产品文案或词典。保留 409 后输入不丢、不重复 clone、成功导航/返回，以及搜索部分失败、重试、exact message anchor、返回的全部验收点。
- **核心路径**：复用共享 `normalizePath`，browse parent、clone/mkdir/registry 与 checkpoint 使用同一规范路径，重复分隔符折叠，同时保留 Windows drive/UNC 语义。浏览过滤保留未完成的 `.` 叶子输入，避免破坏隐藏目录搜索；只折叠斜杠，不猜测删除合法重复目录名。
- **本子会话实际 F**：新增路径/协议回归先运行得到 2 红，修复后三个纯 TS 文件 **58/58 通过**；未运行 `projects-native.test.ts`，两条 UI 红是否转绿仍待 main 统一串行复验。`bun run dead-code` 重新执行并检查报告，生产新增页面已不再列为 unused；VM helper/fixture entry 仍有静态入口识别提示。
- **tsc**：本次执行仍失败，输出仅涉及另一个代理正在修改的 `packages/nsh/new-session.ts:157,174,180,182`（可选 hostID 与 Receipt narrowing）；本轮 Projects 文件没有类型错误。未越界修这些文件。
- **H/S/D**：本子会话仍全部未测，不宣称 UIKit 验收完成。

## 证据定义与执行边界

- **C**：生产调用链和本轮实现；独立组件存在不等于生产路由已接入。
- **F**：本轮实际执行的纯 TS/VM fixture 回归；下面另列待 main 串行执行的 NSH UI fixture。
- **H / S / D**：真实 Host / UIKit 模拟器 / 真机，本轮一律**未测**。
- 已读 root AGENTS、NSH DOCUMENTATION/README、Web 手机 Projects、原生模块及相邻协议。加载 change-discipline、theme、locale、ui-api、sync、performance、drag-to-reorder、Context7 skills；Context7 查询 `/longbridge/nsh` 的 NavPage/Sheet，并核对安装版 0.4 类型：`headerBackTitle=""`、Sheet `{ open, reason }`。
- 未用 git/GitHub，未新增依赖，未调用模型或真实 Host。未启动浏览器、模拟器、生产 App headless、iOS build、`nsh test` 或任何会调 NSH 的 Vitest 文件。
- 工具目录检索没有找到可用的下层 Agent 派发/消息工具，未成功派发 explore，不把未执行探索写作委托成果。

## Web 事实来源

| 区域 | 当前 Web 证据 |
| --- | --- |
| 首页标题、搜索、＋菜单、置顶/进行中、项目/工作树平铺分组 | `packages/ui/src/mobile/projects/MobileProjectsHome.tsx`、`MobileProjectCard.tsx` |
| 操作、项目编辑、关闭确认、手动/智能标题、归档/删除撤销、建工作树后开草稿 | `MobileProjectsHomeContainer.tsx`、`MobileRowActionsSheet.tsx`、`packages/ui/src/mobile/sessionMenuModel.ts` |
| 3 行默认 slice、＋7、Fewer 在 More 上、running/current 常驻、工作树默认收起 | `useMobileProjectsHomeModel.ts`、`packages/ui/src/apps/mobileSessionPagination.ts` |
| 工作树/项目展开偏好跨启动且按实例隔离 | `packages/ui/src/stores/useMobileSessionTreeStore.ts` |
| 置顶按创建时间补序；进行中包括未读；子孙/后台 shell 影响 activity | `packages/ui/src/components/session/sidebar/pinnedSessions.ts`、`packages/ui/src/sync/DOCUMENTATION.md` |
| 搜索为独立 push 页；标题/正文全局、文件仅 Focus、命令与设置、分组排序与正文锚点 | `packages/ui/src/mobile/MobileGlobalSearchHost.tsx`、`packages/ui/src/components/ui/CommandPalette.tsx`、`commandPaletteFilesState.ts` |
| 选目录、输入路径过滤、隐藏项、quick-add、新建目录、clone、Git 身份 | `packages/ui/src/components/session/DirectoryExplorerDialog.tsx` |
| 工作树两模式、source、命名/目录联动、GitHub Issue/PR、上游/bootstrap/setup | `packages/ui/src/components/session/NewWorktreeDialog.tsx`、`packages/ui/src/lib/worktrees/worktreeCreate.ts` |
| 项目图标/颜色/发现图标、工作树重排和删除 | `packages/ui/src/apps/MobileProjectEditSurface.tsx`、`MobileDeleteWorktreeDialog.tsx` |

当前 Web `session-sharing-availability.ts` 明确 `SESSION_SHARING_AVAILABLE=false`，因此没有伪造分享接口或用本地数据拼分享链接。Projects 首页源码没有独立的“已归档/进行中”筛选条；不能凭旧设计自行增加一套筛选 UI。搜索输入的多词过滤、分组与 Fold/More 是实际需要对齐的行为。

## 本轮实现与 C/F/H/S/D

下表所有 H/S/D 均未测；“F 通过”仅指下列 56 项纯逻辑测试中的相关覆盖，**不指 NSH 渲染通过**。

| 能力 | C（当前源码/接线） | F | H | S | D |
| --- | --- | --- | --- | --- | --- |
| 项目/工作树列表、opaque 分页、Host 排序与 CAS 工作树顺序 | 既有 `projects.tsx` 保留；失败保留有效快照/未加载 rank，不把 bounded index 当完整目录 | 分页、scope、坏响应、Host fence、CAS 重试通过 | 未测 | 未测 | 未测 |
| 展开/分页细节 | 项目默认展开、linked worktree 改为默认收起；展开才 GET 目录；显示计数/chevron；Fewer 在 More 上；到达本地尾部再拉页；running 超出 slice 不被藏掉 | controller 原有分页覆盖；新布局/点击行为尚待 UI fixture/设备 | 未测 | 未测 | 未测 |
| 项目选中标记 | `activeProjectId` prop 驱动，不再拿“有会话运行”冒充“当前项目” | 静态类型检查范围内；生产 prop 待 main | 未测 | 未测 | 未测 |
| 置顶、进行中、会话 actionSheet、左滑 rail | 既有真实 pin/stop/sync/归档/删除动作保留；祖先 activity、未读、权限/问题等仍不完整，见缺口 | pin、busy sync 防护、排序通过 | 未测 | 未测 | 未测 |
| 手动标题 | 先 Host metadata merge-patch 写 manual titleAuthority/revision 并清 titleRefresh，再 official PATCH；首步失败不 PATCH，换 Host 不继续第二步 | 精确请求、保留旧标题/activity、失败/Host fence 通过 | 未测 | 未测 | 未测 |
| 智能标题 | 只提交已有 metadata 请求，不调用模型；改为请求确认后才关闭 rename Sheet，失败保留输入/重试入口；提交中阻止 sheet 关闭 | metadata 精确协议通过；Sheet 未跑 | 未测 | 未测 | 未测 |
| 归档/撤销/部分失败 | 每个 archive receipt 都验证 ID、目录和 archived authority；完整子树分页成功才写；部分失败即使父已消失仍有明确重试按钮；Undo 恢复父再恢复子、保留失败项；成功恢复根会清相应失败操作 | 分页、部分失败、父先恢复、旧 Host/坏 receipt、显式 retry journal 通过 | 未测 | 未测 | 未测 |
| 归档管理入口 | `onOpenArchivedSessions` callback 可交给 main 打开 Settings 的真实归档页；不能仅删除按钮 | callback 未接 production | 未测 | 未测 | 未测 |
| 工作树删除 | 原有完整 inventory/子树归档 journal、dirty authority、root 禁删、local/remote 分别选；远端删失败独立重试；本地失败不动 remote | 分页/部分失败/同 Host remount journal/顺序/Host fence 通过 | 未测 | 未测 | 未测 |
| 工作树创建 | 两模式 validate→create，source 只在 new 模式显示；分支用原生 List 不再固定截 100；错误保留输入，重试分支加载；pending 时 Sheet 不关闭；提供 `initialCreateWorktree` 与 `onWorktreeCreated` | validate/body/Host fence 通过；创建 Sheet 未跑 | 未测 | 未测 | 未测 |
| 项目菜单建工作树 | 按明确 `/api/git/check` boolean authority 决定入口；探测失败保留 error，不把 unknown 当非仓库；直达 callback 已提供 | true/false/failed probe 通过 | 未测 | 未测 | 未测 |
| 加项目/导入现有目录/新建目录/clone | 新 `projects-directory.tsx` 原生 NavPage、Host home/list、路径前缀过滤、隐藏项、quick-add、mkdir/clone、Git profile picker、registry 注册；**main 尚需替换旧 registering Files 路由** | 10 项纯 TS：精确协议、同目录 50 次输入只一读、403 不 mkdir、快照保留、坏确认、去重、失败 retry/Host fence/dispose 通过 | 未测 | 未测 | 未测 |
| 创建与注册分步恢复 | clone/mkdir 成功立刻 checkpoint；settings GET/PUT 失败后再次提交相同输入只重试 registry；fresh GET 保留其他项目未知字段；返回前不虚构项目 | mkdir/clone 各一次、失败保留、现有路径 ID、Web projectId 规则通过 | 未测 | 未测 | 未测 |
| 全局搜索 push 页 | 新 `projects-search.tsx` NavPage；标题与内容全局请求，文件只查显式 Focus；无 Focus 不发文件请求；各域独立失败/重试，same-query 保留快照；给 main 透传 exact messageID 和文件路径；命令/设置列表由 main 注入 | 5 项纯 TS，精确请求、独立失败、坏 authority、旧查询/Host/Focus/cancel fence 通过 | 未测 | 未测 | 未测 |
| 首页旧搜索 fallback | 旧 title-only Sheet 暂保留；关闭取消 debounce 与迟到 completion；不会把错误画成“没有结果”；**不把它称为全局搜索完成** | close/cancel fence 通过 | 未测 | 未测 | 未测 |

## 给 main 的精确接线合同

`application.tsx` 属于 main，本轮未修改；以下是需要 main 实际接入并验收的接口，不是已经接入的证明。

```ts
// projects.tsx 的 ProjectsNavigation 新字段（全部保留现有字段）
onOpenSearch?: () => void;
onNewWorktree?: (project: Project) => void;
onWorktreeCreated?: (project: Project, directory: string) => void;
onOpenArchivedSessions?: () => void;
activeProjectId?: string;

// projects-directory.tsx
ProjectDirectoryPage({
  onAdded: (project: Project, options: { openDraft: boolean }) => void,
});

// projects-search.tsx
ProjectsSearchPage({
  commands: Array<{
    id: string;
    title: string;
    keywords?: string;
    group: 'commands' | 'settings';
    onSelect: () => void;
  }>;
  focusDirectory?: string;
  onOpenChat: (target: ChatTarget, options?: { messageID?: string }) => void;
  onOpenFile: (directory: string, path: string) => void;
});

// ProjectDetail 新 prop
initialCreateWorktree?: boolean;
```

1. `onAddProject` push `ProjectDirectoryPage`，不要继续旧 `Files(registering=true)` 冒充完整选目录。`openDraft=false` 为 quick-add，留在选择页；`true` 为主提交，pop 选择页再打开新会话草稿。该页已成功注册项目；不要再次注册或 mkdir/clone。
2. `onOpenSearch` push `ProjectsSearchPage`。`focusDirectory` 必须来自当前 Focus，不要退回扫描所有项目。文件路径可能是相对路径，使用 main 的已有安全资源打开函数。`messageID` 必须进入 Chat 的消息定位合同；单纯打开 tail 不能算正文结果正确导航。
3. `commands` 需是完整的真实可用命令/设置清单，不能仅传一个 Settings 作为完成证明；不能把未实现命令隐藏后称已全量。
4. `onNewWorktree` push 项目详情并传 `initialCreateWorktree=true`；建成后 `onWorktreeCreated(project,directory)` 应关闭该创建入口并打开该目录草稿。未提供时组件保留原来的“创建后选中目录” fallback，仍不等同 Web 的草稿导航。
5. `onNewSession(project?)` 需要 main 的**未发送草稿**入口。既有未传 callback 的 fallback 会立即创建服务端 Session，不是 Web new-draft 语义。
6. `onOpenArchivedSessions` 接真实归档管理页；`activeProjectId` 用当前 Host 权威值。已有实例选项、扫码和远程桌面仍由 main 提供真实 callback。
7. 两个新增页面和 ProjectDetail 已使用 `headerBackTitle=""`、系统返回，不另加自绘返回；ProjectsHome 沿用根页无系统 header、内容区单标题的组织，main 不要再包一个重复标题。目录写入期间暂阻止系统 back/swipe，以保留已开始的操作及 checkpoint。

## 仍未完成的全量缺口（不降为 MVP）

这些都仍在全量验收范围，不允许因为下表存在就降低标准。

1. **生产接线**：新增 directory/search 页面、创建工作树直接入口/成功草稿导航、归档管理 callback、activeProjectId，以及真正 new-draft；交接时不能按源码存在勾 C 完成。
2. **列表数据/状态**：项目图标/颜色/图片、active/current row、全部项目/工作树总数与最新时间、未读（包括完成未读的进行中条目）、权限/问题指示、diff 计数、子孙/后台 shell family activity、未载入 active ID 的目录 identity 回填，尚未与 Web 等价。当前 running 仍主要是原生 membership/event，不能称完整 activity reader。
3. **置顶与顺序细节**：当前未保存 rank 的 pinned fallback 仍按 updated/activity，不是 Web created；展开偏好仍为页面内 signals，未做按 Host 跨启动持久化；手势 rail 的互斥、滚动仲裁、长按/drag 与点击抑制、触觉/读屏等必须设备验收。
4. **删除**：Native 仍是确认后立即 DELETE；Web 是 10 秒可撤销的 deferred delete + 子树级 rollback。不能把已有 archive undo 当 delete undo 完成。归档重试 journal 是本 controller 生命周期；进程退出/根页重建后的 journal 恢复也未完成。
5. **项目编辑**：仍交 Settings owner。Web 项目编辑的图标预览/颜色/自定义图片/自动发现与移除、工作树拖拽与 Sheet 关闭/恢复，不能用 generic settings JSON 编辑器宣称相同；本轮没有改 settings 文件。
6. **目录与 clone**：Git profile selector 已可选，但 global/default/首个 SSH identity 的完整默认选择尚缺；Web 路径键盘/焦点和快捷导航未测；只有成功回包的 clone/mkdir checkpoint 可避免重复，**网络未知结果/页面重建/重启**没有持久化恢复，不得直接宣传完整断点续跑。后端目录创建与 clone 是实际副作用，注册失败不会删除这些文件。自定义图标发现与全局后台任务进度也未接。
7. **全局搜索**：原生页具备真实 domain 请求与导航 callback，但尚缺 Web 的会话/正文合并去重排序、分组/Show more、日期/说话人/项目摘要、匹配高亮、完整命令/设置与插件命令清单、可见期间内容索引更新、导航冻结/返回恢复专项。当前文件搜索 limit=40，Web 对外展示/排序是 10；命令匹配为多词包含，尚非 Web 的完整排名；不把新增页称完整 CommandPalette 迁移。
8. **工作树高级流程**：自动命名和目录联动、source 偏好/ranking、Issue/PR 关联、PR diff/上下文、远端/upstream 默认、setup commands/bootstrap wait，以及创建后可能带真实 sessionID 的流转尚缺。只实现两个基础模式不代表全量工作树完成。本轮没有调用任何 GitHub 或模型。
9. **导航/外部入口**：二维码深链恢复、实例切换、远程桌面、插件市场/插件内容视图属于跨模块合同；本轮仅保留既有 callback，不对它们代填完成状态。
10. **真实运行**：所有新增/变更的 NSH Sheet、UIKit 返回、键盘、Tab、safe area、长列表、VoiceOver、真实 Relay/Host、断网恢复、clone 与分支实际操作都未测。

## 实际执行的验证

```sh
bunx --no-install vitest run --config packages/nsh/vitest.config.ts packages/nsh/projects.test.ts packages/nsh/projects-directory.test.ts packages/nsh/projects-search.test.ts
# 3 files, 56 tests passed；VM/TS，绝不生成或启动 NSH engine。

bunx --no-install tsc --noEmit -p packages/nsh/tsconfig.json
# 整包失败。最终一次仅剩共享 packages/ui/src/lib/runtime-url.ts:64,67：
# URLSearchParams.entries 的 DOM.Iterable 类型缺失/unknown iterator。
# 最终输出没有本轮 Projects 文件错误；不能把整包称为通过。

node --check packages/nsh/tests/projects-outer-host.js
# passed；仅 JS 语法检查。

bun run dead-code
# 执行并检查报告，非阻断退出 0；有仓库既有 unused files/exports 等。
# 新 ProjectDirectoryPage/ProjectsSearchPage 因 main 未接生产路由被列 unused；
# fixture entrypoints 也未被 knip 的 NSH 静态 entry 配置识别。
# 未通过删除导出/fixture 来掩盖接线缺口。
```

### 已实现但本轮禁止执行的 UI 验证

- `projects-native.test.ts` 保留旧 Projects 引擎用例，新增两条 `projects-outer.fixture.tsx` + `tests/projects-outer-host.js` 用例：clone 后 registry 409 保留输入/不重复 clone/返回；内容搜索 503 不抹掉标题/文件、重试、exact message anchor、返回。
- 这些用例**尚未执行**，main 可在设备验收结束后统一串行运行：

```sh
bunx --no-install vitest run --config packages/nsh/vitest.config.ts packages/nsh/projects-native.test.ts
```

即使此命令之后通过，也只能增加 NSH fixture 证据，不能替代 H/S/D，更不能自动清除上面的全量缺口。
