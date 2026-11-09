# Desktop Header services / Usage

本切片只拥有 `chat-header-quota.ts`、其测试、`desktop-chat-header-quota.tsx` 和 `desktop-header-quota*`。不改 application、Header 根/core/owner、metadata、Settings Usage controller、Instance/MCP 或 Host。不是整个 PC 1:1 完成的声明。

## main 冻结 API

`DesktopChatHeaderQuotaProps`（从 `desktop-chat-header-quota.tsx` 导出）保留原 snapshot / refreshAvailable / modeAvailable / refresh / mode，只追加：

```tsx
import { createDesktopHeaderQuotaFamilies } from './desktop-chat-header-quota';
// 在外层 keyed Header 内创建一次，不能放在 services/Usage 条件分支里面。
const quotaFamilies = createDesktopHeaderQuotaFamilies();
<DesktopChatHeaderQuota
  // 原 props 不变
  interactive={/* 真实只读交互许可：active / modal / lifecycle 等 */}
  current={/* 真实 captured Host/route authority current() */}
  familyState={quotaFamilies}
/>
```

- 新 family 动作必须 `interactive === true && current?.() === true`，未接这两个可选 props 时只读、不能展开。回调再次同步复验，不能只靠 disabled。
- 原 refresh/mode 仍服从已有 availability，并在事件内复验；新增 props 明确 false 时同步撤销。原 callers 未提供新 props 时不破坏原 availability 合同。
- `modeAvailable` 不是新增 mutator。生产唯一 owner `setQuotaMode()` 依旧 unsupported，main 继续传 false，不发 PUT、不乐观切模式；snapshot 的 mode 来自原 settings GET。测试中的真实生产 consumer 同样传 false。
- 展开 Set 只属于一个 keyed Header，key 是 `[providerId,familyId ?? 'other']`，不同 provider 不串。**当前主 Header 的 Usage 是条件内容，关闭弹层/切 tab 会卸载它**；main 必须在外层创建一次 `createDesktopHeaderQuotaFamilies()` 并通过可选 `familyState?: DesktopHeaderQuotaFamilies` 注入，才能跨模态关闭、tab 与 popup 内容重建保留展开。没有此 prop 的旧 caller 只获得组件生命周期内的本地 fallback，不冒充已解决条件卸载。
- factory 仅创建一个本地 NSH signal，没有读口、存储、全局 store 或第二 quota owner。Host/route scope 更换由外层 keyed consumer 连同 factory 重建；不能在不同 Host 间复用 familyState，也不能把 modal/active 放入外层重挂 key。

## 唯一源与可选 metadata

`HeaderQuotaGroup.desktop?: HeaderQuotaDesktop`：

```ts
type HeaderQuotaDesktop = {
  entries: HeaderQuotaRow[]; // 只含原 aggregate windows，桌面独立 account headings
  families: {
    id: string | null;
    label: string | null;   // null 为渲染时本地化的 Other
    models: { modelKey: string; windowKey: string; row: HeaderQuotaRow }[];
  }[];
};
// HeaderQuotaSnapshot 追加：
showPredValues?: boolean;
lastUpdated?: number | null;
```

- 原 source 同次 payload 解析时创建白名单 `UsageWindow`；只追加保留严格 Boolean `disablePace`。模型保存真实原始 key、首个 window key 和已解析 row；不从 subtitle/display name 反推身份，不留 raw payload、account.user/plan、凭据或任意 user dump。
- 移动 `HeaderQuotaPanel` 不改，仍消费原 `group.rows`：aggregate 后接原模型插入顺序、原已选过滤、原 accountHeading/stale/error、原未知值 `—`。桌面 metadata 不反向覆盖 rows；source 数据边界保持 aggregate 1000、account 200、model 500。
- 桌面按实际 **providerId** 调用 Web `model-families.ts` 分组排序：google 的 Gemini、Antigravity，最后 Other；Magpie 即便 logo/upstream 是 google 也不冒充 google family。非空 selectedModels 按真实模型 key 过滤，空数组为全部；每模型仍只取第一个 window。没有 period filter、普通 entity split 或第二模型目录。
- 桌面 accountHeading 只对 aggregate entries 计算；模型 family 不重复画 aggregate 标签/重置时间。这与 Web Header 不同于 Settings UsageCard 的投影边界一致。
- `usageShowPredValues` 只接纳实际 Boolean true，默认 false；settings GET 失败继续保留原偏好。`lastUpdated` 取本次有合法成功 quota result 时的本地 `now()`，不是 Host fetchedAt；全失败/只有 settings 或空 catalog 不伪造刷新时间，保留 prior。有效兄弟成功可更新全局时间，即使另一组失败；各组 stale/error 仍明确可见。尚无成功时间显示 Web 的 `-`。
- 未改原 GET 路由、显式 quota refresh demand、四并发、配置/hidden 过滤、partial source 保兄弟、成功空清除、clearPrevious、cancel/dispose/retire fence 或 snapshot/sourceQuota 引用判定。Optional metadata 随原 group 一起保留或清理，不新增 reader、catalog、global store、Storage 或 transport。

## Web 数学与 stale

