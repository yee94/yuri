# Native GitHub / discovered credentials 交接

## main 最小接入

本 owner 负责 `settings-github*.ts*`、`settings-git-credentials*.ts*`、GitHub owning server/types、正式十语 `settings.github.native.*` 及专属测试/fixture；不修改 `application.tsx`、`settings.tsx`、`settings-git.tsx`、RuntimeBridge 或其它 Swift owner。

在 `SettingsGit` **非编辑状态**的现有 Scroll 内装配（不新增 Scroll、NavPage、主 WebView）：

```tsx
import { SettingsGitHub } from './settings-github';
import { SettingsGitCredentials } from './settings-git-credentials';

<SettingsGitHub active={props.active} target={props.target} onReveal={navigation.reveal} />
// 现有 global / profiles 分组保留；随后挂发现凭据。
<SettingsGitCredentials active={props.active} target={props.target}
  onReveal={navigation.reveal} onSaved={() => { void load(); }} />
```

`active` 必须是实际最顶层 route active；组件另外检查 `lifecycle() === 'active'` 和 captured Host ID + epoch。GitHub 的 scope 在销毁后仅供同 Host lease cleanup 使用，controller disposed fence 禁止结果采用；换 Host 不发送旧 code。导入页使用 `settingsLifetime.current()`。失效后 main 应按新 Host generation 重新挂载，不能复用已失效 controller。覆盖页/后台暂停，不重发写入；恢复只 GET 并恢复仍有效的设备流程。导入页当前在同一 fragment 中打开，父级不要另开一个重复身份编辑器。

搜索 owner 将 `SettingsSearchItem.page` 扩展为 `git` 并注册两个 **纯 metadata** 条目：

| ID | title key | keywords |
| --- | --- | --- |
| `git.github-account` | `settings.github.page.oauth.title` | GitHub OAuth device account CLI 账户 授权 |
| `git.discovered-credentials` | `settings.gitIdentities.page.discoveredCredentials.title` | git credentials token import discovered 凭据 导入 |

组件也导出同名 `settingsGitHubSearchItem` / `settingsGitCredentialsSearchItem`。搜索核心不要为了 metadata 反向 import TSX/Native runtime，可复制表内纯记录；main 的 Scroll 用现有 `createSettingsTargetNavigation` 接 `onScroll` 和 `onReveal`。动态账户/凭据行不单独索引。`git.identities` 仍归既有身份 CRUD owner，不重复同一个 target。

## 真实协议与兼容合同

- Web：`packages/ui/src/components/sections/yuri/GitHubSettings.tsx`、`git-identities/GitPage.tsx`、`GitIdentityEditorDialog.tsx`。
- Host：`packages/web/server/lib/github/routes.js`、`github/auth.js`；Git：`git/routes.js`、`git/identity-storage.js`。
- GET `/api/github/auth/status`；POST `/auth/start` body `{}` → deviceCode/userCode/verificationUri/expiresIn/interval 及可选 `cancellable`；POST `/auth/complete` body `{deviceCode}`；pending/slow_down（+5 秒）/expired_token/access_denied 分开处理。
- POST `/api/github/auth/activate` body `{accountId}`；POST `/auth/gh-cli` body `{disabled}`。账户展示与确认身份是 **source + account id**，不是 login。切换 API 仍只接受 id：不同来源同 id 或 OAuth 使用保留 id `gh-cli` 时，Native 拒绝发送歧义切换。
- Host status 声明 `capabilities.exactAccountRemoval` 后，Native 才提供安全删除；当前和非当前 OAuth 都可确认删除，不执行“先切换再删除”。请求为 `{selection:{source:'oauth',accountId},expectedCurrent:{source,accountId}|null}`，保留打开确认时的 current selection，GET preflight 后仍由服务端锁内校验。ACK 必须回显相同 selection 及 disconnected。明确 400/404/409 拒绝会回读，不重发；未知结果走只读恢复。
- 旧 Web 无 body DELETE 保持原行为，新增 exact body 服务端严格拒绝额外字段；删除当前 OAuth 写入明确 none，绝不自动选择另一个账户或 CLI。CLI 只改 preference，不删除系统 CLI token。
- `github-auth.json` v2 将账户和 selection 一起原子替换，兼容旧单条/数组读取。`ghCliActive` 仅是兼容镜像；新 OAuth 清 CLI ownership，显式 none 不被其它 settings writer 覆盖。写竞争 fail closed，普通失败回滚，不确定回滚保留锁；详见 GitHub owning DOC。
- GET `/api/git/discover-credentials` 仅返回 host/username；GET `/api/git/identities` 是数组。Web suppression 是 `authType=token && profile.host===credential.host`，不按 username；Native 保留此规则，row/source 身份仍使用精确 host/username 对，仓库级 host 不截短后匹配。
- “导入”是建立 **身份 metadata**，不是提取或写入 token。Web prefill：repo-specific host 最后路径为 name、username 为 userName、email 空、token auth、string color、code icon。Native 提供同样可编辑的 name/user/email/auth/host/SSH path/signing/color/icon，保存进行相同 trim、required 和 nullable 字段转换。POST `/api/git/identities` 包含稳定 profile id；真实 `createProfile` 原样保留这些 metadata 并拒绝重复 id。

## 生命周期与未知结果

