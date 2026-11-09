# 新草稿默认目录的严格只读 fixture 修复

本轮只改 `SyntheticHost.swift` 的 request switch 两个分支，以及 `host.test.ts` 的新增严格适配器回归。不改生产新会话、导航、发送、HTML、Observer、build 或 SourceGeneration，不覆盖旧 artifact。

现场证据为 `.scratch/nsh/uikit-c8f9d877-new-submit/settled.json` 与同目录 `background-audit.json`。新建聊天 editor 为空而 preset 显示重试；audit 的唯一 rejected 紧跟 `GET /api/fs/home` request，code 为 `history_fixture_unlisted_route`。请求包含合法 expectedHost/method/path，无 body；mutations=0、network=false。该拒绝来自新草稿配置读取，不能归为 `/new` 提前 create 或发送。

生产 `NativeNewSessionStarters.load` 并行读取 settings 与 projectConfig；后者先 GET home，再用 `projectStarterLocation(home, project.path)` 读取 canonical JSON。只有 canonical 返回空字符串才尝试旧项目路径。默认全局列表来自 `DEFAULT_GLOBAL_STARTERS`，不是服务端返回的空目录。

| 路由 | 精确输入 | 固定 wire |
| --- | --- | --- |
| `/api/fs/home` | normal scenario，GET，无 query、无 body，原 expectedHost gate | `{home:"/fixture/home"}` |
| `/api/fs/read` | normal scenario，GET，无 body；仅 path、optional 两个必填 query；optional 必须是 true | canonical 配置的 JSON 字符串，包含 projectPath=/fixture/history、draftStarters=[] |

唯一 path 为 `/fixture/home/.config/yuri/projects/path_L2ZpeHR1cmUvaGlzdG9yeQ.json`，测试通过真实 project ID/path helper 核验。此 fixture 明确存在有效 canonical 配置、没有项目自定义 starter；settings 未配置全局覆盖，继续投影真实默认的 explore/catch-up/weigh/debug/workspace-review。不是任意文件读取，也不会把 unmatched path 返回空成功。旧 legacy path、穿越路径、其它文件、缺失/重复/额外 query、optional=false、GET body（含 null）和非法 scope 都拒绝。terminal/partial/growth 保持不提供这两条 normal 外层导航读取。

既有 `/api/magic-prompts` 已返回真实 v1 overrides schema；空 overrides 表示使用客户端真实默认 prompt，不调用编译、模型或 Host 生成。原 `/api/command` 的固定目录响应与本地 `nativeCommandRows` 共同投影候选：新草稿有 compact 及六个适用 magic 命令，无 summary/init；已有会话提供 summary。本轮不改已有 500 history、Bots、Schedules、资源、stream 或 v4 接口。

生产 preset 添加弹层的 `loadCatalog` 实际调用 `POST /api/config/commands/metadata?directory=...`，body 为 `{catalog:true}`，并读取已有 GET skills。初次 strict GET 修复时该 POST 仍拒绝；后续用户明确授权的最窄只读 POST 与非空目录现记录于 [PRESET-CATALOG-FREEZE.md](PRESET-CATALOG-FREEZE.md)，新 snapshot 以该增量合同和哈希为准。create、prompt、command、model、配置写入继续拒绝；真实 UIKit 与添加保存不由纯测试代替。

验证：先新增适配器回归，两项 red；局部 handler 修复后 green。Host 全部 31 项，加 build/sidecar 共 34 项通过；NSH `tsc --noEmit` 通过。Host 测试仅编译并执行 macOS Foundation 内存适配器，不是运行设备或真实 Host。四档 density、reference appearance、缺省密度、重复读取、合法请求零拒绝，以及非法请求 fail-closed 均已覆盖。未执行完整 App/SDK 构建、设备、真实 Host、Git、依赖变更或模型请求。

冻结 SHA-256（验证后重新读取一致）：

```text
94ae5500c9df0bff3337428c89ddf4bb037c80840310342af4f25bae65805933  SyntheticHost.swift
91efb85983e022817648e82f2de7a7e1806c3ceca643f05020e13de35a8a21f6  host.test.ts
```
