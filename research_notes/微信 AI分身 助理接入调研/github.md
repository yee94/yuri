# GitHub 源码研究：微信 AI 分身／ClawBot／iLink 接入 Yuri 助理

研究截止：2026-11-03。只读公共源码、协议文档和 GitHub issue；未安装软件、未扫码、未调用腾讯业务接口、未改 Yuri 源码。下文区分「实际客户端实现」「社区观测」「推断」，不把 issue 或营销说法当作平台承诺。

## 1. 官方源码是否可用，扫码、认证、收发和媒体到底如何实现？

### Takeaway

有腾讯官方、MIT 许可的完整 TypeScript 适配器及公开客户端协议说明，足够实现独立于 OpenClaw 的原型；但文档明确不是完整服务端契约，不等于稳定开放平台 API。[官方仓库](https://github.com/Tencent/openclaw-weixin)、[协议的适用边界](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md#L7-L19)

### Cited Findings

**准确身份与版本**

- 主要来源是 **Tencent/openclaw-weixin**，而不是搜索排名靠前的个人同名仓库。研究时 main 的提交 SHA 为 `874637a0dbc24050f72d1385add4fc6170a2d726`；其 package 版本为 `2.4.10`，CHANGELOG 将该版本标为 2026-10-10。以下官方源码链接尽量固定此提交，不把未合并 PR 当成当前实现。[源码快照](https://github.com/Tencent/openclaw-weixin/tree/874637a0dbc24050f72d1385add4fc6170a2d726)、[package.json](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/package.json)、[CHANGELOG L9–14](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/CHANGELOG.md#L9-L14)
- OpenClaw 核心不实现微信协议，外部插件拥有二维码、腾讯 iLink 请求、媒体、context token、账号监听。[OpenClaw 核心说明](https://github.com/openclaw/openclaw/blob/main/docs/channels/wechat.md#how-it-works)
- 官方源码许可证正文允许复制、修改、分发、商用，需保留版权和许可声明，为 MIT；GitHub API 的 `NOASSERTION` 识别不能替代许可证正文。[LICENSE](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/LICENSE)

**协议与扫码绑定**

- 默认 API 为 `https://ilinkai.weixin.qq.com`；CDN 为 `https://novac2c.cdn.weixin.qq.com/c2c`；这是 HTTPS JSON 客户端协议，不是企业微信 `cgi-bin/kf/*` 客服协议。[协议 L21–30](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md#L21-L30)
- **当前官方二维码创建为 POST** `/ilink/bot/get_bot_qrcode?bot_type=3`，body 为 `local_token_list`；可为空，官方最多带最近十个本地 bot token。二维码响应有 `qrcode` 和 `qrcode_img_content`。[协议 L86–110](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md#L86-L110)、[实现 L80–105](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/auth/login-qr.ts#L80-L105)
- 状态使用 GET `/ilink/bot/get_qrcode_status?qrcode=...`，需要时加 `verify_code`；处理 `wait`、拼写如此的 `scaned`、`confirmed`、`expired`、`need_verifycode`、`verify_code_blocked`、`scaned_but_redirect`、`binded_redirect`。成功返回 `bot_token`、`ilink_bot_id`、`baseurl`、扫码人的 `ilink_user_id`。[协议 L113–148](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md#L113-L148)
- 登录状态在进程 Map 保存，以 `sessionKey` 区分；默认类型 `3`，本地登录新鲜度五分钟，单次二维码状态请求超时 35 秒；到期有限刷新，`binded_redirect` 表示已绑定、不是重新发 token。收到 `redirect_host` 会切换到其 HTTPS host。[login-qr.ts L8–41](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/auth/login-qr.ts#L8-L41)、[L253–283](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/auth/login-qr.ts#L253-L283)、[L423–473](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/auth/login-qr.ts#L423-L473)

**认证、token 与 session 不是一回事**

- 认证头为 `AuthorizationType: ilink_bot_token`、`Authorization: Bearer <bot_token>`；另带随机 uint32 十进制字符串的 base64 `X-WECHAT-UIN`、`iLink-App-Id: bot`、编码版本 `iLink-App-ClientVersion`，可选 `SKRouteTag`。认证 POST 带 `base_info.channel_version`、`bot_agent`；后者仅可观测标识，不是鉴权或路由能力。[协议 L32–65](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md#L32-L65)、[api.ts L221–254](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/api/api.ts#L221-L254)
- bot token 为每账号持久凭据；保存 token、baseUrl、扫码 userId，凭据文件 best-effort chmod `0600`。不是每次消息换 token，也不是模型的 API key。[accounts.ts L115–121](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/auth/accounts.ts#L115-L121)、[L184–218](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/auth/accounts.ts#L184-L218)
- `context_token` 来自入站消息，官方按 **bot accountId＋微信 userId** 缓存，并单账号落盘，发回时原样透传；它不同于 bot token、长轮询 cursor、OpenClaw agent sessionKey，也不是 LLM context。当前缓存没有年龄或 TTL 字段。[inbound.ts L17–54](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/inbound.ts#L17-L54)、[L100–127](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/inbound.ts#L100-L127)

**收消息：长轮询，而非 webhook／WebSocket push**

- POST `/ilink/bot/getupdates`，body 的 `get_updates_buf` 为不透明游标，首轮可为空；响应 `msgs`、下个 `get_updates_buf`、可选 `longpolling_timeout_ms`。默认长轮询 35 秒，会采用服务端建议值；支持 abort 取消。[协议 L166–206](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md#L166-L206)、[api.ts L438–487](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/api/api.ts#L438-L487)
- 当前实现恢复账号 cursor，成功后先保存新 cursor，再逐条 `await processOneMessage`。消息处理与拉取在同一串行循环；长任务会阻塞后续收消息。[monitor.ts L70–81](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/monitor/monitor.ts#L70-L81)、[L150–183](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/monitor/monitor.ts#L150-L183)
- 普通轮询错误间隔 2 秒，连续三次失败后退避 30 秒；业务 `ret` 或 `errcode == -14` 认作 bot token stale，账号暂停一小时，不是自动刷新凭据。不要把这一小时客户端冷却误写成平台消息窗口。[monitor.ts L13–16、L111–148](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/monitor/monitor.ts#L111-L148)、[session-guard.ts](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/api/session-guard.ts)

**回复与状态**

- POST `/ilink/bot/sendmessage`，`msg` 包含 `to_user_id`、客户端生成 `client_id`、`message_type:2`、`message_state:2`、`context_token`、`item_list`。文本 item 为 `type:1, text_item:{text}`。可带 `run_id`。官方 helper 缺 context token 只告警仍发送，不证明服务端接受无 token。[协议 L208–248](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md#L208-L248)、[send.ts L56–136](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/send.ts#L56-L136)
- 当前官方 `sendMessage` 检查非零 `ret` 并抛错；HTTP 非成功也抛错。其文本 helper 没有通用发送重试／过期 context 自动刷新。不存在把 `ret=-2` 一律解释成 token 过期的官方映射。[api.ts L579–596](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/api/api.ts#L579-L596)、[send.ts L103–136](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/send.ts#L103-L136)、[协议错误说明](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md#L67-L84)
- typing：`getconfig` 获取 `typing_ticket`，`sendtyping` 的 status=1 输入中、2 取消；生命周期 `msg/notifystart`、`msg/notifystop`。这不等于最终回复流式编辑或用户已读回执。[协议 L301–378](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md#L301-L378)

**媒体**

- message item 类型为 1 文本、2 图片、3 语音、4 文件、5 视频，另有 11/12 工具执行进度。语音入站可有服务端 transcript。协议字段存在不代表该功能全部实现。[协议 L380–431](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md#L380-L431)
- 出站流程：读文件→算明文 MD5／大小→随机 16-byte AES key、filekey→`getuploadurl`→AES-128-ECB＋PKCS#7 加密→POST 二进制到 CDN→读 `x-encrypted-param`→构造 media reference 后 `sendmessage`。优先服务端 `upload_full_url`；当前通用流程 `no_need_thumb:true`，不实现缩略图上传。[协议 L250–299](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md#L250-L299)、[L454–469](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md#L454-L469)
- 当前 image/video/file 发出的 `aes_key` 都是 **hex key 字符串的 base64**，解码器同时接受 raw16-byte 的 base64。不能采用早期社区 README 的“图片 raw、其他 hex”概括覆盖当前官方行为。[协议 L435–452](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md#L435-L452)
- CDN 上传 4xx 立即终止，其余失败最多三次总尝试；成功必须 HTTP 200 且有非空 `x-encrypted-param`，不是 HTTP 2xx 即算上传成功。[cdn-upload.ts L6–88](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/cdn/cdn-upload.ts#L6-L88)
- 入站下载优先 media `full_url`，否则根据 `encrypt_query_param` 拼 CDN 下载 URL，再解密；图片没有 key 时按明文处理，voice/file/video 缺 key 则跳过。[协议 L471–476](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md#L471-L476)
- 当前“发语音”不能从枚举 `media_type:4` 推导：协议明确当前文件发送管线选择 image/video/file。[协议 L299](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md#L297-L299)

### Inferences

- Yuri 原型可直接以扫码授权＋单账号 poller＋入站任务队列＋outbound adapter 实现，不必安装或运行整套 OpenClaw Gateway。依据是 HTTP 协议完整暴露，插件运行时与协议层已有边界；但要自行接管状态、安全和媒体服务。[协议总览](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md#L150-L164)
- 不宜原样复制当前 monitor：先推进 cursor 再执行、单条失败落到外层 catch、长任务阻塞拉取，都不构成可证明的可靠队列。建议先持久化 inbox、按账号＋messageId 去重，再推进 cursor，由独立执行队列消费；这些是 Yuri 设计建议，不是腾讯协议要求。[monitor.ts L150–184](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/monitor/monitor.ts#L150-L184)

### Gaps

- 尚未发现与客户端文档分离的完整服务端开放契约、稳定性 SLA、固定配额表、可靠投递／已读回执契约、bot token 的准确有效期和通用刷新／撤销接口；不能由现有字段或某次成功倒推出这些保证。官方文档本身警告客户端类型不是完整 server contract。[官方边界声明](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md#L9-L19)

## 2. 哪些开源适配器可独立复用？WorkBuddy 源码证据能证明什么？

### Takeaway

首选腾讯官方协议层作为基准。独立 TS client、独立 WorkBuddy bridge 都证明不需要 OpenClaw 框架才能接 iLink，但社区版本存在协议漂移、错误处理和验证证据不足；不能把第三方 bridge 当成 WorkBuddy 原生实现。[独立 TS client](https://github.com/photon-hq/wechat-ilink-client)、[社区 WorkBuddy bridge](https://github.com/ShengyuPei/workbuddy-wechat-bridge)

### Cited Findings

| 仓库 | 可复用部分／依赖 | 已确认的边界或问题 |
|---|---|---|
| Tencent/openclaw-weixin | 完整官方 TS；运行 Node >=22.13；依赖 qrcode-terminal、zod，peer OpenClaw >=2026.5.12。[package](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/package.json) | 整包是 OpenClaw channel，不是脱框架 SDK；API 文件读取插件 metadata/config，channel 和 monitor 引入 SDK。适合抽取／移植低层，不宜直接把整插件当 Yuri SDK。[API imports](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/api/api.ts#L1-L22)、[monitor imports](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/monitor/monitor.ts#L1-L11) |
| photon-hq/wechat-ilink-client | 独立 TS，Node >=20，内存 client、EventEmitter、调用者提供 cursor 存取；package MIT，optional qrcode-terminal，不依赖 OpenClaw。[README](https://github.com/photon-hq/wechat-ilink-client/blob/b3e59440e90da344667b5d38af122fdd77a8d2a3/README.md)、[package](https://github.com/photon-hq/wechat-ilink-client/blob/b3e59440e90da344667b5d38af122fdd77a8d2a3/package.json) | 版本 0.1.0，二维码仍 GET，状态请求 clientVersion 写死 `1`；当前官方为 POST＋应用头。高层 sendText 强制已有 context token，context cache 仅内存，且 login 成功只 setToken/accountId，没有采用返回 baseUrl 的代码。不能直接认定与当前服务兼容。[API L250–307](https://github.com/photon-hq/wechat-ilink-client/blob/b3e59440e90da344667b5d38af122fdd77a8d2a3/src/api/client.ts#L250-L307)、[client L143–151](https://github.com/photon-hq/wechat-ilink-client/blob/b3e59440e90da344667b5d38af122fdd77a8d2a3/src/client.ts#L143-L151)、[L224–236](https://github.com/photon-hq/wechat-ilink-client/blob/b3e59440e90da344667b5d38af122fdd77a8d2a3/src/client.ts#L224-L236) |
| ShengyuPei/workbuddy-wechat-bridge | 独立 JS iLink client，仅 Node 内置 crypto/fs 等；整包 Node >=22.5，qrcode 与 qrcode-terminal；MIT。[bot-client](https://github.com/ShengyuPei/workbuddy-wechat-bridge/blob/36ab93fea5b5542cdbece14f7b8c9c14a5329125/src/transports/ilink/bot-client.mjs)、[package](https://github.com/ShengyuPei/workbuddy-wechat-bridge/blob/36ab93fea5b5542cdbece14f7b8c9c14a5329125/package.json) | 社区独立桥，把 iLink 入站送 WorkBuddy CLI `-p --resume`，不是腾讯 WorkBuddy 原生源代码。README 自称扫码后完整互通仍依赖用户验证，已做的是二维码获取、CLI 和模拟服务验证。[README L3–17](https://github.com/ShengyuPei/workbuddy-wechat-bridge/blob/36ab93fea5b5542cdbece14f7b8c9c14a5329125/README.md#L3-L17)、[L210–220](https://github.com/ShengyuPei/workbuddy-wechat-bridge/blob/36ab93fea5b5542cdbece14f7b8c9c14a5329125/README.md#L210-L220) |
| fastclaw-ai/weclaw | Go 独立 iLink client＋ACP/CLI/HTTP agent adapters；可参考通道与 agent 分离。[client](https://github.com/fastclaw-ai/weclaw/blob/10711d0c6b7e2b0a784f808ef2f07ba83c2b9023/ilink/client.go)、[README](https://github.com/fastclaw-ai/weclaw/blob/10711d0c6b7e2b0a784f808ef2f07ba83c2b9023/README.md) | LICENSE 为 MIT，但 README L7 另写「personal learning only, not for commercial use」，与 MIT 文义冲突；商用复用前需澄清，不作为优先来源。整仓有 cobra/qrterminal/x/net 等依赖，不能叫零依赖整包。[LICENSE](https://github.com/fastclaw-ai/weclaw/blob/10711d0c6b7e2b0a784f808ef2f07ba83c2b9023/LICENSE)、[README L7](https://github.com/fastclaw-ai/weclaw/blob/10711d0c6b7e2b0a784f808ef2f07ba83c2b9023/README.md#L7)、[go.mod](https://github.com/fastclaw-ai/weclaw/blob/10711d0c6b7e2b0a784f808ef2f07ba83c2b9023/go.mod) |

**WorkBuddy 原生通道的社区观察**

- `ZhaowTao/wechat-clawbot-push` 从 WorkBuddy 本地设置读取 `claw.users[legacyOwnerUid].channels.weixinClawBot`，字段包括 `botToken`、`baseUrl`、`userId`；可用环境变量或独立配置代替。源码说明这是“已在 WorkBuddy 绑定的 ClawBot”，不是自己实现扫码绑定。[README L37–49](https://github.com/ZhaowTao/wechat-clawbot-push/blob/main/README.md#L37-L49)、[send_wechat.py L58–88](https://github.com/ZhaowTao/wechat-clawbot-push/blob/main/scripts/send_wechat.py#L58-L88)
- 这只能作为**第三方对宿主配置的观察**，不能证明这些 WorkBuddy 私有字段是稳定 API，更不能据此授权 Yuri 读取用户其他应用凭据。推荐 Yuri 自有二维码授权，不偷用／导入 WorkBuddy token。[同一源码凭据发现逻辑](https://github.com/ZhaowTao/wechat-clawbot-push/blob/main/scripts/send_wechat.py#L58-L95)
- **关键反证：该脚本“空 context_token 能直接推本人”的结论证据不足。** `api_req` 仅解析 JSON，不判断业务 `ret`；`do_send` 忽略 `send_text` 返回值，HTTP 200 内即使 `ret=-2` 也可能打印“已发送”／`ok:true`。因此 README 所称“实测可主动推送”不能当可靠服务端能力证据。[主张](https://github.com/ZhaowTao/wechat-clawbot-push/blob/main/README.md#L15-L22)、[api_req L120–141](https://github.com/ZhaowTao/wechat-clawbot-push/blob/main/scripts/send_wechat.py#L120-L141)、[do_send L240–266](https://github.com/ZhaowTao/wechat-clawbot-push/blob/main/scripts/send_wechat.py#L240-L266)
- 该脚本 `refresh` 的 token 查找递归匹配任意 `context_token`，没有先按目标 userId 筛选；缓存文件也是单个全局 token。不能复用到 Yuri 多账号／多用户。源码还会输出 token 前缀，不符合严格不泄露凭据的目标。[find_context_token L144–157](https://github.com/ZhaowTao/wechat-clawbot-push/blob/main/scripts/send_wechat.py#L144-L157)、[refresh_token L176–199](https://github.com/ZhaowTao/wechat-clawbot-push/blob/main/scripts/send_wechat.py#L176-L199)
- 社区 WorkBuddy bridge 更谨慎：无 context token 时暂存到内存队列，每用户最多 20 条，等新入站 token 再补发；不是任意主动消息保证，也不是 durable outbox。[wechat-bot.mjs L65–100](https://github.com/ShengyuPei/workbuddy-wechat-bridge/blob/36ab93fea5b5542cdbece14f7b8c9c14a5329125/src/transports/wechat-bot.mjs#L65-L100)、[L262–276](https://github.com/ShengyuPei/workbuddy-wechat-bridge/blob/36ab93fea5b5542cdbece14f7b8c9c14a5329125/src/transports/wechat-bot.mjs#L262-L276)

**必须排除的混淆：CodeBuddy OAuth／WebSocket 不等于 iLink**

- `HenryXiaoYang/wechat-openclaw-channel` 支持 QClaw 与 WorkBuddy 两模式；README 写 WorkBuddy 用 CodeBuddy OAuth＋WebSocket。深入源码后，WorkBuddy 绑定实际访问 `copilot.tencent.com/v2/backgroundagent/wechatkfProxy/link`、`bindStatus`，回复走 `/v2/backgroundagent/wecom/local-proxy/receive`，并用 Centrifuge workspace channel 订阅。这是客服／代理体系证据，**不纳入本调研的 iLink/ClawBot 实现证据**。[README](https://github.com/HenryXiaoYang/wechat-openclaw-channel/blob/main/README.md)、[codebuddy-api.ts L176–225](https://github.com/HenryXiaoYang/wechat-openclaw-channel/blob/main/auth/codebuddy-api.ts#L176-L225)、[centrifuge-client.ts L80–124](https://github.com/HenryXiaoYang/wechat-openclaw-channel/blob/main/websocket/centrifuge-client.ts#L80-L124)、[L232](https://github.com/HenryXiaoYang/wechat-openclaw-channel/blob/main/websocket/centrifuge-client.ts#L232)

### Inferences

- 最稳路线是基于官方 MIT 源码抽一个明确版本的薄 iLink adapter，由 Yuri 自行提供凭据库、poller、inbox/outbox、会话路由和媒体边界；不是安装社区 WorkBuddy 插件，更不是复制 WorkBuddy 私有登录态。独立客户端可作为结构参考和交叉检查，不能代替追踪官方协议变化。[官方 API 实现](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/api/api.ts)、[独立客户端漂移实例](https://github.com/photon-hq/wechat-ilink-client/blob/b3e59440e90da344667b5d38af122fdd77a8d2a3/src/api/client.ts#L250-L307)

### Gaps

- 未找到可认定为 **WorkBuddy 官方开源的完整原生微信 ClawBot 通道源码**；本轮可验证的是腾讯 OpenClaw 适配器、第三方 WorkBuddy bridge 和第三方读取 WorkBuddy 设置的推送脚本。不能证明 WorkBuddy 内部是否有额外授权、可靠队列、不同主动推送权限或服务端商业协议。
- Context7 已先 resolve `OpenClaw Weixin ilink` 并 query `/openclaw/openclaw`，得到核心的外部插件文档；关键协议、最新版本与实现差异随后以腾讯一手源码核实。检索未提供 WorkBuddy 原生 iLink SDK 的权威用法文档。

## 3. 群聊、主动触达、时间窗、隔离和安全方面，哪些能承诺给 Yuri？

### Takeaway

可把“用户扫码连接本人、私聊请求与回复、图片／文件等媒体”列为有源码依据的原型范围；**不能承诺群聊、无限主动消息、固定 24/48 小时时间窗或稳定送达 SLA**。授权、状态隔离和可靠队列不能照搬当前适配器。[官方 capabilities](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/channel.ts#L229-L233)、[官方契约边界](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md#L9-L19)

### Cited Findings

**群聊**

- 官方 channel 只声明 `chatTypes:["direct"]`，入站授权策略 `groupPolicy:"disabled"`，路由以 direct peer 构造。虽然消息 type 有 `group_id` 字段，文档明确这不保证插件支持群聊。[channel.ts L229–233](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/channel.ts#L229-L233)、[authorization.ts L24–35](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/authorization.ts#L24-L35)、[协议 L380–401](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md#L380-L401)

**主动消息／时间窗：事实冲突必须保留**

- 官方提供 outbound sendText/sendMedia，会从 accountId＋目标用户缓存找 context token，含 cron 推送提示；证明“客户端能尝试主动发送”，不证明“服务器永久允许主动发送”。多账号匹配有歧义会要求显式 accountId。[channel.ts L72–115](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/channel.ts#L72-L115)、[L251](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/channel.ts#L251)、[L267–278](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/channel.ts#L267-L278)
- **社区报告 A，2026-06-15：** 用户声称无主动交互 24 小时 context token 失效、有效会话主动消息最多 10 条。这是 feature request，不是平台配额文档。[issue #202](https://github.com/Tencent/openclaw-weixin/issues/202)
- #202 的一条回复称“已催促产品同事重新评估”，但 GitHub 身份 association 为 NONE，未给出规范或修改后的额度；截至 2026-11-02 仍有追问。不能把该留言升格成正式开放政策。[2026-06-18 回复](https://github.com/Tencent/openclaw-weixin/issues/202#issuecomment-4739098947)、[2026-11-02 追问](https://github.com/Tencent/openclaw-weixin/issues/202#issuecomment-6569953501)
- **社区报告 B，2026-07-12：** #225 描述无入站约 48 小时后 `ret=-2`，但正文又说“大约一天后失败”；其重拉 cursor 刷新 token 等修复方案只是提议，不是有效 API。[issue #225](https://github.com/Tencent/openclaw-weixin/issues/225)
- **社区报告 C，2026-09-14：** #309 描述约 15 小时无入站后 `ret=-2 prepare failed`，且有 16–18 小时仍成功的反例；作者明确把 TTL 浮动／阅读触发续期列为猜测，并报告出站 keepalive 不能稳定续期。[issue #309](https://github.com/Tencent/openclaw-weixin/issues/309)
- **社区方案 D，2026-10-08：** PR #335 声称 stale context 可不带 token 重试，另指出服务端 bot session degraded 也会返回同样 `prepare failed`。当前所读 main 的 send helper 没有其 `sendWithStaleTokenFallback`，不能把 PR 提议当已发布能力。[PR #335](https://github.com/Tencent/openclaw-weixin/pull/335)、[main send helper](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/send.ts#L103-L136)
- 无 context 主动发媒体也有 `ret=-2` 失败观测；不能把该码唯一映射到限流、token 过期、媒体权限或主动消息限制。[issue #216](https://github.com/Tencent/openclaw-weixin/issues/216)
- 存在“发送被接受／日志成功，但微信客户端收不到”的真实用户问题报告，即使 fresh rebind＋fresh inbound＋短回复仍出现。只能视为风险信号，不能据此确定服务端根因或风控规则。[issue #263](https://github.com/Tencent/openclaw-weixin/issues/263)、[issue #266](https://github.com/Tencent/openclaw-weixin/issues/266)

**用户隔离与认证**

- 官方推荐多账号使用 `session.dmScope=per-account-channel-peer`；协议 context cache 以 accountId＋userId 键控。Yuri 还需加入 runtime／部署租户、Yuri Bot ID 和会话归属，不能把微信扫码账号等同所有 Yuri 助理。[官方多账号配置](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/README.md#multiple-accounts)、[context key L24–25](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/inbound.ts#L24-L25)
- 当前官方读取 legacy allowFrom 文件；非空则采用它，否则退回保存的扫码 userId，再无 userId 则给空 allowFrom。authorization 对空列表明确 `senderAllowed:true`（控制命令另行不授权）。因此不能把“启用 pairing”理解为未知发送者必定被拒。[process-message.ts L184–199](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/process-message.ts#L184-L199)、[authorization.ts L19–32](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/authorization.ts#L19-L32)、[legacy 文件读取](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/auth/pairing.ts#L28-L61)
- OpenClaw 核心文档专门警告插件 2.4.8 的 legacy allowlist 与核心 SQLite pairing／撤销不同步。该警告版本限定 2.4.8；本轮 2.4.10 源码仍读取旧文件，应按当前代码审计，而不是推断全部新版本已修复或全部行为完全相同。[核心 access-control 警告](https://github.com/openclaw/openclaw/blob/main/docs/channels/wechat.md#access-control)、[当前读取逻辑](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/process-message.ts#L184-L199)

**安全与可靠性：需要再加边界，不宜原样复用**

- 凭据文件 chmod 0600 是 best effort；context-token 落盘没有相同显式 chmod。适配器有 redactBody/redactUrl，但 QR status 另有直接记录原始 body 前 200 字符的 debug 语句，故不能声称所有路径凭据日志均已脱敏。[accounts.ts L211–218](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/auth/accounts.ts#L211-L218)、[inbound.ts L50–56](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/inbound.ts#L50-L56)、[redact.ts](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/util/redact.ts)、[login-qr.ts L139–146](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/auth/login-qr.ts#L139-L146)
- 远程媒体 helper 直接 fetch URL 并整体 arrayBuffer，没有该 helper 内的下载超时或字节上限；CDN upload 也直接采用返回 full URL。Yuri 应自己限定 HTTPS、来源 host、重定向／私网目标、大小／时限、文件名／存放路径及媒体 retention，防 SSRF 与资源耗尽。这些属于依据源码提出的加固建议，不等于已证实可远程利用的漏洞。[upload.ts L27–55](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/cdn/upload.ts#L27-L55)、[cdn-upload.ts L24–46](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/cdn/cdn-upload.ts#L24-L46)
- 当前 processOneMessage 的 slash-command 处理在授权调用之前；不能仅因后面有 allowFrom 就认为所有前置路径都受其约束。Yuri 应把身份校验放在任何命令、媒体下载、工具调度之前。[前置 slash 处理 L90–105](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/process-message.ts#L90-L105)、[稍后的授权 L180–199](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/process-message.ts#L180-L199)
- 串行 monitor 长任务时无法及时收到 stop，官方仓库已有相同用户报告。必须把接收和执行拆开，并在 Yuri 授权边界内处理取消；别为微信入口默认绕过工具审批。[源码](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/monitor/monitor.ts#L150-L183)、[issue #320](https://github.com/Tencent/openclaw-weixin/issues/320)
- 集中云端多用户部署也不能只依据 MIT 许可证推断获准接入：#334 提交了不同出口下的扫码风险拦截对照，并请求官方确认第三方产品多用户扫码模式是否支持。它是社区未定论证据，不是地域/IP 封禁政策文档。[issue #334，2026-10-02](https://github.com/Tencent/openclaw-weixin/issues/334)

### Inferences

- **可行性分级：私有／自托管单用户原型可行；稳定商用公共通道还缺平台准入、主动触达政策、故障诊断和实机证据。** 官方源码解决“如何收发”，没有解决“平台是否长期允许所有部署模式”。[公开协议范围](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md#L7-L19)、[第三方云端模式待确认案例](https://github.com/Tencent/openclaw-weixin/issues/334)
- 建议首期范围：用户在 Yuri 手动授权绑定、只允许绑定 owner 的私聊、显式选一个 Yuri Bot、文字往返后再加媒体。内部建议键为 `(runtime/tenant, ilinkBotAccountId, peerUserId, yuriBotId)`；token/游标仅保存在服务器或桌面后端，不进入消息历史、前端持久化或 LLM prompt。此为设计推断，依据官方账号＋peer 的隔离机制，并非协议新增字段。[官方账号与 context 隔离实现](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/inbound.ts#L17-L54)
- 主动通知首期只能 best effort，必须有过期／需用户重新交互状态与失败可见性，不应把“提醒／监控告警必达”作为产品卖点；最终业务成功与微信实际可见送达也应分开表达。[互相矛盾的时窗观测 #202](https://github.com/Tencent/openclaw-weixin/issues/202)、[#309](https://github.com/Tencent/openclaw-weixin/issues/309)、[成功但不可见 #263](https://github.com/Tencent/openclaw-weixin/issues/263)
- 不建议 Yuri 与 WorkBuddy 同时轮询同一 bot 账号，或用旁路脚本 harvest token。当前证据只有 cursor 增量消费机制，没有多消费者语义保证；应为 Yuri 独立绑定并明确轮询所有权。[getUpdates 游标契约](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md#L166-L206)

### Gaps

- **必须由平台书面确认或真机测量：** 群聊未来支持计划；每用户／bot 可绑定数量；主动消息真实额度、时间窗、是否允许空 context token 发本人；bot token 轮换／注销／丢失恢复；多消费者与 cursor reset；客户端 message_id 的去重和 send client_id 的服务端幂等保证；多租户云部署准入。当前源码不足以承诺。
- **建议后续验收矩阵（本轮未执行）：** 首次二维码与验证码、重扫已绑定账号、token 丢失、跨用户拒绝、同用户多个 Bot 路由、重启恢复、断网与 -14、长任务中 stop、消息突发与重复、12/24/48 小时无交互的主动推送、每次主动发的 ret 和手机可见性、图片/文件双向与过期、解绑后撤销权限。不可用模拟服务端测试替代这些真机结果。
- 本轮 websearch 因 HTTP 402 不可用，公共 GitHub API 部分请求 403 限流；通过 GitHub 仓库 HTML、raw 源码和可用的 issues/search API 交叉研究。没有依据未来日期新闻或未经核实营销页；issue 内容仅作为社区报告，未将其作者自述或 PR 测试声明提升为官方服务承诺。
