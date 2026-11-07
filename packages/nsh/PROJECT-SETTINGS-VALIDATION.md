# 项目 actions / worktree setup — 独占交付与验证

日期：2026-11-07。此记录只覆盖 `settings-projects.tsx` 与本轮新增的 `project-settings*` / `tests/project-settings-{host,runner}.js`。不代表整个 Projects 设置或 NSH 已完成手机 1:1，也不继承旧报告的运行结论。前轮 runner 修复没有修改生产实现；本轮按 main 的真实 engine 红灯修复生产 setup 输入身份与保存生命周期。生产 capability 和共享 parser 均未修改。

## C / F / H / S / D

| 范围 | C：当前代码 | F：本轮执行 | H / S / D |
| --- | --- | --- | --- |
| 项目设置列表与 identity | 保留既有入口与五个 identity 字段；模型目录改用所选项目的根路径，而非当前 Focus/worktree；identity PUT 后 GET 校验才发布 app.projects，回读失败只重试 GET | 既有 metadata helper 回归通过；新增 identity UI 未执行 | 全部未测 |
| actions | 添加、展开/收起、名称、多行命令、18 种同 Web 图标、原生图标 Sheet、自动打开 URL 与可选覆盖 URL、删除及删空；完整合法内容 450ms 自动保存，失败保留稿并给显式重试。本轮不改变 actions 的 busy/pending 锁定 | 纯合同与无 URL globals 的 VM Host 回归通过；main 前轮 engine 的 actions case 已绿，本轮未复跑 | 全部未测 |
| setup | 有序命令行添加/编辑/删除、末项删除后保留空行、过滤空白命令但保留有意义空格/多行；450ms 自动保存；等待策略切换立即保存；Git authority 为 false 时显示 Git-only，unknown/失败不冒充 false。行使用不持久化的稳定 ID，文本保存期间可编辑，旧回读不能覆盖后来草稿 | main 前轮 engine setup case 丢字失败；本轮 8 项输入纯回归通过，修复后 engine 待 main 复验；真实焦点与 IME 尚未证明 | 全部未测 |
| 失败/权威回读 | 读取失败不提供可写空配置；分区坏数据不阻塞另一区；写前重新读取并检测同区冲突；保留其他区草稿和 fresh 未知字段；ACK 后回读失败/未知写结果均先 reconcile，不重复已确认写入 | 409、503、unknown committed response、分区失败/重试、同文件串行、scope fence 通过 | 全部未测 |
| dirty back | `SettingsProjectsPage` 提供系统 NavPage 的 popOnBack/popOnSwipe guard，busy 不离页、dirty 明确确认；取消不丢稿；内容 Done 同样经过 guard。已只读核对 main 在公开 `SettingsPage` 的 projects early-return，无第二层 NavPage | fixture 经公开 `SettingsPage page="projects"`；保留原 entity、target/create 与故意不同的目录。main 前轮 actions case 已覆盖系统返回 Cancel/Discard；本轮未复跑 | 全部未测 |
| 多语言 | 全部复用既有字典，没有新增/修改 key、平行词典或英文 placeholder | 当前组件静态 key 与动态保存 key 在十语均有值 | 视觉/长文未测 |

- **F 最新实跑（16:47）：4 files / 64 tests 通过，2 个 opt-in engine tests 跳过。** 这些是纯 TS、生产 JSX 表达式的 VM 回归、真实 Bun Host bundle、内存 Host 和无 URL/require resolver 的 VM，不是 NSH 渲染验证。前轮 16:30 为 56 项通过。
- 全包 `tsc --noEmit -p packages/nsh/tsconfig.json` **本次失败**：输出为共享 Web `desktop.ts` 的 Window globals、React `i18n/context.tsx` JSX、OpenCode `client.ts` 的 ImportMeta/process、`persistence.ts` globals 和 `prompt-attachment-upload.ts` 隐式 any；没有本 scope 文件报错。前轮 16:30 的通过不能替代本次结果。本线没有修改其他 owner、仓库类型配置或测试排除项。
- 本轮另用 OS 临时配置检查真实 `project-settings.ts` 和新增输入测试，继承原配置，显式包含二者并启用现有 Node 类型和 JS fixture 类型推断，**通过**。最初直接继承 NSH 配置检查测试时缺 Node/JS 类型；补用已安装的真实类型后发现 fixture response 可能缺 status，已在独占测试增加真实数值检查。没有添加假声明，不代表全包 tsc 通过。
- Bun syntax bundle 通过：公开 SettingsPage 入口的独占 `project-settings-fixture.tsx`，150 modules / 5.47 MB，`nsh`/`nsh/*` external；不等于 NSH 字节码或引擎通过。早期尝试独占 NSH bundle 因 PATH 无 `nsh` 失败的记录不当作本次成功。
- Settings UI audit 本轮通过。`bun run dead-code` 本次重新完成并检查报告：字符串 CLI 入口 fixture 被列 unused，`SettingsProjects` 嵌入内容 export 被列提示；没有新输入 helper/export 提示。`SettingsProjectsPage` 已有公开生产调用。未为了消除报告而删除兼容入口或修改全仓库配置。
- 没有真实 Host/配置/Git mutation、action/setup 执行、NSH engine、设备/模拟器或生产 build，没有依赖/Git/GitHub/付费操作。工具检索没有 general/spawn/delegate 工具，未派发下层代理。

