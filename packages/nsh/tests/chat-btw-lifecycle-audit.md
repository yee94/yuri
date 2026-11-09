# 7561343c BTW 短暂出现后消失：未关闭

main 真实 UIKit build `2026-11-08T01-07-08-495Z-7561343c` / bundle `example.nsh.history-production.run-c22ed682`、显式 ui-parity/reference-105/density100。`.scratch/nsh/btw-7561343c-submit/background-audit.json` 证明 syntheticBtwGenerateCount=1、rejected=0、mutations=0、network=false；它不证明 Sheet 留在界面。

本轮额外核到同目录 `after.json`（本地文件时间09:19:31）确有 Sheet Grabber、问一嘴、固定问题、plain/inline/fenced/emoji 全部答案；约21秒后的 `settled.json`（09:19:52）已无 Sheet，background audit 于09:22:01保存。由此仅能确认“曾出现，之后消失”，不能将问题判为 generate 失败或首次根本没呈现，也不能将 transient answer 判为实际 UIKit code/selection/close 验收通过。

## 当前源码与回调复现

已核 frozen artifact 的 application/BTW/NativeSheet/appearance-feedback/error-notice 和当前对应构造。旧 feedback layer 是普通 absolute View，不是 Dialog/NativeSheet；没有证据证明它占用了 UIKit presenter。notification owner 正在修改其 root/feedback，本批不编辑 application、notification、appearance 或 feedback 模块。

`chat-btw-surface.test.ts` 现在沿生产 lazy JSX 与真实 NativeSheet iOS finish 路径覆盖：accepted question → generate 立即完成 → 实际 NativeAppearanceFeedback 的字体状态 loading→unsupported → 构造仍 open 的 Dialog/registration，断言 Sheet/Dialog/registration/真实 TextView 身份相同、完整答案仍在；不触发伪造 opened 回调来拿通过。该 VM 边界没有复现 disappearance，所以本轮**没有猜测性重开、关闭反馈、计时器或行为性修复**。它不运行 UIKit，不能排除 UIKit/NshAppView 根实际重建。

仍待区分：active/current 失效；实际 dismissed 回调；registration/root 被释放；registration 仍在但 presenting/window/controller 不成立。旧 captured ticket 的 P2 防护不变。

## 显式 fixture 的有界 native 审计

production `NativeSheet` 可接收可选 `diagnostic`，BTW 只传固定数字/Boolean/状态枚举：owner（进程内递增）、ticket、捕获 intent、当前 ownerGeneration、revision、open、active、current、status。没有问题、答案、session/Host 身份、路径、错误或任意用户字符串。其它 Sheet 不必传该 prop。

`ios/SheetPresentation.swift` 的 `NativeSheetLifecycleAudit` 默认 OFF。仅 UIKit fixture main 原本的 `if host.observerDisabled` 分支显式开启，并将 snapshot 注入已有 Host UI 审计；不增加 Host/native grant、请求、writer、timer 或 production 默认持久化。native metadata 再做完整闭合 schema 校验；unknown key、非枚举 status、非布尔标志、负数/非整数/Boolean 冒充数字都拒绝。

native ticket 跨 registration 单调递增；generation 是原 NativeSheet 的真实 generation。phase 白名单为 metadata、metadata-rejected、attach、ready、opened、dismiss-command、dismissed、cancel、released。attach 只在固定 Boolean flags 变化时记录：window/controller/presenting/presented/ready/opened/closing/requested；重复 layout 不刷屏。ready/opened/dismissed 的记录附在已有真实 native emit 旁，不制造事件、不更改呈现/关闭条件。released 来自实际 registration owner deinit。ring 最多32项/8192字节，累计 sequence/dropped 单独保留；默认关闭时不分配审计 ticket、不写事件。此审计不是一般日志服务。

## main 新包读回

