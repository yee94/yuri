# 实测 footer 面积暂留候选（默认关闭）

## 证据与边界

main 已运行的独立旧端 footer-only：`.scratch/nsh/chat-frames/terminal-footer-1794042977692/captures.json`。本 agent 离线重跑 checker 得到 **red，35.999755859375pt，239 个实际事后采样，三个同身份 marker**。原生 offset 保持 0；contentHeight 4116.333→4080.333；footer 36→0；旧内容跟随 −36pt。`adopted=0`，这不是分页身份推断，而是控制项的直接因果回路。

metadata-only 独立材料 `.scratch/nsh/chat-frames/terminal-metadata-1794043133679/captures.json` 同位置测得 0pt/239 samples，只证明**此合成同高文本**没改变几何；不能排除生产 metadata 换行/行高等原因。真实 Host 的 53pt 故障仍红，**36 ≠ 53**。

本轮新增 `packages/nsh/history-footer.ts`，未改 application/history-scroll/旧 fixture；它只返回 footer 自身的 `minHeight`，没有 scroll/inset/offset 写入、定时器或第二锚点。候选释放仍依赖原生 List 的已有补偿，**尚未证明 UIKit 释放无跳动**；若失败，不得推广生产，应回到 NativeShell List 内部 seam，不能增加常驻补偿循环。

`build-wtJRBv` 已被 main 实跑为 **ON 仍36pt红：首次layout早于active而丢失测量**，不是实验通过。本轮修正该真实回调序列及旧UI offset快照歧义，详见 [MEASUREMENT-LIFECYCLE.md](./MEASUREMENT-LIFECYCLE.md)。

## 面积与释放原则

1. 一份 owner 对应一个 Host/session/挂载 generation。实际 footer 可见时，用根 footer `onLayout` 的 **`event.bounds.size.height`** 记录自然高度；不猜 36/44/53，也不测带有旧 minHeight 的隐藏空壳后反写测量。
   首次 mounted 的同scope自然layout可以早于首个active通知并先保存，disabled也可记录；真正hidden/前Host/旧scope不复用。fixture在缺测量的enable边界及真正hidden回来后的实验commit边界使用当前ref只读确认自然height，绝不由core pagePosition推断native offset。
2. 在数据 commit 的**同一个 batch、隐藏条件生效前**调用 `update(nextContext)`。仅同 scope、active、实验已开启、真实 visible→hidden、读取无错、实测高度>0、已有有限 offset 且 `offsetY < measuredHeight` 时暂留整个实测高度。
3. 内容隐藏后的 0 高回调不清除暂留；否则会在下一帧重现红灯。显示真实内容时清除 minHeight，恢复自然内容 owner。局部内容仍可见但变矮、metadata 自身变高/变矮不属于本 helper 的覆盖范围。
4. `onScroll` 只存最新原生物理 y，不发布每帧 UI 快照、不释放。真实 drag-start 标记手势。**到达足够距离仍不在手指/减速期间缩 footer**。
5. 真实 `onScrollEnd`（不是 drag-end、布局回调、请求完成或计时器）后，如果该手势的最终 `offsetY >= retainedHeight`，释放 minHeight。阈值是实际暂留面积，数学上避免原生补偿需要负 offset；这只是候选的可释放条件，不是 UIKit 稳定性的证明。
6. 返回真正 native latest zone 时清理暂留；若仍在真实手势中，延至手势静止，不能中途重排。visible footer 的有效实测高度可保留；隐藏 footer 的 measurement 清空。不要根据 busy/history/SSE 推断 latest，也不要在短列表两端重合时假装存在独立的 latest 返回行为。
7. scope 变化、真正隐藏/销毁会清除临时高度、测量、offset、手势。重现后必须拿到该 generation 的新实际 layout/offset，缺失时保持 minHeight=0，并承认此场景没有保护；不复用其它 Host 的测量。回调须绑定当前 List generation，过期 scope 的 layout 被拒绝。`reset()` 后拒绝迟到测量/滚动。
8. 读取错误不建立新的“终页”authority，不能把失败渲染为空成功；已有暂留不因读错消失。调用方的 `visible` 必须覆盖真实错误/重试/修复入口，而不是只传 more。错误下实际内容继续可见时，自然内容 owner 恢复。

## main 最小生产接线（本 agent 未接生产）

```tsx
const keep = createNativeHistoryFooter(next => footerState.set(next));

// 放在已有权威快照提交动作内，不用 Effect 补一帧。
batch(() => {
  keep.update({
    scope: capturedHostSessionGeneration,
    active: transcriptActuallyVisible,
    enabled: true, // 仅在 UIKit 候选通过后；本交付默认关闭。
    visible: footerActuallyHasContent(next), // more / error / repair / refresh 全部真实入口。
    readError: messagesReadFailed,
  });
  snapshot.set(next);
});

// 原有 historyScroll owner 每个事件仍调用一次。
onScrollDragStart={e => { keep.onScrollDragStart(e.offset.y); historyScroll.onScrollDragStart(e); }}
onScroll={e => { keep.onScroll(e.offset.y); historyScroll.onScroll(e); }}
onScrollEnd={e => { keep.onScrollEnd(e.offset.y); historyScroll.onScrollEnd(); }}

<View style={{ minHeight: footerState().minHeight || undefined }}
  onLayout={e => keep.onLayout(capturedHostSessionGeneration, e.bounds.size.height)}>
  {/* 原来的真实 footer 条件与按钮，不改数据/错误协议。 */}
</View>
```