## 真实 Web 与协议依据

1. `ui/src/components/sections/projects/ProjectSettingsPanel.tsx` 同时挂载 identity、`ProjectActionsSection`、`WorktreeSectionContent`。
2. `ProjectActionsSection.tsx` 的实际手机字段：名称、command、icon、autoOpenUrl、openUrl；桌面 SSH forward 只在 desktop shell 出现，Native 不增加该选择器，但保存时保留既存 `desktopOpenSshForward` / platforms / 其他 action 元数据。Web 保存将 primaryActionId 清空，Native 同样移除 `projectActionsPrimaryId`。
3. `WorktreeSectionContent.tsx` 的 setup commands 与 wait 使用 `yuriConfig.ts`。名称/命令/URL 保存上限分别为 80 / 4000 / 2000；setup 只过滤纯空白，不随意 trim 命令。
4. **配置不在全局 `/api/config/settings`。** `yuriConfig.ts` 通过 Host `/api/fs/home` 找 home，按根项目路径调用共享 `createProjectIdFromPath`，文件为 `<Host home>/.config/yuri/projects/<path-derived-id>.json`，不能用注册目录 catalog ID 或当前 Focus/worktree ID 代替。
5. Native 沿用已有 `GET /api/fs/read?path=...&directory=<captured root>` 与 `POST /api/fs/write?directory=<captured root>`，body 为 `{ path, content }`；未虚构 project-actions/setup API。服务端实现见 `web/server/lib/fs/routes.js`；Native 既有 `RuntimeBridge.swift` 已支持 `/api/fs/read` 的 text/plain 响应。
6. 只有明确 canonical 404 才只读 legacy `<root>/.yuri/yuri.json`；打开设置不自动迁移、删除或改写项目仓库。显式保存写用户级新文件，保留 legacy 来源中的其他字段。403、500、畸形 JSON 不转成 missing/empty。
7. `project-settings.ts` 不导入 Web React/DOM 或浏览器 SDK。18 个图标 wire/artwork 是 native 窄常量，纯测试与当前 `PROJECT_ACTION_ICONS` 全量逐值对照，避免引入其 desktop type graph。
8. Context7 查询 `/longbridge/nsh` 的 dirty navigation，另核安装版 0.4 类型：`popOnBack` 为预先挂载的布尔，`AlertDialog.show` 返回 `.action`，Sheet 回调读 `.open`。
9. identity 回读按 `settings-normalization-runtime.js` 的真实规则核验：清空 icon/color/model 后可能省略字段，iconBackground 可保留 null；缺失与 null 仅在这些已允许的 identity 字段中按同一继承语义比较，不接受旧的非空值。

### 不能夸大的限制

- 文件协议没有 CAS / project-config 原子 field-patch API。当前实现做 fresh read、同区冲突检测、保留完整其他字段与权威回读，但不能声称能消除另一客户端或 scheduler 恰在读写窗口内并发修改同一文件的竞态。没有伪造 expectedRevision 或不存在的 endpoint。
- 本轮继续 actions/setup 合同，**没有补 Settings 中的完整 worktree 目录/删除 UI、identity 自定义图片**；工作树生命周期仍由既有 Projects owner 负责。这些在全量 1:1 验收中仍须列未完成，不能用本记录替代。
- dirty 时系统交互返回手势被禁止；点系统返回/Done 才出现确认。没有声称 swipe 过程中可以弹异步确认。
- 动态选中项目的 controls 没有另造搜索条目；搜索不能在没有确定项目时猜首项目或 current Focus。
- 此页保存 setup 配置不等于创建工作树时已经在 Native 执行了 setup/wait。实际执行链与 action 启停不在本次执行验证内。

## 公开页面 owner（main 已接入）

`SettingsProjects` 仍是兼容的嵌入内容。已只读核对 `settings.tsx`：main 在 `SettingsPage` 返回普通 NavPage **之前**完成以下生产分流：

