# History footer 生产 controller

`history-footer-controller.ts` 拥有 footer 的 presentation facts、自然测量确认与失效、自然节点事件 source、List 事件 source 和实验开关。`history-footer-natural.ts` 是正式生产模块；tests 下旧同名文件仅重导出，不存在 App → tests 依赖。原 `history-footer.ts` API 保持兼容，只新增自然测量与滚动输入失效方法。

**真实生产53pt仍红，实验默认OFF。** 本模块没有 scrollTo、offset/inset 回写、timer、隐藏/裁剪正文或等待历史采用的机制。倒序 List 继续独占滚动补偿；完整 footer visible→hidden 只接受 `successful-history`，局部收缩及 transcript row 高度变化仍未解决。纯测试不证明 UIKit 通过。

## 当前主页面装配与独立复核

`application.tsx` 的 Chat 已同步接入 controller：真实内层自然 View 与外层 footprint 分离，只按 natural generation 重建内层，不重挂 List。loading 文案、语言、宽度和字体变化使自然测量失效。List 的 drag/scroll/rest/momentum/load-more 全组先检查捕获 generation 和实际页面/lifecycle，再委托原 historyScroll/chrome；`onLoadMoreAtStart` 仍安装并经原 admission 进入 latest。暂时覆盖或后台只同步 activity、保留 facts；永久卸载才 dispose，不依赖相同历史 presentation 再次发布。

独立 oracle 原先发现的“旧事件仍影响分页/chrome”和“临时退役清空 facts”已静态复核关闭。实际 Chat AST 回调回归保存旧整组事件，执行无新 facts 的后台往返，验证旧分页/latest/drag-end/momentum 不调用当前 owner，新 latest 仍可读取；主回归与 controller/presentation/诊断五文件合计72项通过，随后补齐旧 chrome 调用次数断言的12项再次通过。AST harness 不运行 NSH props wrapper，不能代替原生派发证明。正式 bundle 已观察到 List 的事件 props getter；原生排队事件是否读取最新 handler、原生 mutation/adoption 身份与实际自然高度仍待平台取证。

## 创建与同步数据提交

在 `createChat` 前创建一次 controller，`current` 使用已存在的页面/路由/lifecycle authority，不能引用尚未赋值的 `chat`。`changed` 同步写既有 footprint signal。初始 UI 可使用 controller 的 `snapshot()`；不要在 callback 创建测量 Promise。

```ts
const footer = createNativeHistoryFooterController({
  current: () => current() && nav.routes().at(-1) === props.route && lifecycle() === 'active',
  changed: value => footerState.set(value),
});
const footerState = signal(footer.snapshot());
const chat = createChat(props.target, {
  beforeHistoryPresentationFlush: footer.beforeHistoryPresentationFlush,
});
```

`beforeHistoryPresentationFlush(next): void` 在现有 writer batch 里同步执行。它只读 supplied final facts，先决定 footprint，再让原 writer 写数据；不测量、不 await、不阻止加载，即使当前 ref 的确认永不结束也如此。scope 编码固定顺序的 Host/generation/owner/historyGeneration/targetKind/id/directory，不从未提交的 getters 猜值。

`syncActivity(): void` 在真实 route/lifecycle 可见性变化时调用。即使 Host/history scope 完全相同，真实 inactive→active 往返也退役旧自然/事件 source；恢复必须捕获新 source 和取得新自然测量/原生 offset。第一次 mounted inactive→active 则保留同一次真实初始 layout。旧事件在页面失活而 effect 尚未执行时也会被 `current()` 拒绝并清理。

`reset(): void` 退役当前范围及全部测量/事件；用于 Host/page operation 退役，新的有效 presentation 才建立新范围。`dispose(): void` 永久拒绝后续所有动作。二者都不能由旧 completion 重新激活。

## 自然节点绑定：source 不可复用

`captureNatural()` 返回一组**同身份、不可变**的 `ref / onLayout / confirm / retire` 方法。它显式替换上一组；调用一次对应一个实际自然节点绑定，不在每次读取 footprint/滚动事件时调用。返回值必须用局部 `const` 捕获，不能放在可变槽位中让旧 callback 在执行时重新读取新 source。

```tsx
// 位于该自然节点实际构建的位置；外层持有 footprint，内层只量真实内容。
const natural = footer.captureNatural();
<View style={{ minHeight: footerState().minHeight || undefined }}>
  <View ref={natural.ref} onLayout={natural.onLayout}>
    {/* 所有真实 more/error/boundary/repair/gap 内容，保持既有行为。 */}
  </View>
</View>
```

`ref(node)` 首次绑定且只绑定该节点；相同节点的重复通知不重新授予代际。`ref(null)` / `retire()` 永久退役该组。A→null→A 继续调用旧组时不会重新激活；直接换成 B 也退役而不是悄悄换名。新节点必须**新 capture 并安装这组新的实际事件闭包**。旧组的 null/layout 不能卸载、清高或覆盖新组。

Controller snapshot 的 `naturalGeneration` 在 scope、内容身份、真实可见性代际和 reset 时改变，`eventGeneration` 在 scope、真实可见性代际和 reset 时改变。装配应在这些边界重新安装对应的 callback source；不要仅在旧闭包内调用 signal/getter 获取新 source。不要由 `minHeight` 或 `measuredHeight` 每次变化触发重建 source，否则会无意义地丢弃确认。原生 SDK 若将旧事件重新派到新闭包，仍缺 native mutation ticket，JS 无法伪造这个保证。

