# NSH Settings collections：协议与验证交接

main 实跑追记：最新修订的 `settings-collections-engine.test.ts` 已实际在 NSH 执行，**4/4 通过**：Agent 回显与最小 patch、saved permissions 撤销、MCP 导入取消及完整 OAuth、插件错误/重载/原位更新。临时 fixture 独立授权 audit，没有扩大生产 capability。仍不是 UIKit、真实 Host 配置写入或真机结果。

本轮拥有 `settings-collections.tsx`、`settings-permissions.tsx`、新增 collection/plugin/saved-permission 适配、fixture/tests，以及十语字典中的 `settings.nsh.collections.importInvalid`；后续明确授权的共享变更仅为下列 framework-neutral type seam。未修改 application、settings.tsx、state、features、Provider、project、voice、iOS；没有新增依赖、执行 Git、访问真实 Host 或启动 NSH/UIKit。

## 生产接线与来源

- 现有 `SettingsCollection` 入口原位生效，无新增路由或第二套 settings 协议。继续经 `runtime.request` / Swift 认证边界调用现有 Host；已有 `settingsMutation` 仍唯一拥有集合 CRUD 白名单。
- Agent 编辑前调用 `GET /api/config/agents/:name/config?directory=…`。直接复用 Web `agentSaveConfig.ts` 的 `catalogModelSelection` / `readStoredSystem`；对象 model 保留 variant，prompt 优先于 system，文件引用 prompt 不伪装成已读取文件正文。禁用 Agent 的 metadata 缺 model 时可回显 stored string model。permissions 复用 `toPermissionRuleset`。更新只发真正变化的 native 字段；回退为初值的触碰字段不提交，显式清空 model/system/description 发 null。scope 是已有 mutation 的写入目标路由信息，不是从 catalog 批量覆盖 native 配置。
- Agent 列表挂载 `SettingsSavedPermissions`。先 `GET /api/location?location[directory]=…` 取得真实 project.id，再 `GET /api/permission/saved?projectID=…`；仅允许删除已加载的同 project rule，`DELETE /api/permission/saved/:id` 获确认后移除。无目录不读全局列表；失败保留快照，显示本地化错误及刷新重试。Host/generation 与捕获目录均须仍有效。
- MCP 新建页的独立 `SettingsMcpImport` 原生 Sheet 支持 JSON 导入草稿、解析失败、取消及剪贴板粘贴；外点/滑动/escape 均丢弃未应用的导入 source，延迟剪贴板结果不能覆盖后续输入或新一轮弹层。直接复用 Web `mcpImport.ts` 解析，不另写 parser；应用导入只改本地 form，只有原 Save 执行 Host 写入，导入/取消不会 connect。高级 OAuth 的 clientId/clientSecret/scope/redirectUri 均可回显、修改，secret 使用 masked 输入，不写本地 Storage 或日志；timeout 空值与导入 local 的清除使用既有 Host null 约定。
- Plugin 详情挂载独立 `SettingsPluginRuntime`。直接复用 Web `pluginLoadState.ts` 的目标解析、相对路径匹配、失败优先与更新标识；错误可展开/收起、复制完整正文、保留 ref。
- Plugin status 为 `GET /api/plugin?location[directory]=…`，check 为 `POST /api/plugin/check`（同 location query、空 JSON body），reload 为 **`POST /api/location/reload`，无 location/body**。没有把 GET 当 reload，也没有调用会重启 managed process 的 `/api/config/reload`。
- Plugin registry 使用现有 `GET /api/config/plugins/registry?specs=…&directory=…`。mutable target 调 `POST /api/plugin/update`，body 仅 `{targets:[原始 spec]}`；registry 明确提供另一版本时才 PATCH 既有 entry 的 `{spec}`，不改 options。registry 必须属于当前 target。确认写入后刷新失败不重放写入；reloadFailed 作为已写入 receipt 展示，保留手动 reload/read 恢复。runtime 操作期间阻止并行编辑保存/删除。
- routes/method/body 已核对当前安装的 `@opencode/client` 2.2.1 生成客户端、Web `permission-saved-api.ts` / `pluginMutations.ts` / `plugins.ts`、服务端 `config-entity-routes.js` / `plugin-routes.js`。Context7 及公开 client 文档仅补充核对，未访问运行中的 OpenAPI/Host。

## 已执行（不等于设备验收）

从仓库根运行以下 **纯测试**，不包含任何 engine 文件：