`desktop-header-quota-presentation.ts` 只复用 generated `createUsageQuotaHelpers` 的纯函数，不引入 SettingsUsage 或 controller。格式化使用当前 native i18n locale 与源 timeFormat。

- aggregate pace 尊重 `disablePace`，用原 aggregate key 推断周期；family 与当前 Web Header 一致，不传 label 推断周期，也不额外套用 UsageCard 的 disablePace 规则。
- expected marker 只由 weekly/monthly `dailyAllocationPercent != null` 决定，usage 用 elapsed 百分比、remaining 用反向位置；不受 showPredValues 开关控制。只在 0–100 内部画 marker，不在两端制造边线。
- showPredValues 仅控制 compact 状态点与 prediction/wait；使用已有 status 翻译（内部 exhausted 对应 `settings.usage.pace.status.usedUp`），不新造翻译 key。unknown 值按 Web 留空，不假装 0；∞ 原样保留；进度 clamp，tone 仍取 used 而非 remaining。
- 外层 retained owner 会只 spread group 并 clone 旧 rows 标 stale，不会改 desktop metadata。因此 renderer **必须同时检查 group.stale**，不能仅信任 desktop.row.stale。provider stale/error / row stale/accountError / 已到 resetAt 时保留数值、family 和错误，但撤销 fresh pace/marker。采用既有 provider 级 stale gate，不拿旧 forecast 冒充新状态；合法兄弟组仍显示。sourceQuota 引用回归另有真实 owner 测试。
- 没有行 timer、auto refresh 或第二时钟源。与 Web Header 一样，数学在原快照/模式/本地化变化或 family 显示时计算，不承诺两次刷新之间逐秒倒计时。

## 验证与边界

- source tests：原移动 rows/顺序/过滤，显式身份/family 顺序与真实 provider 语义，白名单/隐私，strict predictions 与本地成功时间，partial sibling metadata 保留、迟到/cancel、四并发与 construction 零 I/O。
- presentation pure tests：Web 原 helper 的 pace/inference、remaining 反向 marker、开关独立、unknown/∞/short/exhausted/disablePace、expired/stale、lastUpdated 格式化。
- `desktop-header-quota-owner.test.ts`：生产 retained owner 的 sourceQuota 引用合同，lane 切换后的 metadata-only patch 不复活 desktop forecast，50 unrelated update 不读/枚举，显式 quota refresh 才更换时间与 metadata。
- `desktop-header-quota-native.test.ts`：独立临时 nsh.json/App/test，固定 NSH 0.4.0，使用真实 `DesktopChatHeaderQuota`、原 mobile `HeaderQuotaPanel`、生产 retained owner/source/bindRequest，并复用 `tests/desktop-header-application/Host.js` strict synthetic fake。macOS/Windows 各覆盖 family/aggregate/account/marker/pace、模式不可写、模态与 lifecycle 保留、**条件卸载/重新挂载**保留 familyState、不同 provider 隔离、source mode/predictions、scope 重建、原手机 rows、unknown/∞/expired、失败保 prior、迟到 authority fence；冷/热各 50 次真实 Input 验证零额外 read、model 枚举与 snapshot commit。

未操作真实 Host、模型、凭据或依赖；不修改 NSH/其它仓库。Headless 是真实引擎的合成 platform-model 证据，不是 AppKit/Win32 实机视觉、物理输入、生产真实账号或整个 Header/PC 验收。main 的新 props/actual-root 接线由 main 独占，本切片不跨文件代接。

### 本轮最终结果

- 相关 pure 回归 **8 文件 / 60 项**通过。
- 新生产 Usage wrapper 内 **macOS/Windows 共 6 场景**通过，包括条件内容重建与 scope 清空；与既有 Header、actual App Header 合跑 **3 wrapper 全通过**。这些 wrapper 会各自编译真实生产组件/根；不等于 main 尚未接入的 familyState 已有 actual-root 证据。
- 整包 `bunx tsc --noEmit -p packages/nsh/tsconfig.json` 与 `bun run --cwd packages/nsh nsh:check` 通过；未另写共享 release bundle 产物。
- `bun run dead-code` 执行，但仍在加载 Web Vite 时被缺失的 `vite-plugin-pwa` 阻断，未取得报告，未添加依赖。
- 扩展跑的旧 `chat-header-ui.test.ts` **未通过**，不计入通过数：native smoke 在等待 `feature/header` 时超时；当前旧 test-app 未初始化连接、只使用 Header 自建 operation，不能拿它证明本次完整移动 Header 验收。另一项静态测试要求 application 出现旧的字面量 `headerRight={<ChatHeaderActions`，与当前桌面条件分支形式不匹配。这两个非本切片文件未改，亦未放宽断言。原 mobile `HeaderQuotaPanel` 同快照真实消费与展示差异，已由新生产测试单独覆盖。

剩余明确事项：main 在外层 keyed Header 内创建/透传 familyState 与 interactive/current，并补 actual-root 的 family 展开→关闭/模态→重开、Host scope 更换场景；quota-mode 仍无真实 mutator；系统平台视觉与真实账号未验。不是整个 PC 已完成。
