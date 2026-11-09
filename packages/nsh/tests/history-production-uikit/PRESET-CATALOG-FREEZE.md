# Preset 添加弹层：合成只读目录增量

本增量仅修改 `SyntheticHost.swift`、`host.test.ts` 与 preset 合同。生产 App/新会话/UI、attachments、font、Observer、writer、build 与旧 artifact 均不改。供 main 后续新 snapshot 使用，不覆盖正在构建的 BTW snapshot。

## 实际 wire 与数据来源

生产 `NativeNewSessionStarters.loadCatalog` 的两次请求已从当前源码核对：

| 请求 | 严格准入 | 响应 |
| --- | --- | --- |
| `POST /api/config/commands/metadata?directory=%2Ffixture%2Fhistory` | normal + 显式 ui-parity；原 exact expectedHost；query 仅 directory 且必填；body 仅 catalog，且必须是真正 JSON boolean true | `{commands:[...]}`，固定 user/project 两条 command metadata |
| `GET /api/config/skills?summary=true&directory=%2Ffixture%2Fhistory` | 原 exact expectedHost、无 body；query 仅 directory、summary 且必填，summary 精确 true | normal + ui-parity 提供固定 project skill；其它 profile 保持原空 skills 响应 |

只读 POST 响应 schema 对照 `packages/web/server/lib/opencode/config-entity-routes.js` 的 catalog 分支：name/description/agent/model/source/scope/isBuiltIn/reference，不带 template。skills 对照 `skill-routes.js` 的 summary 分支：name/path/scope/source/description。固定名称参考已有 `tests/new-session-host.js` 合成目录，路径限于本 fixture 的 home/project，既不读取文件也不执行 command/skill。没有新增通用 payload、目录覆盖或环境变量入口。

| 固定条目 | scope | 真实 preset 投影 |
| --- | --- | --- |
| fixture-command | user，非 built-in | Fixture command，command 分区，global pin 目标 |
| fixture-project-command | project，非 built-in | Fixture project command，command 分区，project pin 目标 |
| fixture-review | project，source=agents | Fixture review，skill 分区，project pin 目标 |

两条 command 的 agent/model 明确为 null、source=command、isBuiltIn=false，reference 是各自固定合成 Markdown 路径。skill 的 path 是 `/fixture/history/.agents/skills/fixture-review/SKILL.md`。它们仅是目录 metadata，不提供执行或读取模板的能力。

原全局默认已 pin explore/catch-up/weigh/debug/review，因此弹层 built-in 分区剩余 Craft goal；与上述两条 command、一条 skill 共四项。新草稿 `/` 候选的 compact、summary 等条件仍归原 `nativeCommandRows`，本轮不改变。

## 边界与审计

本次授权只准入上述精确只读 POST；不将 HTTP POST 本身当成付费、生成或配置写权限。保留原固定 BTW generate 和 goal/get 的独立边界，其余 create/send/command/model/config/fs 写入继续拒绝。NSNumber 必须经 CFBoolean 类型核验，数字 1 不能冒充 true；names 批量查询、额外字段与任意 prompt/model 都不支持。

成功目录读取新增 `synthetic-preset-catalog-read` 事件，仅有 requestID、固定 catalog=commands|skills、固定 rowCount=2|1、synthetic=true，及原 journal 共有 sequence/nativeUptimeMs/scenario/sourceGeneration。无 prompt/body/template 内容、无新 writer 或 timer；仍使用原有界 journal。失败 body 的 sentinel 不进入 audit。snapshot mutations=0、network=false、syntheticBtwGenerateCount=0，读取不创建会话或执行模型。

固定 BTW generate handler 片段 SHA-256 保持 `a22e4d4d2510dd2603d1f207b48d139d333ed34bb1663a9f475d2258fb50bbf0`；fs/home/read 两分支片段 SHA-256 保持 `d93e3cddd1ec033c43291b0389ca75a2cc4d02cc9faf55c9ce9a681fb20186d7`。修改前后逐字核验一致。

## 验证与 main 操作

先运行实际生产 send/loadCatalog 函数 + `runtime.bindRequest` + Swift Foundation 内存 Host，复现 error=common.unavailable 为 red；局部 handler 修复后 error 为空、catalogBusy=false，投影四项目录与 review 搜索通过，重复读取响应一致。未替换 router 或生产 request adapter，没有 UI/Host 网络或模型调用。

负测覆盖非 POST、非 normal/ui-parity、未 admission、旧 lease/错误 host/额外 scope 字段；缺失/重复/额外 query、错误目录、location[directory] 替代、目录与路由 path traversal；缺 body、null、数组、boolean/numeric/string 顶层、catalog=false/1/string/array/object、额外 names/prompt/model；skills 的错误 method/body/summary/query；create、prompt、command、model、settings PUT、fs mkdir/write、small-model generate 拒绝。原新草稿负测仅把已获新授权的 catalog:true 改为仍非法的 catalog:false，未删除原 scope/query/fs 负测。

Host 36 项，加 build/sidecar 共 39 项通过；NSH `tsc --noEmit`、Swift `arm64-apple-ios15.0-simulator` SDK typecheck 通过。build.test 是静态合同测试，不是构建 App。未运行设备、engine、App 构建、真实 Host、Git、依赖安装或付费请求。

main 在后续包含下列哈希的新 artifact，以 normal + `HISTORY_SYNTHETIC_RUN_MODE=ui-parity` 进入真实新建聊天，待默认 starter 加载后点 `new-session-presets-add`（＋）。预期：弹层无 `new-session-presets-catalog-retry`；built-in 看到 Craft goal，command 看到 Fixture command/Fixture project command，skill 看到 Fixture review。搜索 review 只剩 Fixture review；清除搜索恢复四项。关闭后仍是未发送新草稿，没有 create/send。background audit 应看到 commands/skills 两个只读事件、rejected=0、mutations=0、network=false；不应看到本次操作引起的 BTW generate。

**本轮只验查看、分组、搜索、关闭所需 wire。点击条目会进入原真实 pin 保存逻辑（settings PUT 或 fs mkdir/write），仍被 fixture 拒绝；未授权保存成功，也未声称 UIKit 或添加保存按钮的真实写入已验收。**

冻结 SHA-256：

```text
61b6f081786b2b0a7265c87c2dcecded73672598cce4181fd5b0d1a6cd578af1  SyntheticHost.swift
dad836597dc84bc28a31401e38dafcb5f9940849a768a21e5880f455cddee704  host.test.ts
```
