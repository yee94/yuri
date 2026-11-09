# Outer Settings — 实施与验证记录

日期：2026-11-07。本记录只对 Settings 独占文件负责，不代表全部外层已完成，也不替代 PARITY 或全局验收文档。**当前以文末“main真实引擎红灯后的修复”为最新状态：修复已写入，真实引擎仍待main复验，不能宣称全部通过。前面的行号与46项引擎结果是第一轮快照，不能套到后续新增代码。**

## 边界与证据定义

- **C**：当前生产模块与协议接线；“部分”仍是待交付，不是豁免。
- **F**：本轮实际执行的纯逻辑或独占 headless fixture；不连接真实 Host、不调用模型。
- **H / S / D**：真实 Host / UIKit 模拟器 / 真机，本轮全部未测。
- 未修改 `application.tsx`、`state.ts`、`features.tsx`、`appearance*`、`chat-*`、`transcript-*`、`resources*`、`ios/*`，未改全局 DOCUMENTATION/PARITY/CHAT。
- 当前工具目录没有子代理派发/会话消息工具，未成功再派出 Projects 与 Bots/计划子代理，不能代填它们的完成状态或报告。请 main 独立派发/收集对应结果。

已读取 root AGENTS、NSH README/DOCUMENTATION、历史 PARITY（不沿用其过期结论）。已加载 change-discipline、settings/theme/locale/runtime/sync skills。Context7 使用 `/longbridge/nsh` 查询导航、Switch、Sheet 与系统材质；实现同时核对安装的 NSH 0.4 `.nsh/types/nsh/base.d.ts`。特别注意安装版 Switch 回调是 `{ checked }`、Sheet 回调是 `{ open, reason }`，不是文档片段中的裸 boolean。

## 本轮修复与逐能力状态

所有路径相对仓库根。精确行号针对本记录写入时的文件；后续 main 接线可能移动行号。

| 能力 | 当前 C 与源码证据 | F | H | S | D |
| --- | --- | --- | --- | --- | --- |
| 系统设置导航、短返回标题 | `packages/nsh/settings.tsx:75-90` 使用系统 NavPage，`headerBackTitle=""`；不新造 back | 设置根→集合→详情往返通过；系统箭头外观未测 | 未测 | 未测 | 未测 |
| 项目设置列表→详情 | `settings.tsx:78` 路由到 `settings-projects.tsx:15-91`，替换原无回调按钮；支持 label、icon、color、iconBackground、defaultModel | `settings-outer.test.ts:13`：打开、409、保留草稿、重试、返回、重开 | 未测 | 未测 | 未测 |
| 项目元数据保存隔离 | `settings-projects-core.ts:15-37` 在 fresh GET 项目集合上只合并允许字段，保留其他项目/未知字段，不写 activeProjectId；继承模型用删除 defaultModel 表达 | `settings-projects-core.test.ts:6-30`：允许字段、清空、无效输入、项目已删除/坏响应 | 未测 | 未测 | 未测 |
| 保存返回集合不再陈旧 | `settings-collections.tsx:18-70,110-112` 用 epoch+directory+domain 的局部 revision 通知父集合重新 GET；`settings-projects.tsx:13,48-67` 同样刷新项目列表。编辑中的兄弟页不重载草稿，失败不清旧集合 | 删除原测试中的手动 Refresh 后先红（项目/命令两项）；修复后两项自动返回读新值通过 | 未测 | 未测 | 未测 |
| 内置 Skill 与支持文件只读 | `settings-protocol.ts:32-34,76-77` 识别 collection/detail 的 `<built-in>`；`settings-collections.tsx:29-35,73,142-157` 与 `settings-skill-files.tsx:9-65` 拒绝写入、保留阅读，隐藏写动作不是隐藏功能 | `settings-outer.test.ts:54` 与 core guard：正文/文件可读且无 Save/Delete，返回先关 Sheet | 未测 | 未测 | 未测 |
| 支持文件独立 Sheet 与错误可见 | `settings-skill-files.tsx:56-65` 使用 NSH Sheet、内部 Scroll、内部错误反馈、Cancel；系统 back 不再直接退出 Skill | 只读 supporting-file Sheet 的 back 返回原 Skill 通过；可写文件 CRUD 尚未本轮引擎测试 | 未测 | 未测 | 未测 |
| Provider 模型加减/移除全部/撤销/过滤 | `settings-providers.tsx:20-45,104-113` 与 `settings-protocol.ts:36-44` 写当前 Host `hiddenModels`（Native/Web picker 共用），不再只有 model editor；只提交该 preference，保留其他 Provider | `settings-outer.test.ts:107`：409 不假移除、重试变＋、重开仍＋、再添加；3 项纯逻辑校验 malformed/不覆盖/去重 | 未测 | 未测 | 未测 |
| Provider model editor Sheet | `settings-providers.tsx:53-70,116-129` 原生 Sheet、取消丢弃未保存修改；失败留在 Sheet 且错误可见；保存后重读权威 catalog，失败不清旧 catalog | `settings-outer.test.ts:89,131`：back 只关 Sheet；409 留草稿；重试后 catalog/重开一致 | 未测 | 未测 | 未测 |
| 通知 focused 语义 | `settings-basics.tsx:67,184-185` 将 `notificationMode` 真实映射为 Switch：on=always，off=hidden-only，不再用“关闭”选项冒充整个通知关闭；通用布尔用 `settings-controls.tsx:19-20` Switch role | `settings-outer.test.ts:72`：开关来回保存，fixture 断言不改 nativeNotificationsEnabled | 未测 | 未测 | 未测 |
| Behavior 部分提交恢复 | `settings-basics.tsx:150-158` AGENTS.md PUT 一旦成功立即 checkpoint，后续 config PUT 失败只重试 config，不重复文档写入 | `settings-outer.test.ts:35`：文档已写、config 409、保留草稿、重试、重开；fixture 强制文档写入次数=1 | 未测 | 未测 | 未测 |
| Summary AI 选择生效的 mode | `settings-basics.tsx:144` 在 provider/model ID 有修改时同写 `summaryModelMode: 'provider'`，不重写未改提示词 | `settings-outer.test.ts:155`：disabled→provider，ID重读保留且不提交未改 commit prompt | 未测 | 未测 | 未测 |
| 现有 Magic Prompts 闭环 | `settings-magic-prompts.tsx:10`、`settings-magic-state.ts:62` 继续保持现有实现，未重写 | `settings-ui.test.ts:36-91` 加 `settings-magic.test.ts` 全部通过，覆盖所有组默认值、失败重试、单项/全部 reset | 未测 | 未测 | 未测 |

