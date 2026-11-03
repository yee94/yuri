# 微信 AI 分身通道：ClawBot / iLink 与 Yuri 助理接入调研

调研基准日：2026-11-03。仅阅读公共 HTTP、官方文档、公开源码和 npm 发布元数据；没有扫码、登录、实际收发消息、克隆仓库、安装依赖或修改产品源码。以下将“官方已公开的客户端行为”“完整服务端契约”“第三方商用许可”分别处理，避免互相替代。

## 1. 真实通道名称、发布主体与发布时间是什么？

### Takeaway

应调查的是腾讯微信官方 **微信 ClawBot** 通道；官方开源适配器叫 **OpenClaw 微信渠道 / OpenClaw Weixin Channel**，底层为 **iLink Bot HTTP JSON API**，默认服务域名为 `ilinkai.weixin.qq.com`。WorkBuddy 官方更新日志明确记录 2026-03-22 的 4.6.4 版本新增“微信 ClawBot 集成”，不是把企业微信或微信客服换个名字。— [WorkBuddy 官方更新日志](https://www.workbuddy.cn/docs/workbuddy/Changelog)；[腾讯官方仓库](https://github.com/Tencent/openclaw-weixin)；[官方协议](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md)

### Cited Findings

- **WorkBuddy 明确使用 ClawBot 这一名称。** 官方更新日志原文：`4.6.4（2026-03-22）`、`微信 ClawBot 集成`、`新增微信 ClawBot，用户可通过微信直接与 WorkBuddy 对话，随时随地获取 AI 帮助。` 后续 2026-05-29 的 4.24.2 记录优化微信 ClawBot Markdown 渲染，2026-06-05 的 5.0.2 记录修复微信 ClawBot 长回复截断、状态/流式不稳定。前两个月就存在的普通“微信 BOT”记录，不能自动全部当作 ClawBot。— https://www.workbuddy.cn/docs/workbuddy/Changelog
- **官方 GitHub 实现已确认，不必依赖“自称官方协议”的民间 SDK。** 仓库位于 `Tencent/openclaw-weixin`；`package.json` 声明作者 Tencent、包名 `@tencent-weixin/openclaw-weixin`、当前源码版本 `2.4.10`、`ilink_appid: "bot"`。— https://github.com/Tencent/openclaw-weixin ；https://github.com/Tencent/openclaw-weixin/blob/main/package.json
- **版权与发布主体可交叉验证。** LICENSE 明确写 `Tencent is pleased to support the open source community by making openclaw-weixin available`、`Copyright (C) 2026 Tencent`，使用 MIT。不是只凭第三方文章认定官方。— https://github.com/Tencent/openclaw-weixin/blob/main/LICENSE
- **协议名称应准确表述为“微信后端 API 协议 / Weixin Backend API Protocol”。** 文档明确这是该 channel 插件使用的 HTTPS JSON 协议，默认 API 域名 `https://ilinkai.weixin.qq.com`，CDN 为 `https://novac2c.cdn.weixin.qq.com/c2c`；鉴权类型叫 `ilink_bot_token`，路径前缀 `/ilink/bot/`。因此“iLink Bot API”是有源码依据的技术称谓，但不宜杜撰一个已经正式对外发布的独立“iLink 开放平台”产品名。— https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md
- **可核实的最早软件发布证据是 2026-03-21，而不是 2026 年 11 月。** npm 官方注册表记录此包 `1.0.0` 发布时间 `2026-03-21T13:39:24.601Z`，即北京时间 2026-03-21 21:39；截至调研时 latest 为 `2.4.10`，实际 npm 发布时间 `2026-10-11T01:02:07.263Z`。这只证明包当时已发布，不证明微信产品正式公告或全面开放日期。— https://registry.npmjs.org/@tencent-weixin/openclaw-weixin
- **区分变更日志日期与实际发布日。** 官方 CHANGELOG 将 `2.4.10` 标成 `2026-10-10`，npm 是 `2026-10-11T01:02:07.263Z`；`2.1.8` 在 CHANGELOG 标作 2026-04-07，npm 则是 2026-04-10。报告应注明来源类型，不把 CHANGELOG 版本日期当作精确上传时刻。— https://github.com/Tencent/openclaw-weixin/blob/main/CHANGELOG.zh_CN.md ；https://registry.npmjs.org/@tencent-weixin/openclaw-weixin
- **WorkBuddy 当前文档清楚区分三条通道。** 平台表单独列“微信助理（推荐）”“微信客服号”“企微助理”；微信助理和客服号虽功能相同且均扫码，但 FAQ 明说是“另一种绑定通道”。企微则需要企业微信智能机器人、Bot ID/Secret 或 URL 回调配置。— https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Assistant ；https://www.workbuddy.cn/docs/workbuddy/Assistant-Guide
- **不能把“AI 分身”当成已经核实的协议专有名称。** 本次取得的一手资料用“微信 ClawBot”“微信助理”“OpenClaw 微信渠道”；未取得微信官方公告原文确认“AI 分身”是否为该能力在微信端的正式、当前统一产品名。— 对照 https://www.workbuddy.cn/docs/workbuddy/Changelog ；https://github.com/Tencent/openclaw-weixin/blob/main/README.zh_CN.md

### Inferences

- 用户说“WorkBuddy 和小龙虾都走这个”有可靠依据：WorkBuddy 官方明确宣称集成微信 ClawBot，腾讯也发布了给 OpenClaw 的微信 channel 及 iLink 后端协议。但本次没有 WorkBuddy 源码或网络抓包，**未逐字节证明它与当前 OpenClaw 插件调用完全相同的所有 endpoint、appid、bot_type 或服务端权限配置**。— 依据 https://www.workbuddy.cn/docs/workbuddy/Changelog ；https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md
- 这一路线不是逆向登录个人微信客户端、Hook 微信进程或冒充网页版微信。可信实现直接来自腾讯官方仓库，通过专门的 bot token 与微信服务通信；仍不能由此推导“读取全部私人聊天、联系人、朋友圈”等权限。— 依据 https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/login-qr.ts ；https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md

### Gaps

- 未取得微信官方公众号/官网最初发布 ClawBot 的公告原文，不能确认正式宣布日期、首次灰度日期以及全球/全账号开放日期。npm 首发和 WorkBuddy 版本日期已独立核实，但二者不能替代微信产品发布公告。
- GitHub 搜索元数据曾显示仓库创建于 `2026-03-27T10:17:43Z`，但进一步直接访问仓库 API 触发匿名速率限制，未完成稳定复核，**不把它作为正式发布时间结论**。创建时间即使属实，也不等于 npm 首发或功能开放时间。查询入口：https://api.github.com/search/repositories?q=openclaw-weixin&per_page=10
- WorkBuddy 文档 sitemap `lastmod=2026-11-02` 是站点级更新信号，不能用作每段内容的初次发布日期；接入指南页面没有读到清晰的首次发布时间。— https://www.workbuddy.cn/docs/sitemap-workbuddy-workbuddy.xml

## 2. 个人与第三方能否接入？扫码、授权、准入流程是什么？

### Takeaway

**个人使用官方 OpenClaw 插件有明确可操作的公开路径；第三方实现兼容客户端技术上有充分依据，但“第三方产品全面商用准入/服务保障”尚未核实。** 官方流程是生成二维码 → 微信扫码并确认 → 必要时输入手机显示的验证码 → 获得 bot token 和 bot ID → 在主机长期收发；不是先申请企业微信，也不是填写公众号 AppSecret。— [官方 README](https://github.com/Tencent/openclaw-weixin/blob/main/README.zh_CN.md)；[扫码实现](https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/login-qr.ts)；[官方协议](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md)

### Cited Findings

- **OpenClaw 普通用户接入流程公开。** 官方 README 指示安装 `@tencent-weixin/openclaw-weixin` 插件、启用插件、运行 `openclaw channels login --channel openclaw-weixin`，用微信扫码并确认授权，凭据自动存本地，然后重启 gateway 并检查状态。这里是引用官方流程，本次没有执行命令。— https://github.com/Tencent/openclaw-weixin/blob/main/README.zh_CN.md
- **无需每个用户先申请专属开发 AppID/Secret 的客户端流程已有源码依据。** 官方包静态声明 `ilink_appid: "bot"`，二维码登录前没有要求填用户专属应用密钥；登录成功后才拿到 `bot_token`。但“当前官方客户端使用公共 bot appid”不能等同于“微信已授予 Yuri 自有品牌/独立 appid 的正式接入资格”。— https://github.com/Tencent/openclaw-weixin/blob/main/package.json ；https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/login-qr.ts
- **当前二维码申请使用 POST，而非民间旧 README 常见 GET。** `POST https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3`，JSON body 为 `{"local_token_list":[]}`；本地已有账号时至多上传最近十个已存 bot token，便于服务端识别已绑定端。返回 `qrcode`、`qrcode_img_content`。— https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md ；https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/login-qr.ts
- **扫码状态与二次校验已明确。** `GET /ilink/bot/get_qrcode_status?qrcode=...`；状态包括 `wait`、`scaned`、`confirmed`、`expired`、`need_verifycode`、`verify_code_blocked`、`scaned_but_redirect`、`binded_redirect`。需要时附 `verify_code`，并遵守 `redirect_host` 跳转；成功后返回 `bot_token`、`ilink_bot_id`、`baseurl`、`ilink_user_id`。— https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md ；https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/login-qr.ts
- **授权的核心是 bot 凭据，不是个人微信登录态。** 后续 bot API 使用 `AuthorizationType: ilink_bot_token`、`Authorization: Bearer <bot_token>`，并有 `iLink-App-Id`、版本等元数据头。源码把账号凭据持久化并尝试设置文件权限 `0600`。— https://github.com/Tencent/openclaw-weixin/blob/main/src/api/api.ts ；https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/accounts.ts
- **WorkBuddy 的公开使用门槛可单独核实。** 当前指南要求 macOS/Windows WorkBuddy `>=4.6.4`、微信 `>=8.0.70`、WorkBuddy 与微信同账号登录或已关联、双方正常联网、WorkBuddy 运行中。微信助理无需 App ID/App Secret，助理设置点配置生成二维码，微信扫码，状态变已绑定；解绑后可换账号。— https://www.workbuddy.cn/docs/workbuddy/Assistant-Guide#微信助理接入指南
- **不要推广 WorkBuddy 产品限制为微信协议限制。** WorkBuddy 指南称当前一对一绑定，而腾讯 OpenClaw 插件 README 明确支持一个 gateway 登录多个微信账号。前者是 WorkBuddy 的产品约束，不能写成 iLink 全局只能一账号。— https://www.workbuddy.cn/docs/workbuddy/Assistant-Guide ；https://github.com/Tencent/openclaw-weixin/blob/main/README.zh_CN.md
- **官方对兼容实现提供文档，但谨慎划清契约边界。** 官方协议开头明确面向实现/集成兼容后端的开发者，也明确这是由当前客户端代码整理的参考；客户端类型可选不代表服务端允许缺省，定义字段不保证插件实现其全部功能。— https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md
- **源码的再利用许可是 MIT。** 允许使用、复制、修改、分发和出售软件副本，需要保留版权/许可声明；不提供适用性或不侵权保证。软件许可本身没有授予任何微信线上服务 SLA、账号额度或品牌准入。后半句为许可范围判断，不是声称存在某个未读到的官方政策。— https://github.com/Tencent/openclaw-weixin/blob/main/LICENSE

### Inferences

- **Yuri 可做自用/小范围 PoC。** 从官方公开的 HTTP 实现、扫码拿 token、MIT 许可看，技术上不必为了接入微信强行把 OpenClaw 当 Yuri 的完整运行时；可实现独立通道适配器。此结论是代码可实现性判断，尚未经过真实微信账号联通验证。— 依据 https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md ；https://github.com/Tencent/openclaw-weixin/blob/main/LICENSE
- **面向第三方用户正式发布前，仍应确认准入。** 应向官方确认是否允许独立产品使用公共 `bot` appid / `bot_type=3`、是否要登记产品身份、是否存在账号灰度与地区要求、品牌展示/隐私条款要求、配额和可用性承诺。这些问题不能由“源码开源”或“已经有人做了 SDK”推导为无限制开放。— 依据官方文档的非完整服务端契约声明：https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md
- WorkBuddy 的同账号登录规则不应直接套到 Yuri：它是 WorkBuddy 指南的前提，OpenClaw 官方 README 的扫码流程并不要求存在 WorkBuddy 账号。— https://www.workbuddy.cn/docs/workbuddy/Assistant-Guide ；https://github.com/Tencent/openclaw-weixin/blob/main/README.zh_CN.md

### Gaps

- 未找到足以确认所有个人微信账号均已无灰度开放、无需任何白名单的官方条款；本次未实际拿账号扫码，不将“公开登录代码存在”写成“所有人今天均可绑定”。
- 未找到独立第三方产品登记门户、正式 appid 申请表、商用审核流程、完整 bot 服务条款、配额/价格/SLA 说明。不能断言“无需审核、永不封号、免费无限量”。
- 未验证一个微信账号可同时绑定 WorkBuddy 与 Yuri、可绑定多少 bot、解绑/撤销授权的完整服务端 API、token 有效期、主动推送窗口和限频规则。
- WorkBuddy 的 `微信 >=8.0.70` 是其官方当前接入指南要求，不据此断言所有 iLink 兼容客户端在所有平台的统一最低版本。

## 3. 官方协议能力与 Yuri 适配的最小范围是什么？

### Takeaway

最小适配是**服务端常驻的扫码授权 + iLink 长轮询收消息 + 关联指定 Yuri Bot + 回复消息**。这是独立于微信客服/企业微信的通道，通常只需主机出站 HTTPS；不能按“群机器人、好友聊天历史代理、无限主动推送”设计。— [协议](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md)；[官方 channel 能力声明](https://github.com/Tencent/openclaw-weixin/blob/main/src/channel.ts)

### Cited Findings

| 已核实的协议项 | 官方证据 |
| --- | --- |
| `POST /ilink/bot/getupdates`：长轮询收取消息，使用 `get_updates_buf` 游标并接受服务端建议的 `longpolling_timeout_ms` | https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md |
| `POST /ilink/bot/sendmessage`：发文本与媒体，消息带客户端 ID、目标用户 ID、消息状态与上下文 token | https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md |
| 回复应带回入站 `context_token`；客户端缺 token 仍尝试发送，不证明服务端必然接受 | https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md |
| `POST /ilink/bot/getuploadurl`：获取 CDN 上传参数；媒体 AES-128-ECB + PKCS#7，上传/下载是独立流程 | https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md |
| `getconfig` / `sendtyping`：获取 typing ticket 和显示/取消输入状态 | https://github.com/Tencent/openclaw-weixin/blob/main/src/api/api.ts |
| `msg/notifystart` / `msg/notifystop`：客户端启动/停止通知 | https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md |
| 文本、图片、语音、文件、视频消息类型；工具调用进度类型为 11/12；类型存在不等于所有发送路径完整实现 | https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md |
| 当前官方插件 `capabilities.chatTypes` 为 `["direct"]`；协议类型有 `group_id` 不足以证明可用群聊 | https://github.com/Tencent/openclaw-weixin/blob/main/src/channel.ts |
| `base_info.bot_agent` 可自定义，明确只用于观测，不是鉴权或路由 | https://github.com/Tencent/openclaw-weixin/blob/main/README.zh_CN.md |
| 当前插件遇到 `ret/errcode=-14` 会暂停该账号一小时，不能简单把失效当成空成功；完整服务端失效语义仍需确认 | https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md |

- **官方原始实现优先级高于第三方转述。** `photon-hq/wechat-ilink-client` 自称从官方 npm 包推导，README 仍写申请二维码 GET；当前腾讯官方源码和协议都明确 POST。其 README 把部分媒体 key 编码按类型拆分，但官方当前文档明确三种发送路径都将 hex key 字符串 base64 编码，不能盲抄旧第三方协议摘要。— https://github.com/photon-hq/wechat-ilink-client/blob/main/README.md ；https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md
- **第三方项目不是腾讯官方实现。** `corespeed-io/wechatbot`、`photon-hq/wechat-ilink-client`、`Johnixr/claude-code-wechat-channel` 可用作旁证/比较，不能冠以“微信官方 SDK”；本报告核心可行性不依赖其自述。— https://github.com/corespeed-io/wechatbot ；https://github.com/photon-hq/wechat-ilink-client ；https://github.com/Johnixr/claude-code-wechat-channel

### Inferences

建议后续 Yuri PoC 按下面范围验证，不代表本次已经改了 Yuri：

1. 服务端独立 owning module 管理微信通道，UI 只展示二维码、验证码输入、绑定/断联/重连状态；不要让手机页面生命周期承担持续长轮询。依据是官方长轮询结构与本地凭据模式。— https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md ；https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/accounts.ts
2. 为每次绑定保存 bot ID、扫码者 ID、返回 base URL、安全存储的 token、消息游标；把绑定明确关联到一个 Yuri Bot。允许的扫码者/消息来源须由核心服务核验，不能只在 UI 隐藏入口。依据是官方扫码返回字段、账号隔离和配对能力；“关联一个 Yuri Bot”是本报告的设计建议。— https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/login-qr.ts ；https://github.com/Tencent/openclaw-weixin/blob/main/README.zh_CN.md
3. 首轮只测文字：扫码及可能的验证码 → 收一条消息 → 回复并保留 context token → 主机重启恢复游标 → 失效时提示重新授权；第二轮再加媒体、取消、进度消息、权限批准。依据是协议公开的最小收发路径，不需要先实现全部 OpenClaw 插件接口。— https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md
4. 不新增个人微信账号密码/客户端注入等方案，不把既有微信客服凭据拿来替代 iLink bot token。应在产品和配置上将两条通道并列，避免迁移误删现有客服绑定。依据是 WorkBuddy 官方明确分列通道与两套不同的协议鉴权。— https://www.workbuddy.cn/docs/workbuddy/Assistant-Guide ；https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md
5. 预期主机可以直接出站请求微信长轮询，不需要为了收消息先部署公网回调服务器；这是由公开传输形态推导，未对当前部署网络作实测。— https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md

### Gaps

- 未检查 Yuri 当前代码的具体模块与可复用入口，不给出已确认的文件级实现方案；本报告只判断外部通道和技术接入依据。
- 未做真实授权、收发、媒体传输、并发长轮询、重连、账号解绑、网络代理和限流测试，因此不能声称“Yuri 已能接通”。
- 未验证 iLink 对外推送窗口、主动通知、流式消息更新/撤回以及群聊准入，不把消息字段存在当作能力承诺。
- 工具限制：通用 websearch 返回 HTTP 402；后续通过 GitHub HTTP、官方站点 sitemap、原文和 npm 注册表查证。匿名 GitHub API 后续遇速率限制，主要改读 raw.githubusercontent.com 与仓库页面。
- Context7 已按要求先 resolve `WeChat ilink ClawBot` 和 `Tencent/openclaw-weixin`，仅返回公众号/小程序/企业微信等无关库，没有可用的官方 iLink 文档库；未为满足步骤而查询错误库，也未编造 Context7 结果。具体协议以以上腾讯官方仓库文档及源码为依据。
