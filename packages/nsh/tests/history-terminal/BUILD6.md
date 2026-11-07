# build6：连续原生post-prefix持久化修正

**最新状态：main已实跑build6三轮，三ON commit/release原生连续窗口通过；完整视频仍未通过，生产53pt仍red。旧build5三release raw仍invalid。**

新证据：`.scratch/nsh/chat-frames/footer-sync-1794050810169517000/results.json`。独立离线审计见 [build6三轮观测审计](../../../../.scratch/nsh/build6-observation-audit-1794050810169517000.sNMq7L/README.md)。下文构建与采集delta保留交付时记录；最新实测结论见文末。

## 新唯一包

- App：`packages/nsh/.nsh/history-terminal/build-aMux1y/HistoryTerminalFixture.app`
- manifest：`packages/nsh/.nsh/history-terminal/build-aMux1y/manifest.json`
- build **6**；Bundle ID仍为 `com.yee94.yuri.nsh.history-terminal`。
- executable SHA256：`0ceaacb7a85ee196a377dfdb99b01e919e9f6dce46a72ac407c7e1d62d81d5d5`
- bytecode SHA256仍为 `c8cb744eababaf13998ddad8c5423ff9bc4b60923f89ea253ef4b9a771c52601`：**helper和TSX fixture未改，哈希与build5一致**。新Swift observer/checker不再把缺periodic post误称为未观察到任何原生释放点。
- 默认Hold OFF、releaseMode sync；旧diagnostic await模式与所有selector保持。旧包及原始证据不覆盖。

## 精确原因

离线审计：`.scratch/nsh/footer-sync-audit-1794049126777017000.hpGrK7/README.md`。

三份release文件的最后周期帧就是cachedPre；native显式post在1.26–2.16ms后已看到真实footer0、natural0、contentSize减36与offset减36，counter也更新。**文件缺连续post-prefix，不是窗口时钟错、也不是AX一直旧，更无证据要改实际release seam。**

旧probe最后点`terminal-capture`后立刻copy，未等异步持久化ACK；三文件最后都是即时after-release snapshot，没有最终manual事件。已用实际Swiftactor和受控gate纯回归重现相同持久化race。

## 最窄修正

- 只有本fixture的observer/storage Swift和checker/测试改变；不改application/state、NSH外部库或TSX/helper。没有offset/inset/scroll命令，没有释放timer/rAF，也没有更改onScrollEnd时序。
- 采样走到cachedPre之后原有**4000ms native窗口**时，自动异步发布完整prefix，不依赖最后一次UI保存点击恰好完成。它是取证发布触发，不是释放条件，sampler不停止，也不等布局“看起来成功”才保存；几何若未收起、gap或瞬态，仍原样保存并让checker红/invalid。
- 文件含`persistedSnapshotRevision`、`snapshotNativeUptimeMs`、`lastPeriodicNativeMs`、`lastPeriodicSampleSequence`；事件含`nativeObservation.phase=post-window-snapshot`。版本只在实际原子写入中提交。
- `terminal.capture`返回发生在持久化ACK之后，现有AX `captures`计数随后才增加；tap进程退出不是ACK。
- checker不修改250ms pre、180post/3秒、4000ms选窗、50ms gap、1.1pt、0.5pt end-offset或原生footprint要求；只对空post输出明确`prefix`诊断。显式测量点不注入periodic帧、不代替连续样本。

## main脚本最小delta（此agent未编辑/运行main脚本）

`.scratch/nsh/run-footer-sync.py:13` 先将BUILD指向 `build-aMux1y`，manifest随BUILD派生。

旧 `.scratch/nsh/probe-history-terminal.ts:52–53` 最终保存必须等待：

```ts
const previousCaptures = (await read()).counters.captures;
await tap('terminal-capture');
await waitFor(s => s.counters.captures > previousCaptures);
// 此后才copy，而不是把tap返回当保存完成。
```

复制后仍要校验文件含release后的manual事件、同包双哈希与原生periodic prefix。若有其它尚未完成的capture，这个计数只证明某次ACK：务必以文件里的manual native timestamp晚于release receipt、frame frontier及严格checker再次确认，不能只凭计数判绿。不要用固定sleep替代ACK；也不要重新取终点伪装缺帧补齐。

保留既有真正用户drag与取证post等待，不改手势/释放逻辑。`terminal-counters`读到`releaseMode=sync`，Hold只用`terminal-toggle-hold`显式启用；`terminal-toggle-release-mode`仅用于独立旧诊断对照。

R2/R3 OFF实际都被切出前台：R2录像切到composer autocomplete fixture，R3在r2/loading时出现切出。main必须独占UDID/自动化资源并保存失败的完整AX根节点与前台证据；保持Wrong foreground fail-closed，不盲点或收为有效OFF。