### 与当前 Web 的具体对照

- 项目：`packages/ui/src/components/sections/projects/ProjectsPage.tsx:32-40` 保存的五个 identity 字段，`ProjectSettingsPanel.tsx:55-57` 还包含 actions/worktrees；`useProjectIdentityForm.ts:8-18,186-235` 的 label trim、背景色校验及继承模型语义。Native 本轮只关闭 identity 的部分缺口，**没有**据此声称 actions/worktrees/自定义图像已迁移。
- Provider：`packages/ui/src/components/sections/providers/ProvidersPage.tsx:575-579,659-727` 及 `ProviderModelRow.tsx:44-47` 的 added/hiddenModels、搜索、移除/撤销与加减动作。Native 复用该 Host preference，不引入新的平行隐藏状态。
- Skill：`packages/ui/src/components/sections/skills/SkillsPage.tsx:130-133,514,598,641,657,690` 明确 built-in 只读且可查看；不允许把 Native 原先的可写按钮当作功能更多。
- 通知：`packages/ui/src/components/sections/yuri/NotificationSettings.tsx:497-504` 的 focused toggle 是 always/hidden-only；Native 通知权限、APNs 与聚焦规则仍需独立实现和验收。
- Summary：`packages/ui/src/components/sections/yuri/SummarySettings.tsx:91-99` 同时写 mode/provider/model；Native 原先缺 mode，本轮已补。未运行其 testConnection，因为会调用模型。
- Settings 入口：`packages/ui/src/mobile/settings/MobileSettingsTab.tsx:27-37` 与 `lib/settings/metadata.ts:84-106`；Native 保留 21 个实际手机入口，不扩成桌面页面白名单。

## 全部 21 页仍需明确保留的状态与缺口

下表 C 是代码接线的有限结论；F 只指本轮运行覆盖，不能继承历史报告的“通过”。H/S/D 每项仍未测。