```tsx
import { SettingsProjectsPage } from './settings-projects';

// 在 SettingsPage 的现有普通 NavPage 之前；保留所有 callbacks、entity、target、directory。
if (props.page === 'projects') return <SettingsProjectsPage {...props} />;
```

本线 fixture 调用公开 `SettingsPage page="projects"`，不再直接调用 `SettingsProjectsPage`。原 routing callbacks、entity 与 `/fixture/other-focus-worktree` 参数保留；engine 中仍从首页进入、编辑、权威回读、重开，并用系统 back 走 dirty Cancel→Discard。main 前轮 actions case 已运行通过；本轮仍保留该运行验收，不用源字符串断言替代。

## main 首次 engine 红灯与本次 runner 修复

- **main 实测（不是本线执行）**：首次开启 `NSH_PROJECT_SETTINGS_ENGINE=1` 的两项均在启动阶段失败，`--web-host tests/project-settings-host.js` 不加载其相对 `./new-session-request.js` import。前轮 VM 自带 module resolver，掩盖了这个交付边界，不能拿旧 VM 绿灯覆盖 main 红灯。
- **本线纯 repro**：将原始 Host transpile 成 CommonJS 后在没有 require 的 VM 执行，实跑得到 `TypeError: require is not a function`，对应同一个未打包依赖问题；没有运行 NSH。
- **修复**：新增 `tests/project-settings-runner.js`，按 Provider runner 的隔离模式，每个 case 都 `mkdtemp` 创建独立 OS 临时目录，先用 Bun browser ESM bundle 将真实 Host 和**共享** parser 打入绝对 `host.js`。不复制 parser，也不传原始有 import 的 Host 给 NSH。
- 同一临时目录生成独立 `App.tsx` 与 `nsh.json`；entry 只 import 原 fixture 的绝对路径，theme 指向原主题。NSH 在这个临时 cwd 启动，`--web-host` 传绝对 bundle 路径。每次 host 路径不同，隔离 headless Storage；构建失败、case 结束或断言失败均只清理本 case 自建目录。
- 独立 config 的 host allowlist **只有** `runtime.request` 与 `projectSettings.fixture.audit`，不把测试 audit 加入 `packages/nsh/nsh.json`。纯测试核对 production 配置前后逐字不变、无 audit 权限，以及临时 App/config/bundle 的路径和清理。
- fixture audit 只读，返回 writes/commits/rejectedRequests/递增 auditSequence 与配置摘要；拒绝额外 payload。engine 脚本对 ACK 后 503 的前后 writes/commits 做相等断言，证明 retry 只能回读。setup 最终核对真实命令数组和 wait=false；未知执行请求必拒绝并计入 audit，两个场景均要求 rejectedRequests=0，不执行任何 action/setup。
- 最新 VM 不再提供 module resolver：使用与 engine 完全相同的 runner/bundle，在 `URL`、`URLSearchParams` 和 require 全部不可用的上下文执行。逐 case 唯一路径、无外部 import、严格路由/方法/query/scope 与失败重试都保留；另测 callback 失败后的清理和 fixture-only audit 权限。
- 上述是 runner 阶段证据。main 随后实测该 runner 为 actions 绿、setup 红；本轮输入修复后的两项 engine 尚未运行。H/S/D 均未测。

## setup 丢字：真实失败、纯红绿与修复边界