## 严格复验（main设备执行，本agent不执行）

三轮新目录保存OFF/ON原始captures、AX、日志及完整录像，逐次核对新包identity；原生与视频分开判定：

```sh
M=packages/nsh/.nsh/history-terminal/build-aMux1y/manifest.json
bun packages/nsh/tests/history-terminal/check-sync-capture.ts <新captures.json> "$M"
bun packages/nsh/tests/history-terminal/check-sync-capture.ts <新release-captures.json> "$M" --release
```

不能把build5 raw传入新manifest冒认新包。旧raw诊断重放必须使用旧manifest或原有双哈希；它们应继续invalid，不能把显式0高或最终视频端点改成通过。新录像仍独立完整decode/帧gap审查，不用native绿代视频绿。

## 本轮实际验证

```sh
NSH_HISTORY_SYNC_RAW_RESULTS=.scratch/nsh/chat-frames/footer-sync-1794049126777017000/results.json \
  ./node_modules/.bin/vitest run --config packages/nsh/tests/history-terminal/vitest.config.ts
./node_modules/.bin/tsc -p packages/nsh/tests/history-terminal/tsconfig.json --noEmit
```

- 10文件/56测试通过；不提供env时raw replay显式skip，synthetic失帧/瞬态/阈值守卫常规执行。Foundation持久化测试仅macOS，使用真正的`TerminalCaptureWriter`/`TerminalPostWindow`，不加载UIKit/NSH。
- SDK静态build、codesign严格验证、plist lint、所有manifest源码和实际包双哈希、精确两terminal调用capabilities通过。
- 本地cached Knip按根脚本flags运行并检查（无下载）；未删除动态入口候选或其它owner代码。
- 六视频已完整离线decode6809帧；7对关键编码端点×3marker：OFF−108px、ON commit/release0px。但三release gap431.7–450ms，末帧后5.1–6.9秒无新独立帧，仍无视频完整通过。
- 交付构建阶段未运行engine/UIKit/设备/真实Host/生产main build/Git，未读设备容器，未下载依赖。main后续三轮已完成，见下文；**不得宣布整scope、partial shrink或生产53pt完成**。

## main build6三轮后的离线审计

六probeExit均0，九份快照实际重放原严格checker，结果与main逐字段一致。manifest、实际App executable/bytecode双hash和九raw身份均匹配。首次审计全部manifest源码hash吻合，收尾发现并行工作区 `packages/nsh/model.ts` 已变化，单独记入audit的 `workspace-source-drift.json`；其余记录输入及实际包hash未变。本轮未改该文件、helper/release/checker或阈值，不声称当前全部源码仍与旧包一致。

| 轮次 | OFF commit原生 | ON commit原生 | ON release原生 | release最大native gap ms | frontier超4秒截止ms | 完整视频 / 生产53pt |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | red 35.999755859375pt | 0pt，连续窗口通过 | 0.000244140625pt，连续窗口通过 | 20.214 | 2566.536 | 视频未通过；生产仍red/未验收 |
| 2 | red 35.999755859375pt | 0pt，连续窗口通过 | 0.000244140625pt，连续窗口通过 | 22.010 | 2598.854 | 视频未通过；生产仍red/未验收 |
| 3 | red 35.999755859375pt | 0pt，连续窗口通过 | 0.000244140625pt，连续窗口通过 | 23.921 | 2618.156 | 视频未通过；生产仍red/未验收 |

三release均为revision9、20 pre和240 periodic post（另有1 explicit point），所有periodic post实际footer/natural为0且viewport idle。各有release receipt之后的manual，以及可在真实周期帧中对齐的post-window-snapshot事件；最终frontier超原4000ms窗口，droppedFrames0。最终文件证明完整快照持久化，未单独保留中间revision8文件，不能单凭最终文件证明自动写入完成时刻。

六片完整解码7731实际帧、232 OCR帧，所有PTS递增。九对关键编码端点三marker：OFF−108px、ON commit/release0px；另对commit后首4秒全部实际编码帧及release后全部24帧做配准并读图，没有在这些帧中发现marker位移。但三ON commit gap111.667/115/95ms，release gap430/448.333/431.667ms，release后还各有5.472/5.507/5.523秒无新编码帧，**完整无瞬态视频验收仍未通过**。不能用原生绿或末帧持有替代缺失的视频证据。

本次离线审计只写新audit与本文；未操作设备、engine、真实Host、新App构建、Git、依赖或网络，未触碰生产state或其他owner代码。fixture窗口结果不代表生产53pt、partial shrink或完整Host/page/history scope通过。不重复跑设备。