| 当前手机设置页 | C（当前 Native） | F | H | S | D | 未完成（仍在 scope） |
| --- | --- | --- | --- | --- | --- | --- |
| instances | 部分；`settings-basics.tsx:171-174` 新增/选择/删除 | 未测 | 未测 | 未测 | 未测 | 重命名/编辑连接、历史/welcome优先级与原生桥扩展 |
| appearance | 第二轮改由 `settings-preferences.tsx` 拥有；明暗/主题/语言及真实Host字段见文末 | 纯合同测试通过；新增UI未执行 | 未测 | 未测 | 未测 | Native布局/字体安装、浏览器本地字段的Native合同、完整视觉1:1仍未完成 |
| chat | 第二轮改由 `settings-preferences.tsx` 拥有；transport/diff/Goal/title/委派等真实Host字段见文末 | 纯合同测试通过；新增UI未执行 | 未测 | 未测 | 未测 | 多项Native消费者尚未接线，不能把Host保存称为Native生效 |
| notifications | 部分；`settings-basics.tsx:65-75,186` 事件与模板，已修focused | focused fixture通过 | 未测 | 未测 | 未测 | 权限申请、系统通知/APNs、点击导航、Web/native聚焦差异；不能把保存开关称为通知实现 |
| sessions | 第二轮 `settings-defaults.tsx` 已补权威model/Agent/variant；Basics保留独立清理表单 | 选择/可见性/范围/失败纯合同通过；新增UI未执行 | 未测 | 未测 | 未测 | CLI、browser provider、passkey、清理Native执行者、默认值实际新建会话生效 |
| archived-sessions | 部分；`settings-archive.tsx:10-66` 目录/分页/预览/恢复 | archive过滤纯逻辑通过，页面未测 | 未测 | 未测 | 未测 | restore后的首页同步、完整消息/资源预览与真实游标 |
| summary-ai | 第二轮 `settings-defaults.tsx` 已补权威picker、默认prompt/重置、独立保存与显式测试入口 | prompt逐字对照/选择/失败纯合同通过；新版UI未执行 | 未测 | 未测 | 未测 | picker完整视觉/收藏最近、UIKit长文与离页dirty；显式模型测试未执行 |
| projects | 部分；`settings-projects.tsx:15-91` identity编辑、选择目录模型 | 列表/保存/409/返回/重读通过 | 未测 | 未测 | 未测 | 自定义图像上传/预览/删除/发现、actions、完整worktree设置；color目前仍是wire标识选择，背景为hex输入，不是Web完整picker |
| git | 部分；`settings-git.tsx:19-74` identities/default/basic prefs | 未测 | 未测 | 未测 | 未测 | GitHub授权、identity图标/credential安全输入、更多Git配置与父列表刷新专项 |
| providers | 部分；`settings-providers.tsx:14-130` custom/model/auth，加减/Sheet已补 | model偏好与editor fixture、协议纯逻辑通过 | 未测 | 未测 | 未测 | Provider/Model品牌Logo和能力信息、编辑既有custom provider、来源/配置高级行为、所有OAuth方式、custom新增后父目录刷新；删除按钮当前是删除auth，不能当成移除custom配置 |
| agents | 部分；`settings-collections.tsx:131-139` 与 `settings-permissions.tsx:8-20` | collection协议/字段纯逻辑通过 | 未测 | 未测 | 未测 | 高级字段、权威model/variant picker、SavedPermissions与built-in Agent覆盖/删除语义 |
| assistants | main已接 `AssistantSettings` 真实路由；本线只读核对application分支，不修改 | 本线未测 | 未测 | 未测 | 未测 | 头像/渠道/关联计划仍由对应owner交付与验收，不再把onAssistants列作阻塞 |
| behavior | 部分；`settings-basics.tsx:77-81,150-159,179` 文档/preset/custom | 部分提交重试通过 | 未测 | 未测 | 未测 | 字段条件/实际模型指令生效、完整取消/离页dirty处理 |
| commands | 部分；`settings-collections.tsx:140` scope/description/Agent/model/template | 原生编辑409/重试/返回刷新通过 | 未测 | 未测 | 未测 | 权威selector、全部内置命令只读/删除/重命名/duplicate语义 |
| mcp | 部分；`settings-collections.tsx:142-148`、`settings-mcp-live.tsx:10-25` 配置/连接/auth | 协议构造纯逻辑通过 | 未测 | 未测 | 未测 | JSON导入、完整OAuth/command auth/UI、异常status与回会话tools收敛 |
| plugins | 部分；`settings-collections.tsx:149-150` entry/file/options | options保持纯逻辑通过 | 未测 | 未测 | 未测 | 启停/更新/卸载/reload诊断、贡献settings/GUI运行与权限；不能声称Solid/DOM原生兼容 |
| magic-prompts | 部分；`settings-magic-prompts.tsx:10` 完整组/双block/reset | 本轮所有默认组与重试/reset通过 | 未测 | 未测 | 未测 | 真实Host并发、离页dirty、UIKit长文/键盘验收 |
| skills.installed | 部分；`settings-collections.tsx:141` 与 `settings-skill-files.tsx:9-65`，本轮补built-in只读 | built-in/文件可读与Sheet返回通过 | 未测 | 未测 | 未测 | catalog/安装来源、rename/duplicate、Markdown编辑/预览、可写支持文件CRUD专项 |
| usage | 部分；`settings-usage.tsx:12-67` quota、局部失败、header prefs | 未测 | 未测 | 未测 | 未测 | provider families/模型选择、完整配额显示与返回选择保留 |
| voice | 部分；`settings-basics.tsx:82-110` 现有配置字段 | 未测 | 未测 | 未测 | 未测 | provider条件分组/数值边界、local模型状态下载删除、预览/voice mode、权限及运行时差异；系统听写不能代替 |
| about | 部分；`settings-basics.tsx:124,175` 仅Host system/info | 未测 | 未测 | 未测 | 未测 | client/Host/OpenCode三版本、诊断导出、Host升级/客户端更新/频道/回退；无版本不能冒填 |