确认入口 `natural.confirm(): Promise<'confirmed' | 'stale' | 'unavailable' | 'failed'>` 只读该 source 当前的自然 ref，不读外围 held wrapper。可在真实 ref 已绑定或显式诊断确认动作内调用；不放入 pre-flush、分页等待链或发送链。返回值不会授权历史提交。`confirmed` 也只证明 core 自然高度获准，绝不是 native frame/生产 PASS。`measuring` 与 `measurementError` 是明确状态，错误只保留固定内部代码，不泄露底层异常内容。

同 source 新 layout 可超越 pending ref read，后者不能覆盖新高；若该新 layout 已确认有效，confirm 可使用这个当前确认。layout0清除自然确认，hidden echo 不污染暂留。真正换 ref/content/source、后台、reset、dispose 都使 pending 成果失效；失败之后真实新 layout 或显式新确认可恢复。

`setContentKey(key): void` 由真实 footer 内容/版式 owner 提供额外身份，例如 loading文案、语言/字体/宽度。controller 本身已包含 more/error/boundary/repair/gap 的完整身份；额外 key 变化立即失效旧自然测量与 closure，不能将旧 key 的 height 重新标成新 key。它只声明失效，不等待新高度、不替局部收缩制造补偿。实际采用新内容后再给新绑定测量，不能在 pre-flush 量尚未更新的树。

## 单一 List 事件输入 source

`captureEvents()` 返回不可变的 `onScrollDragStart/onScroll/onScrollEnd/onLatest/retire`，同一 controller 同时仅一个 event source有效。新 capture 退役前组并丢弃旧 gesture/offset输入，不保留旧 source 的手势授权。将它与已有 historyScroll/chrome 在**原 List 事件链**组合，各 owner 只调用一次，不再加 listener 或滚动 writer。事件闭包也必须局部 const 捕获，不在旧闭包里取新组。

```ts
const events = footer.captureEvents();
const onScroll = e => { events.onScroll(e); historyScroll.onScroll(e); chrome.scroll(e); };
const onScrollDragStart = e => { events.onScrollDragStart(e); historyScroll.onScrollDragStart(e); chrome.begin(e); };
const onScrollEnd = e => { events.onScrollEnd(e); historyScroll.onScrollEnd(); chrome.end(); };
```

`onScrollEnd` 同栈释放，不 await 测量/日志，不用 drag-end 或 momentum/layout/request completion 冒充真实 rest。scroll只更新私有事件输入，1000次不会发布UI。`onLatest` 仅从原 `historyScroll` 已通过 current/loading admission 的 `loadLatest` 内调用；**原 `onLoadMoreAtStart={historyScroll.onLoadMoreAtStart}` 必须保留**，它仍启用 NSH keyed reading anchor，不能另绑 footer source 替掉它。

`setEnabled(true)` 必须是显式实验行为；缺自然高/offset 时没有保护，也不阻止历史采用。`setEnabled(false)` 在已有暂留时返回 false，避免开关中途删面积；其余成功返回 true。暂留只在有真实手势、最终rest offset足够，或原已授权latest入口时释放。inactive/reset/dispose仍按生命周期清理，不把离开页面当成功释放验收。

## 已锁定的反馈与剩余工作

`history-presentation.test.ts` 通过实际 `createChat` writer 和 dependency-tracked mock batch执行生产controller：真实加载40行与37.25pt的**合成自然测量**同一flush；pending或永不返回的ref不阻塞加载。去掉成功authority传递时实测回归红灯（数据40行但footprint0，预期37.25）；恢复后绿。此数字只用于数据合同，不能代替真实53pt。

`tests/history-terminal/footer-component.test.ts` 编译并执行实际 fixture TSX 创建的 ref/onLayout 闭包；旧可变layoutSource在A→null→A时实测红，修复后旧callback拒绝且新capture可确认。它没有复制组件闭包或将字符串匹配当机制证明。NSH引擎、UIKit派发仍由main独占复验。

最小无损 next step：先接此controller取真实生产footer内层/外层native高度、request/commit/row身份与原生List采用时刻；将最后完整隐藏、错误局部收缩、Activity/metadata自然行高变化分开因果测量。若仍移动，修正点必须在NSH倒序List的单一keyed-anchor adoption事务，关联用户输入与header/footer/row自然高度差并处理旧端clamp；不能追加JS offset/inset补偿。部分收缩、行高变化、连续视频与native clock exchange未完成前，生产53pt保持红。

## 本轮实际验证

- `history-footer-controller.test.ts`：9项通过，覆盖实际ref/layout/event回调链、隐藏effect前的门控、同scope往返、新旧capture交错、失败恢复、pending确认超越与1000次scroll零UI发布。
- `history-presentation.test.ts`：17项通过，包含两个实际createChat→生产controller回归；撤销成功authority传递时目标回归确实为0vs37.25而红，恢复后绿。首次冷transform超过默认5秒导致的超时不计作通过；这两个新数据合同测试的工具执行期限为15秒，几何/authority断言不放宽。
- `tests/history-terminal`：62项通过、1项skip（未提供旧build5 raw replay环境变量），包含实际fixture事件闭包P2反证；没有运行engine。
- `tests/history-types.tsconfig.json`（明确包含生产controller）及 `tests/history-terminal/tsconfig.json`：均实际通过。
- 隔离fixture builder `node --check`通过，源码manifest已新增正式natural-reader文件；未运行builder或生成新App。
- `bun run dead-code`重新执行并检查：全仓124 unused files / 798 unused exports / 6 duplicate exports；隔离fixture动态入口仍被列出，未删除其它owner文件，不声称零告警。
- 真实像素负控制仍 −53pt / exit1，原档和阈值未改。本轮先前并行测试/tsc超时不计作通过，随后串行完成上述专项。

以上均为离线合同与静态证据。新的source闭包、生产接线、native释放与视频仍须main和独立oracle复核，不冒认旧build6的包身份或生产通过。