- deviceCode 只存在 controller 私有内存，不出现在 state、UI、Storage、日志或 URL。打开的是无 query/hash 的 `https://github.com/login/device`，调用现有 `nsh.openUrl` owner；忽略 complete URI，不向浏览器传 deviceCode/token。
- 设备流程只有当前 active scope 才有 timers；单 flight，最多 30 分钟 / 1800 次（最小间隔 1 秒），按实际 expiresIn 截止，不预先缩短正常流程。slow_down 累加 5 秒。取消/过期/失效/销毁清 timers 和本地 code；后台无 timers，恢复即便 GET 挂起也先处理过期 lease。
- 仅 `/start` 的 `cancellable:true` 授权 Native 调用 `/api/github/auth/cancel`，body `{deviceCode}`。确认取消阻止晚到 exchange/user lookup 的 Host 落盘；同 Host dispose、迟到 start 和异常交换也尝试清理。旧 Host 明确 unsupported，不盲发。第三方始终 `providerRevoked:false`，不能声称撤销 GitHub 授权/令牌或物理中止已发送请求。
- cancel 已完成/不可用/未知 ACK 保持 unknown，停止本地轮询；等待原交换结束并 GET 核对后，才可显式保留 Host 状态。晚到 ACK 不发布为另一流程成功。Host ledger 为进程内、有界、无 token receipt；重启/换进程后未签发 code 的 complete 拒绝 410，不重新 exchange。
- `/complete` 本身可能写凭据；任何 transport/格式失败均停止交换、不重播相同 code。activate/CLI/DELETE/import 同理。ACK 后 GET 失败只提供读恢复，GitHub 后续写入阻塞到 successful read-back，不重播已 ACK 操作。
- unknown import 只在稳定 id **与全部 normalized metadata** 权威匹配时确认成功。缺失/不同 id 或内容不假装失败/成功，也不自动重发。用户可在成功回读后显式放弃待确认项，保留当前 Host 状态；该动作本身不发写入，之后须重新显式选择新的导入。
- discovered/profile 各自保留上一份有效快照，单域失败不清空另一域；catalog 未知或失败时禁用导入。所有异步回读带 read revision；覆盖/恢复及 mutation ACK 会使早于提交的读取失效。

## 正式国际化

两个 Native fragment 统一使用 `./i18n` 的 `t`，21 个 key 在十种语言的 `packages/ui/src/lib/i18n/messages/*settings.ts` 中正式提供。不存在 `settings-github-messages.ts` 平行词典、locale resolver 或组件内翻译表。颜色/图标选项在渲染时翻译，切语言不另造持久状态。

## 剩余验收边界

1. expected-Host native admission 归主会话安排的 RuntimeBridge owner；本 scope 未修改或验证该原生队列合同。JS fence 与服务端账户 CAS 不能替代原生 expected-scope admission。
2. GitHub 端第三方撤销没有实现；进程重启/多实例的 durable device-flow receipt 与 crash-left lock 自动恢复也没有实现。不允许把这些边界写成成功或静默重播。
3. 第三方 OAuth、账户头像/原生视觉与导航布局、外部浏览器往返、真实 direct/Relay Host 均未运行验收。本任务不声称完整 1:1 已验收。

## Synthetic 验证与 main 串行 engine

`tests/settings-github-host.js` 是严格、纯内存 Host：只接受列出的 route/method/body，exact selector/expectedCurrent、唯一 synthetic codes、cancel 和无替代账户自动选择均与新合同同步；拒绝额外字段、system/Keychain/connection/network 能力。fixture config 只声明四个精确 Host calls，所有其它 capabilities 沿用 NSH 默认 deny；授权链接由 `github.fixture.open` 记录模拟结果，绝不打开真实网页。fixture 无外部头像 URL。未导入执行真实 Host auth/Git 模块；main 运行时仍应检查编译产物没有额外 capabilities。

```sh
bunx vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/settings-github.test.ts \
  packages/nsh/settings-git-credentials.test.ts \
  packages/nsh/settings-github-messages.test.ts \
  packages/nsh/settings-github-host.test.ts \
  packages/nsh/settings-github-engine.test.ts

# 仅 main 串行、显式 opt-in；本任务未运行 engine。
NSH_GITHUB_ENGINE=1 bunx vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/settings-github-engine.test.ts
```

服务端另运行 `@yuriai/web` 项目中的 `server/lib/github/{auth,auth-routes,device-flow-sessions,gh-cli-credential,octokit-selection}.test.js` 和 `src/api/github.test.ts`。真实 handlers 无监听器运行，filesystem/provider/CLI/Octokit/HTTP 由内存 mock 接管；旧 Web wrapper 无 body DELETE 与旧设备握手形状单独回归。

本轮限定验证：Native **42 passed，engine 1 skipped**；Web/服务端 **29 passed**。`node --check` 通过 auth/routes/device-flow-sessions；`tsc --noEmit -p packages/web/tsconfig.json` 通过。`tsc --noEmit -p packages/nsh/tsconfig.json` 仍失败：当次 diagnostics 位于其它 owner 的 gui-plugin-browser/preview、notification-runtime、terminal-core 及其引入的 shared desktop 类型；本次 GitHub 文件无 diagnostics，不等于全包通过。

Settings audit 使用实际 skill 路径 `.agents/skills/settings-ui-patterns/scripts/audit-settings-ui.sh`，两组件通过；根 `scripts/audit-settings-ui.sh` 不存在。`sandbox-exec -p '(version 1)(allow default)(deny network*)' bun run dead-code` 已离线完成，报告为非阻断：本 scope 命中显式 fixture entry、搜索 metadata exports、动态 GitHub index exports 和新增共享 API types；已检查真实消费者，没有据此删除入口或其它 owner 的文件。

没有运行 engine/UIKit/设备/main build、真实 Host/OAuth/凭据读写、系统 Keychain 或 Git 操作。已再次检索工具目录，未发现可调用的 subagent/delegation 工具，因此没有独立子代理审查证据。外部文档与网络操作未执行，NSH API 以已安装 types 与当前源码为依据。