跨页未完成：第二轮已补89个字段/静态目标搜索与测量滚动/高亮；其余页面和动态编辑器准备流程尚未全覆盖。普通表单的 dirty 离页确认、所有二级/Sheet的 UIKit键盘/手势、长路径/动态字号、全语言与明暗/降低透明度均未签收。没有把这些缺口改为“非 MVP”。

## main 接线与协作报告

1. 保留现有 `Route { kind: 'settings'; route: SettingsRoute }`；Projects 设置现在由 `SettingsPage` 直接呈现真实列表/详情，`onOpen({ page: 'projects', entity: project.id })` 已可落到编辑器，不应重定向到 Projects Tab。
2. SettingsPage 自己提供系统 `NavPage` 与 `headerBackTitle=""`，外层不要再套一份标题/自绘 back。Home根 `NavPage` 的 `headerBackTitle=""` 由 main 设置。
3. **onAssistants已由main接通**：application对 `route.route.page === 'assistants'` 直接渲染 `AssistantSettings`，不再把它当作未接线项。
4. `onAppearanceChange` 只是兼容回调；明暗仍使用现有 Host canonical appearance，不写本地平行主题状态。未改 appearance owner。
5. 项目 metadata成功后通过 `app.projects` 发布确认证据；新建会话是否消费 project.defaultModel 仍在 state/createSession owner，不能仅凭本轮保存测试宣称生效。
6. Projects、Bots/计划没有本线下层结果：无法派发工具，故本线不创建它们的 `OUTER-...-VALIDATION.md`，也不签署它们的 C/F。

## 实际命令与红绿证据

运行均从仓库根，`NSH_BIN` 指向 main 提供的 NSH 0.4 分发；未触碰 `.nsh/out`、未构建 iOS、未 headless App.tsx。

```sh
NSH_BIN="$NSH_BIN" bunx --package vitest@4.1.11 vitest run \
  --config packages/nsh/vitest.config.ts \
  packages/nsh/settings-outer.test.ts packages/nsh/settings-ui.test.ts \
  packages/nsh/settings-projects-core.test.ts packages/nsh/settings-protocol.test.ts \
  packages/nsh/settings-magic.test.ts
```

- 首轮 `settings-outer.test.ts`：**3/3 红**。项目只有无回调按钮；Behavior缺可寻址字段；built-in Skill实际暴露Save/Delete。
- 后续移除测试中的手动Refresh：项目/命令返回列表两项 **红**，实测仍显示旧值；加局部revision后转绿。
- 最终 13:51:52 开始的运行：**5 files / 46 tests 全绿，28.87s**。其中 `settings-outer.test.ts` 有8项 Native引擎交互；`settings-ui.test.ts` 有3项既有Settings/Magic交互。其余为纯逻辑。fixtureHost全部是本目录专用固定数据，没有真实配置/凭据/模型调用。此轮结束后 main 收紧规则：NSH CLI fixture 也会把 `com.longbridge.nsh.host` 切前台，因此本线不再运行任何NSH引擎/UI测试，后续由main统一串行跑。
- `bash .agents/skills/settings-ui-patterns/scripts/audit-settings-ui.sh` 对7个改动TSX通过。它不证明Native视觉等同Web。
- `bun run dead-code` 最终已运行，exit 0但有大量非阻断报告；本线新增 `settings-outer-test-app.tsx` 被列unused，是CLI字符串入口，不能因此删除。`settings-projects.tsx/core` 及新增Provider helper在实际生产/测试调用，不是孤立实现。未修改全仓库Knip配置。
- `bunx tsc --noEmit --project packages/nsh/tsconfig.json` 13:34/13:36通过；13:39/13:45被并发新增的Web类型导入链阻断，具体为desktop.ts globals、i18n/context.tsx JSX/React、runtime-url.ts URLSearchParams.entries。定位报告交main后，**13:51:52这轮最终tsc exit 0，无输出**。这是类型检查绿，不代替生产Native运行/平台验收；本线未再运行 `nsh:check`。

### 编译边界定位（已向 main 报告，未越界修改）

`tsc --explainFiles` 明确给出：

```text
chat-changes-workspace.tsx
  → ui/components/views/git/changesTree.ts
  → ui/lib/api/types.ts
  → ui/lib/draftStarters.ts
  → ui/lib/i18n/index.ts
  → i18n/context.tsx → desktopNative.ts → desktop.ts
  → runtime-switch/runtime-tunnel → relay/tunnel-client.ts
```