```sh
bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/settings-collections-core.test.ts packages/nsh/settings-saved-permissions-core.test.ts packages/nsh/settings-plugin-runtime-core.test.ts packages/nsh/settings-collections-locale.test.ts packages/nsh/settings-collections-fixture-host.test.ts packages/nsh/settings-collections-type-boundary.test.ts
```

已通过 **6 文件、41 项**；覆盖 model/variant、stored prompt/system、禁用 metadata fallback、最小 patch/清空/回退、MCP 导入四种真实结构及错误、saved permission scope/陈旧 Host/失败保留、plugin method/path/body/匹配/失败优先/registry 写入隔离、十语新增 key、fixture 禁止意外 connect/GET reload、独立 capability 配置，以及真实 TypeScript 依赖图没有 React/browser owner 的边界。

```sh
bash .agents/skills/settings-ui-patterns/scripts/audit-settings-ui.sh packages/nsh/settings-collections.tsx packages/nsh/settings-permissions.tsx packages/nsh/settings-plugin-runtime.tsx packages/nsh/settings-mcp-import.tsx
bun run dead-code
bunx tsc --noEmit -p packages/nsh/tsconfig.json
```

- settings audit 已通过（根 `scripts/audit-settings-ui.sh` 不存在，实际脚本位于 skill）。
- dead-code 已执行、退出 0；报告非空，包含仓库既有未用项/配置提示。本 scope 最终只报告独立 engine fixture 入口 `settings-collections-fixture.tsx` 为 unused（它由 engine CLI 字符串入口消费）；初次报告的自有多余导出已收窄。不能把非阻塞报告描述为零问题。
- `tsc` **已通过**。追加授权前 `--explainFiles` 确认两条污染路径：`mcpImport -> McpDraft/useMcpConfigStore -> stores/sync/i18n`，以及 `pluginLoadState` / Native 适配的 type import `-> plugins.ts -> opencodeClient`。抽取后再次运行 NSH 整包 `tsc --noEmit --explainFiles` 退出 0；解释图不再包含这些 browser owners。没有排除测试、使用 `as any`，也没有复制 MCP 算法。新增 pure boundary 测试直接使用同一 tsconfig 创建真实 Program，并验证零 browser/React/Zustand 依赖和零诊断。
- 仅以 Bun bundler 将 **本轮 fixture** 编译到批准临时目录，`nsh` / `nsh/*` external：通过。不是 NSH 字节码、生产 App、UIKit 或发布构建，也未执行 bundle。

## 已准备、严禁冒充已运行

```sh
NSH_BIN=/path/to/nsh bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/settings-collections-engine.test.ts
```

该文件会启动 NSH；本轮子代理按要求未运行。独立入口 `settings-collections-fixture.tsx` 挂载真实生产组件，只显式加载 `tests/settings-collections-host.js`。四个场景：Agent 回显和单字段保存、永久授权撤销失败/刷新/重试、MCP 错误/取消/只预填后显式保存、插件错误展开复制/GET 只读/POST reload/package update。fixture audit 只返回计数，不返回配置或凭据。未修改共用 settings host、其他 owner 的 engine 测试或生产桥。

main 首轮实测反馈为 **1 绿（saved permission）/3 红**；它不是此修订版的通过证据。针对反馈已做：

- runner 在唯一临时目录生成自己的 `nsh.json` / `App.tsx`，仅授权 `runtime.request`、`collections.fixture.audit` 与 clipboard；生产 `nsh.json` 未改。临时配置纯回归通过。
- JSON 计数和 multiline 片段使用 `app.waitUntil(() => app.texts().some(text => text.includes(...)))`，不再误用精确 text query。
- MCP 先等 Import 按钮真正 enabled，再 press 并明确等待 Sheet/Input；取消/应用后等待 Input 消失，没有加 sleep 或删除断言。原生产 Sheet 只有 maxHeight 却含 flex-1 Scroll，现给出由真实 viewport/safeArea/keyboard 约束的明确 height，避免 auto-height/flex 收缩。该布局风险与瞬时 disabled admission 均有针对性修订，但**根因与此修订是否解决 engine 失败仍待 main 串行复验，不能冒充已实证**。

当前工作树动态查找未发现 `tests/new-session-path.js` 或其他同名 path helper，因此 ownHost 内部使用严格纯字符串 path/query parser，并继续保留逐字完整 path＋method 白名单，不放宽 query 编码、顺序、projectID 或 directory。新增 Node VM 纯回归将 `URL` / `URLSearchParams` 置为 undefined，验证实际 fixture source 的初始路由、查询解析以及拒绝错目录/重复 key/异常编码/GET reload。**这是无 URL 的 VM 证据，不是 QuickJS 引擎能力证明。**