- **main 实测（16:35，非本线执行）**：两项 engine 一绿一红，actions case 完整通过；setup 新行预期 `added fixture setup`，实际 `a`，audit 已保存 `commands: ["e", "fixture setup two"]`。已读 main 的完整输出，不能归因于 substring 断言。
- **证据**：安装版 NSH 0.4 `globals.d.ts` 与 Context7 的 Each 文档一致：缺省 key 对 primitive 按值；原生产 `Each of={commands}` 每次编辑都会改变字符串 key。`SettingsInput` 已转发完整 `e.value`，不在该共享 owner 改输入事件。另有 busy/pending 同时禁用输入、拒绝核心编辑的问题。
- **先红**：新增 `project-settings-input.test.ts`，修复前 4 项全部失败：实际生产 Each key 从原命令变成 `e`；保存 fresh read、write、read-back 三阶段均拒绝后来的完整值。
- **修复**：`commandIDs` 是表单本地的平行身份数组；production Each 明确按 ID 保留行，回调按 ID 定位，删除后迟到的旧 ID 回调无效。文本变化复用 IDs 引用；增删才改变结构，重复文本不合并身份，末项删除创建新空行身份。wire 仍为 `commands: string[]`，文件不写入 IDs。
- setup 文本输入在 save/pending 中保持可编辑；初次 load、未就绪或确认弹窗仍禁止编辑。结构按钮与 wait 开关保留既有 UI busy 锁定；actions 不解除锁定。核心提交前捕获 commands/wait/IDs/revision，旧回读仅确认提交快照；有后来稿时保留全文、保持 dirty、不得误报 Saved。ACK 后 503 的 retry 仍只回读；只有后来稿另一次保存才新增写入。
- **现绿**：8 项输入纯测试，包含实际生产 Each 的 of/key、Input 的 disabled/value/onChange 表达式、完整多字符与 Unicode/删除值、重复文本/邻项删除/旧回调、三阶段后来稿、wait/结构变更、ACK 失败后的新稿与 actions 继续锁定；加原合同共 64 项通过。旧 pending 测试改为接纳新稿，但保留“reconcile 后 writes 仍为 1、再保存新稿才为 2”的断言。
- engine 脚本保留全部原 `app.clear` / `app.type` 与失败/回读/删除/重开/audit 断言；新增首次编辑、添加后、删除邻行后及重开的完整字面量断言。未用 setvalue 绕过真实 onChange，也未删输入断言。
- **尚未证明**：稳定身份与纯回调测试不是原生焦点证明；Unicode/模拟组合值不是 IME composition。main 仍须串行复跑 engine，再单独验收 UIKit 的拼音候选/组合、光标/删除、连续输入跨慢保存和键盘焦点。本线没有启动 NSH、真实 Host、命令或设备。

## 纯验证与 main 串行 engine 入口

从仓库根运行，本轮实际执行的是：

```sh
NSH_PROJECT_SETTINGS_ENGINE=0 bunx vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/project-settings-input.test.ts \
  packages/nsh/project-settings.test.ts \
  packages/nsh/project-settings-host.test.ts \
  packages/nsh/settings-projects-core.test.ts \
  packages/nsh/project-settings-engine.test.ts
# 64 passed / 2 skipped；本轮显式 NSH_PROJECT_SETTINGS_ENGINE=0。

bunx tsc --noEmit -p packages/nsh/tsconfig.json
# 本次共享 Web 类型链失败；未改测试排除或添加假类型。

bash .agents/skills/settings-ui-patterns/scripts/audit-settings-ui.sh packages/nsh/settings-projects.tsx
bun run dead-code
```

本轮专属 tsc 使用临时配置继承 `packages/nsh/tsconfig.json`，显式包含 `project-settings.ts` 与 `project-settings-input.test.ts`，使用已安装 `@types/node`，`allowJs:true/checkJs:false` 以推断原 JS 内存 Host；没有改仓库配置或添加假类型。它只证明该 helper/回归依赖链，不代替上面的全包红灯。

**以下仅准备，交 main 在统一窗口串行执行，本线未运行：**

```sh
NSH_PROJECT_SETTINGS_ENGINE=1 NSH_BIN="$NSH_BIN" bunx vitest run \
  --config packages/nsh/vitest.config.ts packages/nsh/project-settings-engine.test.ts
```

- 入口：每 case 临时 `App.tsx` → `project-settings-fixture.tsx` → 公开 `SettingsPage page="projects"` → main 的生产 `SettingsProjectsPage` 分流 → `SettingsProjects`。
- Host 来源：`tests/project-settings-host.js`；runner 先 bundle 为该 case 唯一 OS 临时**绝对** `host.js`，再传 `--web-host`，不要手动改回源码路径。正确根为 `/fixture/root`，catalog ID 故意不同，传入 focus directory 故意是另一个 worktree，以检测 scope 偷换。
- 当前实际共享 parser 是 **`tests/new-session-request.js`**，不是不存在的 `new-session-path.js`。仅复用、不改该 owner 文件。没有 `URL` / `URLSearchParams`；VM 执行的是同一 standalone bundle，不提供 require/import resolver。未知 route、错 method、重复或畸形 query、错目录/文件、全 URL 都抛错，绝无 unknown-route 成功 fallback。
- 两个 engine 脚本分别覆盖 actions 的失败保稿/只读回读重试/重开/dirty Cancel→Discard，以及 setup 行编辑/添加/删除/等待策略/重开。main 的前轮 actions 已绿；本轮加强字面量后的 setup 与修复后的生产实现尚未在 NSH 验证。
- main 的 UIKit 验收还应覆盖：图标 Sheet 的 back 优先级、dirty 系统返回、两区同时 dirty 的串行保存、键盘滚动、长命令/路径、浅深色/动态字号与十语布局。H/S/D 均须另补证据。