即使上游是type import，TypeScript仍解析这条模块链。应由对应owner拆成纯结构类型/纯计算模块，而不是给Native塞React或Window声明压错误。本轮Settings新增模块只引入本地Native和纯core；没有引入`projectMeta.ts`、`api/types.ts`、`lib/i18n`等Web运行时barrel。已有Web调用协议通过Native request窄边界保留。

## 仍待平台验收的最小矩阵

- H：专用Host上项目metadata和Provider hiddenModels分别读写/重开；两个Host同ID隔离；直连/授权Relay；设置保存失败/409/断网和部分提交恢复。
- S：每个设置根→集合→详情→Sheet的系统back优先级、交互返回取消、Sheet高度/键盘、长表单滚动、动态字号、亮暗与语义颜色。
- D：通知权限/点击导航、输入法、真实外部OAuth返回、Keychain连接变化；所有未实现桥必须逐项实现，不能用保存字段冒充系统能力。

**结论：本轮关闭了一批真实Settings行为缺口，F有可重复证据；21页全量1:1与H/S/D尚未完成。**

## 第二轮继续实施（15:00后，未结项）

本轮只修改 `settings*.ts*`、Settings独占fixture和本报告。未运行任何NSH引擎/UI Vitest、`nsh test`、iOS构建、模拟器、浏览器、设备、真实Host、git或GitHub命令；没有新增依赖。工具检索仍没有派发/下层会话消息接口，未声称已派general。

### 已实现的可核对增量

| 内容 | 实际实现及边界 |
| --- | --- |
| 纯字段合同 | `settings-preferences-core.ts` 列出30个Appearance/Chat当前字段/静态动作：21个确实被Host sanitizer/formatter接受；9个browser-local或无Host动作合同明确不可PUT，不用假保存冒充。枚举、字体ID、数值边界、整数化及PWA名归一化在提交前验证。 |
| Appearance | `settings-preferences.tsx` 保留Host canonical mode/本地语言；新增light/dark主题选择、Host自定义主题读取/重载、monoFont、fontSize、terminalFontSize、padding、inputBarOffset、time/week、PWA name/orientation、mobileKeyboardMode、reportUsage。数值/代码字体有reset。sidebar品牌、iOS Web体验开关、本地cache等没有Native合同，明确不可用、不造假动作。未显示手机Web本来隐藏的uiFont/terminal quick keys、桌面vibrancy、Dock。 |
| 保存与消费者刷新 | Appearance/Chat PUT只提交修改字段；409保留草稿；成功checkpoint后GET确认，再调用既有 `refreshNativeAppearance()`。回读失败不清旧快照、不自动重放已提交PUT；Native刷新自己的错误单独可见，不能由Saved提示冒充成功。 |
| Chat | 增加messageStreamTransport、diffLayoutPreference（真实wire为dynamic/inline/side-by-side）、sessionGoalEnabled、sessionTitleRefreshEnabled、questionAutoDelegateEnabled；保留render/reasoning/thinking/TPS/followup。所有未接Native消费者项都有明确不可用标识，保存按钮注明Host。手机Web隐藏的inline actions和spellcheck未添加。以 `YuriPage.tsx` 的实际visibleSettings白名单为准：codeBlockLineWrap/showSubagentTaskDetails不是当前Chat页控件，未复制成新表单；Host既有值不删除。 |
| Sessions | `settings-defaults.tsx` 用权威目录替换defaultModel/defaultAgent/defaultVariant自由文本；换model原子写 `{defaultModel,defaultVariant:''}`；variant只取所选模型variants；清空用空串；Agent复用Web `filterVisibleAgents`语义（顶层hidden或options.hidden排除，**不排除可见subagent**）。 |
| Summary | 同模块使用**location-less** catalog。model提交mode/provider/model完整三元组；prompt独立草稿/保存，不随model选择重写。两份默认prompt与Web按字节核对；空prompt不被错误换成default。单项reset只改草稿，保存后生效。显式test按钮只在用户按下时POST `/api/small-model/test`，本轮没有按下或调用。 |
| 失败隔离 | models和Agents分别处理allSettled结果；一个目录失败不清除另一个有效目录；失败保留旧列表及显式重试，旧ID展示为不可用而非擅自选第一项。目录刷新重新读取Host模型偏好，保留hiddenModels与providerOrder合同。 |
| 字段搜索 | `settings-search-core.ts` + `settings-basics-core.ts` 统一89个静态字段/目标，覆盖appearance/chat/sessions/summary/notifications/behavior/voice。根搜索同时匹配本地化标签、技术键与关键字。每项携带稳定target；`SettingsTarget`是实际字段owner，原生onLayout后measure字段与Scroll根坐标，考虑当前offset，仅滚动一次并高亮；**不重排控件、不估算行高、不自动触发模型调用或更改配置**。 |
| 旧假保存纠正 | 除9个local/无Host动作合同外，Sessions的sessionRetentionAction也不在Host sanitizer内；旧可编辑但无效PUT已改为明确不可用。保留该范围，不标作MVP外。autoDeleteAfterDays新增1–365边界。 |