保留原生 latest listener；在它的当前/非 loading admission 中调用 `keep.onLatest()`。销毁调用 `keep.reset()`。`scope` 是该渲染/回调的 captured generation，不在迟到 callback 内改读新 scope。一次高度暂留不是全局固定 footer slot；用户离开旧端并静止后必须释放到 0，并以独立 native/video 证明未多移内容。

## 独立 fixture 实验开关与计数

- 新 AX：`terminal-toggle-hold`；**冷启动 Hold OFF**，不保高，原始 footer-only 红路径保持。Footer / Metadata 两个诊断开关不变。
- 必须在 footer 尚可见且请求未挂起时开启 Hold。隐藏后不追溯补高度；暂留中不能手动关闭以制造被动收缩。
- `terminal-counters` 包含 `footerExperiment`、`footerMeasuring` 与 `footerHold`：scope、active、visible、readError、measuredHeight、minHeight、offsetY（最新事件缓存，只在其它UI提交时刷新）、gesture、holds、releases、reason。`footerPublishedOffsetY` 单列旧发布快照，允许滞后；每个原生采样的 compact counters 也包含它们。真实最新 offset 以 Swift scrollViews 为准，不把 JS 快照当原生滚动数据。
- `HISTORY_TERMINAL_FOOTER` 记录 layout、开关和释放边界。保留 600 native frames/512 events 的窗口上限，不能拿 ring 最后一段冒充整场完整录像。
- **仅诊断载体**在可释放的 scroll-end 后先 await `before-footer-release` 的真实只读测量，再释放并读 `after-footer-release`。这不是计时器，也不写 scroll；新 drag-start 改变 generation，取消旧异步释放，绝不覆盖新手势。生产最小接线是同步 onScrollEnd，因此异步观测版通过也不免除 main 对生产同步接线的复验。

## main 必须串行的三轮矩阵（未执行）

每轮用新冷启动，先确认新 App build=4、caps/status 正常；ON前还须确认测量来源、measuredHeight>0且footerMeasuring=false。至少三轮，不能只留成功轮。

1. **OFF 负控制**：Hold OFF、Metadata OFF，到 older edge，重复原 footer-only probe/commit。仍应能看见约 36pt 的原始红信号；若原始负控制不再红，先核对数据/viewport/构建身份，不能直接宣布修好。
2. **ON 暂留**：新冷启动，Metadata OFF、Hold ON，真实拖到旧端，`measuredHeight > 0`，offset=0。probe/commit 后：原按钮消失、more=false、loading=false，但 `minHeight=measuredHeight`（公开承认仍有临时空白面积）；核对 native contentHeight 和三个 marker，至少30实际采样、≤1.1pt。保存此 commit 窗口，再进行下一步，避免后续合法用户滚动污染静止窗。
3. **ON 释放**：同轮从旧端真实向最新方向拖过测得高度并完全静止。不能用手动设 offset 或时钟推进。检查 `before-footer-release` native baseline 已是 idle，随后 `releases + 1 / minHeight=0 / measuredHeight=0`；footer 的实际高必须为0、contentHeight 减去实测面积。原生 offset 可由 List 自己补偿（理想为减去同面积），**三个阅读 marker 不得产生额外位移**。无 native baseline、最新手势取消或缺少样本均 invalid，不能忽略。
4. 另做 Metadata-only ON/OFF 对照，不拿同高 metadata 的0pt推断生产 metadata 无因果。然后由 main 才决定是否接生产真实53pt场景；不能将合成36pt通过替代生产通过。

离线命令（不启动设备/engine）：

```sh
bun packages/nsh/tests/history-terminal/check-capture.ts <commit-captures.json>
bun packages/nsh/tests/history-terminal/check-capture.ts <release-captures.json> --release
```

`--release` 独立使用明确 native pre-release capture 和后续 releases 计数筛样，若 >1.1pt 则 red，缺失/移动中/少于30 samples 则 invalid。默认 commit 判定仍可返回历史36pt red。所有 within-sampled-window 都不是整段逐帧视频或真实 Host PASS，录像不能缺瞬态。

## 本轮执行范围

最初 no-retention adapter 9项中7项失败；之后 main 的 ON 仍红又暴露首次inactive-layout缺测量。本轮按该真实顺序先跑出15项中2项失败，修后全目录纯测试 **26/26**、focused tsc、独立 NSH/Swift SDK 构建通过。没有设备、engine、真 Host 或生产接线操作；没有证明候选 UIKit 暂留/释放已通过。