现有 builder 已包含 SheetPresentation.swift、SyntheticHost.swift 和 fixture main，无需改 build/Observer。main 合并其余 root owner 后建立**新独立 artifact**，显式 normal/ui-parity 启动；此 worker 未运行设备/engine/完整App构建。

使用原 `Documents/ui-parity/ui-parity-audit.json` 的 background 导出。先核对：

- 顶层 `artifact.buildID/bundleID` 必须是本次新包，`processNonce` 必须是本次进程，`auditTrigger=background`；不要读旧7561343c文件。
- `host.sheetLifecycle.enabled=true`，`schema=1`、`maxEntries=32/maxBytes=8192`。缺该字段说明未加载本轮 native/fixture main，不能用它推断“没有发生事件”。
- 使用 `metadata.owner/ticket/intent` 与 `nativeTicket/generation` 同时区分各代；答案完成看 status=complete，只证明 owner 结果。
- `active/current=false` 先出现则指向权限/lifecycle/operation 退役；`dismiss-command` 指向既有关闭请求；无请求的 `dismissed` 来自真实 native completion；无上述完成而 `released` 指向载体拆除。window/controller false 的 attach 指向 registration/呈现 ancestry。只有 opened 才代表旧 native 注册发出了真实 opened 事件。
- main 为导出而退后台会合法触发 active/current=false 和关闭；须按 nativeUptimeMs/sequence 区分较早的 disappearance 与紧邻导出的预期退后台。background审计自身不能证明退后台前 Sheet 是否可见，仍要保存同一进程的实际AX/截图/交互时点。
- dropped>0 时近期 ring 不完整，不能从缺事件推断根因；用一次短程冷启动复验，不放宽证据标准。

需 main 实际检查固定答案持久可见、代码字形、选区、close/reopen；本轮仍不声明这些通过，不把 synthetic text 当模型品质/费用证明。generate adapter、无主历史写、scope/retry/localabort 与先前 P2 captured ticket 行为均保留。

## 本轮验证与交接

- BTW model/surface/command integration、Sheet presentation、native audit、appearance code consumers：6文件48项通过。
- UIKit fixture Host/build/sidecar：3文件39项通过。并行 root owner 新增 `rootErrorActions.retire` 后，只给既有 Host adopter VM 增加窄 stub，原断言不变，没有改 state/notification。
- NSH 全包 tsc 通过；dead-code 完成，保留既有 workspace entry 提示。
- 最终 audit-disabled 快路径和真实 `fontStatus=unsupported` 调整后，native audit/surface 两文件11项复跑通过。Swift 验证为真实 macOS Foundation ring 执行，以及真实 iOS Simulator SDK 配合 declaration-only NativeShell 边界 typecheck；不是实际 NativeShell 完整链接或 UIKit 执行。
- 本轮未安装/启动设备或App、未连接真实Host/网络、未调用模型、未执行Git或安装依赖。没有改 notification/appearance/error-feedback，也没有操作main独占设备。

验证时点的生产/fixture源 SHA-256（main合并并行工作后再统一freeze；本批不覆盖旧artifact）：

```text
1da0a4b7d4308d8ed4802cfc5e3fdd0a888193bdc8a5b1d25fe6bc5ecd0db6f4  chat-btw.tsx
6f065d5c6383fc1f133502b8d4f6906d576a710ab0f5ade64627560627be8859  chat-btw-model.ts
afa1d7d0442072a655008fd38ff79bb49a7ee58a9b97c210ce915c1ffffb1f6e  native-sheet.tsx
366d43ad0a64720a7ead64e2479111bc71e1acad811928dd2841c5aeed4af0f5  ios/SheetPresentation.swift
4fd9d3dbee8578260d96d8fb044c10858f1d7da60ae99992825b73ad8cbabf5d  tests/history-production-uikit/SyntheticHost.swift
5d28fe1190238b6047a3536515235468a6c577de57af7081772b2ff6f6a0b411  tests/history-production-uikit/main.swift
```