### main生产接线合同（仍由main独占修改）

1. `SettingsRoute` 只兼容新增 `target?: string`，现有page/entity/create不变。application当前的 `<SettingsPage {...settingsCallbacks} {...route.route} />` 已会透传target，无需本线改application。不要仅提取page丢掉target。
2. `SettingsPage` 保持自带系统NavPage/headerBackTitle=""。Appearance/Chat自动路由到新模块，Sessions/Summary在Basics中挂新Defaults模块，无新root callback要求。
3. Sessions catalog沿用现有可选 `directory`；Summary强制location-less。若生产设置入口有明确工作目录，main应把同一目录传入 `SettingsPage`（目前application通用分支没有directory prop）；**不能硬取第一个项目代替当前上下文**。无明确目录时location-less是显式行为。
4. Native后续消费者可扩展现有单根appearance/settings快照；本线保存后已统一触发 `refreshNativeAppearance()`，不要另加Settings局部平行状态或每条消息GET。

### 逐字段消费者证据与未接合同

“Host已接受”与“Native已经消费”分开记录；后者必须由owning owner完成和平台验证。

| 字段 | 当前权威消费者/缺口 | main后续合同 |
| --- | --- | --- |
| useSystemTheme/themeVariant/themeId/lightThemeId/darkThemeId | `appearance-core.ts` canonical theme解析；`appearance.tsx`单根应用 | 主题选中后的UIKit token/字体取证仍待main；自定义主题坏响应不清旧catalog |
| fontSize/monoFont/timeFormatPreference | appearance单根字号/字体、transcript时间消费者已存在 | 某些Host字体未安装时由appearance已有unsupported-font/error明确处理，不偷偷换字体称等同 |
| chatRenderMode/showReasoningTraces | appearance-core映射、transcript-body已有消费者 | main串行验收真实切换后的正文/Activity；不能只依据保存或静态类型 |
| sessionTitleRefreshEnabled | **Host真实消费者** `packages/web/server/lib/session-title/runtime.js` | 服务端自动标题；Native返回/重连仍需显示权威title事件，不用Native自建标题循环 |
| questionAutoDelegateEnabled | **Host真实消费者** `feature-routes-runtime.js:onSettingsPersisted` → `questionAutoDelegateRuntime.applyEnabled` | 不标作“仅存无消费”；Native问答/权限表现由对应owner验收 |
| terminalFontSize/padding/inputBarOffset/weekStartPreference | Host可存；Native当前没有相应字段消费者证据 | 扩展真实terminal/layout/日历等owner；每项未接前保持Native不可用标识 |
| messageStreamTransport | Host可存；Native传输固定策略未消费该偏好 | runtime/Swift owner消费auto/ws/sse（auto真实fallback）；不得只更新UI标签 |
| diffLayoutPreference | 现已通过唯一 device-local owner 接真实 Settings/工作台 Diff，不发 Host PUT；mobile 仍 unavailable | root registration/close 接线及 API ACK、真实磁盘/多 Engine 的未验边界见 `desktop-diff-preferences-DOCUMENTATION.md` |
| sessionGoalEnabled/followUpBehavior/showAssistantTps/collapsibleThinkingBlocks | Host可存；本线核对未发现对应Native偏好消费者 | 分别接Goal入口/发送delivery/真实TPS及折叠详情；不能删除这些范围 |
| pwaAppName/pwaOrientation/mobileKeyboardMode | Host真实浏览器偏好；不是UIKit安装包/键盘API | 本页明确Host保存与Native不可用；不要把PWA orientation误改为iOS系统旋转控制 |
| codeFontSize/editorFontSize | **不在Host GET/PUT合同**；Native共用device-appearance-v1设备singleton与串行lane，Prefs已接本机保存/Reset/失败恢复 | code消费者保持原合同；editor仅接Skills instructions/supporting-file两个原Input（9–32pt、默认13、round/clamp、行高1.5），metadata为skills-editor。实际移动FilesSurface只读，桌面FilesEditor/Vim不是mobile缺口；UIKit焦点/选区/IME未验。禁止Host PUT/receipt，旧记录成功读后补缺失本机默认，三键保存互保 |
| fileEditorKeymap | **不在Host GET/PUT合同**；device-appearance-v1本机枚举，Default/Vim两项Radio与本机保存/重开恢复已接，metadata为device-preference | 与真实移动共享设置一致，消费者仅桌面FilesView；手机只读预览无视觉效果，不新增Native Vim/编辑菜单/文件写入。三键串行互保、dirty CAS及失败恢复不清Host unknown receipt |
| allowPromptingSubagentSessions/persistChatDraft | **不在Host GET/PUT合同**，Web本地偏好 | Native各自设备偏好owner/消费者由对应合同记录，禁止虚假Host PUT |
| sidebarBrandName/iosNativeUiEnabled/transcriptCache | Web本地品牌/Capacitor体验开关/浏览器缓存动作，没有Host PUT合同 | Native分别需要品牌owner、明确平台行为和本地cache清理owner；不能把永远Native的App伪装成可切Web体验，也不能用清Host历史替代清本地cache |
| reportUsage | Host可存；Native没有上报器消费者证据 | 仅保存偏好，不启动任何未获明确用户同意的上报；Native reporter owner后续遵守该开关 |
| collapsibleUserMessages | Native渲染已读appearance同名字段，但**当前Host sanitizer丢弃** | main/owner解决Native设备偏好或正式Host合同后接；不得再提交无效PUT并显示Saved |
| defaultModel/defaultAgent/defaultVariant | Host真实持久化，当前Native新建会话未读默认值的消费者证据 | new-session/state owner在无显式选择时按权威默认应用；保留project覆盖/显式选择优先级，不影响已存在会话；Host切换不串值 |
| summaryModelMode/provider/model + 两prompt | Host LLM gateway与session-title真实读取 | Commit/Summary触发消费者由main对应owner核对；本线没有为了验收调用模型 |
| sessionRetentionAction | Web local、Host不存 | Native cleanup owner定义archive/delete真实执行与失败恢复；字段暂明确不可用，不能伪装已接 |

