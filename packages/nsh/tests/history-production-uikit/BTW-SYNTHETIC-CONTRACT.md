# BTW 固定 Markdown 的 ui-parity 合成 Host 合同

本轮只扩展 fixture `SyntheticHost.swift`、`host.test.ts` 与本说明。不改 production、Observer/writer、build、main 或其它 owner；新草稿 `/api/fs/home` 与 canonical `/api/fs/read` 两个冻结只读分支逐字保留。没有运行设备、引擎、真实 Host、网络、模型、Git 或依赖安装。

## 精确 wire 与审计

仅 `scenario=normal` 且显式 `HISTORY_SYNTHETIC_RUN_MODE=ui-parity` 放行 `POST /api/session/history-production-500/generate`。启动 sweep、connection admission 和精确 `expectedHost={hostID:"history-production-synthetic",lease:"00000000-0000-4000-8000-000000000053"}` 沿用原门禁。无 query：即使正确的 directory/location[directory] 也拒绝，与真实 `createBtwGenerate` 一致；仅 body 对象的必填 `prompt` 字段，任何额外字段、无效类型、其它 method/path/session/scope 都拒绝。

仅允许两个**完整字符串**：

1. `fixture code question`，用于真实 request adapter 的 direct 合同。
2. 当前 `createBtwOwner` 实际构造的固定指令、两个换行和上述唯一问题：

```text
The user is asking a quick side question about the conversation so far. Answer directly and concisely in markdown from what you already know. Do not call any tools and do not take any actions.

fixture code question
```

不匹配任意前后缀/关键词/大小写/尾部空白，不接纳任意真实 query；含 side history 的 follow-up prompt 也不在白名单。main 从真实已有 Chat 主输入提交 `/btw fixture code question`；需要重复首问时先关闭 BTW 再重开，不能把未允许的 follow-up 拒绝写成模型失败。固定响应是 `{data:{text:...}}`，含 plain paragraph、行内代码、三行 Swift fenced code 与 🧪🙂 emoji；明确写着 synthetic/no model。纯静态文字，不执行其中的 print，也不创建 session、写主历史、调用模型或工具。

`ui-parity` snapshot 新增累计 `syntheticBtwGenerateCount`；成功匹配后记录固定 `synthetic-btw-generate`，仅携带 requestID、generateCount、synthetic=true 及既有 phase/sequence/uptime/scenario/sourceGeneration。原 request/response 事件保留 method、固定 path、requestID/status；generate 路径的 query 元数据始终为空对象，只记 queryKeyCount，防止被拒绝的 query 将正文写进审计。body、prompt、response Markdown 均不写入 journal/audit。默认 `history-diagnostic` 仍拒绝全部 generate，snapshot 也不增加新计数键。

本计数仅表示合成 fixture 响应次数，不能声称真实模型执行或费用。主审计 `mutations=0/network=false/messageCount=500` 维持原合同；成功 stateless simulate POST 不冒充业务 mutation。没有新计时器、控制 bridge 或 pending gate；实际 closing/reopen 仍依赖生产 BTW 的 captured owner/presentation ticket。要查看 generate 事件，在 UI 操作后按既有方式退后台导出同进程 `Documents/ui-parity/ui-parity-audit.json`；近期 journal 可能淘汰，累计计数仍保留。

## 新包交主

main 统一冻结所有并行 owner 后构建全新独立 artifact；现有 builder 已 stage `SyntheticHost.swift`，无需修改构建输入、grant 或环境 schema：

```sh
node packages/nsh/scripts/build-history-production-uikit.mjs --scenario normal --observer-v4
```

此命令仅列作 main 构建方法，本 worker 未执行整包编译或启动。main 用新 bundle 显式 `HISTORY_SYNTHETIC_RUN_MODE=ui-parity` 启动，保留所需 reference-105/density profile；默认 diagnostic 不允许请求。不要覆盖旧 artifact，也不要将 UI 审计作为历史 strict PASS。

## 验证边界

新增 Foundation Swift 可执行回归覆盖固定响应/重复请求、requestID 与 count、主 session/历史前后完全相同、新草稿只读分支保留、method/body/query/scope/session 白名单负测、默认 diagnostic 与其它 scenario 禁用、缺 admission、正文/原始 body 不进入审计。真实 TS `bindRequest → createBtwGenerate` 以及 `acceptBtwIntent → createBtwOwner` 的实际生产 prompt 都经该 Swift Host 往返；没有 mock 出另一个宽松路由。

这些是 macOS Foundation 合成 wire 与 TS 合同验证，不是 UIKit 代码字形、字体 fallback、选区、视觉、手势、关闭动画或模型品质验收。main 仍需在新包完成实际 UIKit 代码块与关闭重开检查。

本轮结果：Host/build/sidecar 三文件 **37 passed**；BTW model/surface/command integration 与 appearance-code-consumers 四文件 **39 passed**；NSH 全包 tsc 与本 fixture sidecar tsconfig 均通过；`SyntheticHost.swift` 的真实 iOS Simulator SDK / arm64-apple-ios15.0-simulator 静态 typecheck 通过。未运行完整 App 构建或设备。

验证后冻结 SHA-256：

```text
ab87119bb6ac5c3ae60ea439b7c089c5174afe7ed9e7c6642876151f2c71ff9d  SyntheticHost.swift
1829e840490283d9f0390ba36335c8a4b8b7efce7e9baa27f778e3b7d2d2cb84  host.test.ts
```