不要运行 NSH 整包 Vitest 来声称“纯测试”，因为配置也会匹配 engine 测试。

## C / F / H / S / D 未完项

这里显式定义证据层级，避免把一种证据冒充另一种：

| 层 | 当前证据 | 尚未完成 |
| --- | --- | --- |
| C（代码/协议） | 四项指定缺口已有生产接线，纯用例通过 | 全设置 1:1 仍非完成：Agent drop-confirmation/migration 确认、模型目录 picker/完整元信息、Plugin registry README/icon/GUI 权限和完整目录/批量更新仍未在本轮补齐；不把这些删除出范围 |
| F（fixture/流程） | 独立 engine fixture 与四条流程已准备；fixture host/临时配置纯测试通过；main 旧版 1 绿/3 红反馈已纳入修订 | 修订版尚未复验；NSH engine 的 Sheet 挂载、控件查询、剪贴板能力、交互顺序必须由 main 串行复验 |
| H（真实 Host） | 仅源码和安装包协议核对 | direct/Relay 的真实读取、目录切换、服务端拒绝/恢复、插件安装/watch/reload、MCP OAuth provider 均未联调；本轮无真实写入 |
| S（静态） | Native/Web 整包 typecheck、pure dependency graph、Native/Web focused Vitest、十语 key、audit 通过；dead-code 已检视 | 未做 NSH check/生产字节码 build；静态结果不证明 Sheet/QuickJS/UIKit 正确 |
| D（设备/设计） | 无 UIKit/设备证据 | 十语长文/键盘/安全输入、导入弹层、saved permissions 删除恢复、插件错误选择复制、Liquid Glass/视觉对帧与真实设备全部未验收 |

本轮没有可用的 general/子代理派发工具；已查询工具目录，因此未能做第二层只读核协议委派。以上缺口和限制应保留到主任务交付。

## 追加授权：纯类型 seam 与精确增量 allowlist

所有 shared 修改只涉及 import、type 定义原样搬移和 re-export；原有算法、请求与全部既有注释保留（Plugin source 注释随类型原样搬移）。两个新 type 文件只有 type/interface 声明，无任何 import、运行时值或框架依赖。原 `useMcpConfigStore` / `plugins.ts` 继续导出相同名称，既有 consumers 不需改 API。

**共享新增（3 文件）：**

```text
packages/ui/src/lib/mcp-config-types.ts
packages/ui/src/lib/opencode/plugin-runtime-types.ts
packages/ui/src/lib/settings-pure-types.test.ts
```

**共享修改（5 文件）：**

```text
packages/ui/src/stores/useMcpConfigStore.ts
packages/ui/src/components/sections/mcp/mcpImport.ts
packages/ui/src/lib/opencode/plugins.ts
packages/ui/src/components/sections/plugins/pluginLoadState.ts
packages/ui/src/stores/DOCUMENTATION.md
```

**自有新增（2 文件，前次业务交接之外）：**

```text
packages/nsh/settings-collections-type-boundary.test.ts
packages/nsh/tests/settings-collections-fixture-config.mjs
```

**自有修订（5 文件）：**

```text
packages/nsh/settings-plugin-runtime-core.ts
packages/nsh/settings-mcp-import.tsx
packages/nsh/settings-collections-engine.test.ts
packages/nsh/settings-collections-fixture-host.test.ts
packages/nsh/SETTINGS-COLLECTIONS-VALIDATION.md
```

Web focused **6 文件 / 33 项通过**，含类型 API 等价断言与原 parser/runtime/query 回归：

```sh
bunx vitest run --project @yuriai/ui packages/ui/src/lib/settings-pure-types.test.ts packages/ui/src/components/sections/mcp/mcpImport.test.ts packages/ui/src/components/sections/plugins/pluginLoadState.test.ts packages/ui/src/lib/opencode/plugins.test.ts packages/ui/src/queries/mcpQueries.test.ts packages/ui/src/queries/pluginRuntimeQuery.test.ts
bun run --cwd packages/ui type-check
bunx tsc --noEmit -p packages/nsh/tsconfig.json --explainFiles
```

上述 Web/Native types 已通过。focused ESLint 零 error；`pluginLoadState.ts` 保留两个既有手写路径规范化 warning，未越界改算法。dead-code 重新执行、退出 0，非空报告仍需按 workspace owner 分别解释。Vite focused 测试仍输出仓库现有 configLoader 提示，与本次 seam 无关。