本轮没有新增i18n key：所有标签、reset、反馈和状态提示复用当前十语词典，纯测试核对新增字段/枚举的十语键均存在。没有修改locales或私建语言fallback。

### 第二轮实际验证（与第一轮46项分开）

仅运行：

```sh
bunx vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/settings-defaults-core.test.ts packages/nsh/settings-preferences-core.test.ts \
  packages/nsh/settings-search-core.test.ts packages/nsh/settings-projects-core.test.ts \
  packages/nsh/settings-protocol.test.ts packages/nsh/settings-magic.test.ts
bunx tsc --noEmit --project packages/nsh/tsconfig.json
node --check packages/nsh/tests/settings-outer-host.js
```

- 15:06:21最终纯测试：**6 files / 64 tests通过，615ms**；没有import或spawn NSH engine。第一次新增测试曾抓出collapsibleUserMessages会被Host丢弃（真实红），修正为不可用合同后绿。不是把失败测试删掉来宣称Host已支持。
- 同轮tsc **exit 2**：`application.tsx:458` 把 `kind:'changes'` 传入不包含该成员的Route类型，以及 `features-cron.ts:28` 的递归 `cronFailureText` 缺返回类型。本线Settings文件无诊断；未越界修改main/其他owner独占文件，不能把本轮全包tsc写绿。此前短时出现的chat-goal/chat-tasks/new-session类型诊断已不在这次输出中。
- Settings UI静态audit：新改6个TSX全部通过。此检查不证明视觉/键盘/系统手势。
- `bun run dead-code` 已运行，exit 0、非阻断报告已检查，并在最终通过rg聚焦Settings重跑：仅Settings CLI fixtures字符串入口unused和原有settingsField导出；新增模块/导出没有unused命中。新增两个仅用于推导的type export已收为模块私有。未修改Knip配置或删除他人文件。
- `settings-outer.test.ts` 原Summary用例已按真实picker改写；新增Appearance409/回读、字段搜索下钻、Sessions model/variant/Agent共3个定义；fixture Host补相应固定响应。**全部交main串行运行，本线未执行，不能沿用第一轮46绿。** fixture语法检查通过。

### 全量仍未交付的范围

21页范围完整保留，前表未被本轮明确关闭的缺口继续有效。尤其：Appearance/Chat未接消费者、browser-local偏好的Native owner、Settings所有实体页/弹层准备及字段搜索、picker收藏/最近/能力/品牌完整视觉、离页dirty、Sessions browser provider/CLI/passkey、项目actions/worktrees/custom image、Provider完整编辑/OAuth、Agent高级权限、MCP导入、插件安装/权限/运行、Skill完整文件操作、Usage与Voice完整运行时、About诊断/更新，以及全套H/S/D。

**当前结论：继续实施中，不结项。新增可运行代码和纯合同已交给main；Native消费者与串行引擎/UIKit验收没有被“Host能存”替代。**

## main真实引擎红灯后的修复（15:11，等待main复验）

### 真实失败来源与诊断边界

main已经实际运行并报告以下红灯，这些是当前真实引擎结论，**此前64项pure通过不能覆盖它们**：

1. `appearance-settings.test.ts` 的实际fixture仍调用公开 `SettingsBasics page="appearance"`，但第二轮将该页移出Basics后没有保留转发，显示Not available且Dark picker消失。
2. `settings-outer.test.ts` 的Summary与Sessions默认模型流程在 `id:settings-defaults-model` 上报not pressable；屏幕可见字段，不代表该ID是trigger，也不代表catalog已加载完成。

本线遵守禁令，没有运行原始engine loop，也没有NSH/iOS构建、设备或浏览器操作。仅以main提供的真实红灯为起点，读取安装版 `.nsh/types/nsh/base.d.ts:4319-4403`，并用Context7核对Select/trigger/testID文档；最新文档中的callback简写不覆盖安装版 `{open,reason}` / `{value}` 合同。

### 修复与保持的验收点

- `settings-basics.tsx`：在建立Basics生命周期/表单之前，把Appearance和Chat公开入口直接转发到同一个生产 `SettingsPreferences`。不另造表单、不出现嵌套Scroll，也不绕开Host canonical appearance。
- **保留原 `appearance-settings-test-app.tsx` 与 `appearance-settings.test.ts` 不改**：原来的Dark→失败保Dark→成功Light/旧Storage不覆盖/敏感错误不泄漏验收继续真实覆盖公开入口，没有通过迁fixture掩盖丢页。
- `settings-controls.tsx:SettingsChoice`：将原有稳定 `testID` 从Select组件外壳移到 `trigger={<View testID={props.testID}>...}`。Select继续唯一拥有原生打开/关闭、disabled、搜索与选择行为；没有给测试加旁路onPress，也没有删除模型选择步骤。
- `settings-outer.test.ts`：Summary和Sessions仍按 `id:settings-defaults-model` 点击，现在指向实际trigger；在点击model/variant/Agent之前等待 `app.enabled(...)`，不是用固定sleep掩盖catalog加载。完整model/variant/Agent写入、Summary mode及不覆盖prompt验收全部保留。
- 新增纯 `settings-entrypoints.test.ts`：两项**结构**回归测试在修复前真实红（缺转发、ID位于Select host），修复后绿；这不是原生pressability证据。
- 同文件另两项直接使用**与engine完全相同的** `tests/settings-outer-host.js:createHost()`，通过注入的runtime.request传输读取Summary location-less catalog及Sessions directory catalog/Agents，选择并写回真实fixture模型。两条目录协议在修复前已经通过，故没有伪造新路由、放宽directory或用空列表绕过。模型返回 `fixture/model`，variant为high，可见Agent含visible-subagent，options.hidden仍排除。

### 本线实际验证

```sh
# 纯测试；不包含appearance-settings.test.ts、settings-outer.test.ts或任何engine文件。
bunx vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/settings-entrypoints.test.ts packages/nsh/settings-defaults-core.test.ts \
  packages/nsh/settings-preferences-core.test.ts packages/nsh/settings-search-core.test.ts \
  packages/nsh/settings-projects-core.test.ts packages/nsh/settings-protocol.test.ts \
  packages/nsh/settings-magic.test.ts
bunx tsc --noEmit --project packages/nsh/tsconfig.json
```

- 15:11:22：**7 files / 68项pure通过，742ms**。包括2项入口/trigger结构、2项真实fixture目录协议；不能据此声称引擎已绿。
- 同轮tsc **exit 0，无输出**；之前application/features-cron的其他owner诊断已不再出现，本线未越界修改它们。
- 两个修订TSX的Settings静态audit通过；dead-code重跑后Settings仍只有原CLI字符串fixture和既有settingsField命中，没有删除其他owner文件。
- 初次纯测试额外指定已移除的basic reporter导致启动失败；去掉该参数后获取到上述2红→修复后68绿。该启动失败不是业务红灯，不记作引擎执行。

### 必须由main串行执行的原始回归

main重跑 `appearance-settings.test.ts`、`settings-outer.test.ts`，必须实际完成Dark/Light切换及Summary/Sessions Select展开→真实目录行选择→Host写入/回读。**目前两组原始红灯尚未取得修复后的engine结果，状态保持待复验，不宣称“当前全部过”。**

上一节所有Native消费者字段列表和21页全量缺口继续保留；这次入口/trigger修复不代替任何消费者或平台验收。本线没有修改生产appearance模块、application、features、state、ios或locales。

### Main 原始回归复验

15:17 串行执行原 `appearance-settings.test.ts`、`settings-outer.test.ts`，同轮包含日期与header回归，总计4文件15项通过。Dark/失败保Dark/成功Light及Summary/Sessions的真实Select展开、目录选择、写入回读均已走完。此结果关闭上文的两组引擎红灯，不关闭尚未接通的 Native 消费者或任何 UIKit/真实Host/真机缺口。
