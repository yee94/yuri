# UIKit 历史录像独立复核

2026-11-07。仅离线读取主线程提供的中性 fixture 录像与 JSON；没有操作设备、运行 NSH 测试、重启服务或修改生产代码。

## 结论与边界

**已复核的 1,936 个静止阅读窗口编码帧中，三个固定 marker 的最大额外位移与相邻帧位移均为 0px（按本录像 3px/pt 标尺为 0pt），满足 ≤1.1pt；未检出 ≥100pt 的被动单帧位移/回弹。**

覆盖：三次独立自动 20→40 条 adoption、103 行起连续三轮离屏行 +160pt / 尾部追加 / 20 条前插，以及三次持指静止期间 adoption。已交叉检查连续 marker 图、正文时序条带、事件前后原帧，不是只比最后一帧或引用 AX 的零漂移。

这只是**这七段录像里的 UIKit 合成夹具**结果，不是生产修复声明，不是生产真实 Host / Markdown TextView、晚到图片或完整聊天页验收。60fps 录像无法证明编码帧之间、未被录入的实际显示帧也没有瞬态问题。整数像素定位分辨率为 1/3pt，不把压缩图像报告成无限精度。

## 实际录像元数据

所有视频均为 1206×2622，顺序解码结束状态 `AVAssetReader.Status.completed`；PTS 从 0 开始，相邻间隔均为 1/60s（浮点误差约 10⁻¹⁵s），没有发现编码帧时间缺口。帧号从 **0** 开始，时长包括最后一帧的显示时间。

| `.scratch/nsh/chat-frames/` 下文件 | 帧数 | 实际时长(s) | 最后一帧 PTS(s) |
| --- | ---: | ---: | ---: |
| `F22-uikit-adoption-run-1.mp4` | 597 | 9.950000 | 9.933333 |
| `F22-uikit-adoption-run-2.mp4` | 581 | 9.683333 | 9.666667 |
| `F22-uikit-adoption-run-3.mp4` | 583 | 9.716667 | 9.700000 |
| `F22-uikit-validated-growth-tail-prepend.mp4` | 1432 | 23.866667 | 23.850000 |
| `F22-uikit-held-run-1.mp4` | 220 | 3.666667 | 3.650000 |
| `F22-uikit-held-run-2.mp4` | 167 | 2.783333 | 2.766667 |
| `F22-uikit-held-run-3.mp4` | 210 | 3.500000 | 3.483333 |

总计顺序解码 **3,790 帧**，不抽帧做位移计算。名义帧率均约 60；第一段轨道报告 59.999996，其 PTS 间隔仍是 1/60s。完整元数据见 [metadata.json](../../.scratch/nsh/video-analysis/metadata.json) 与 [held/metadata.json](../../.scratch/nsh/video-analysis/held/metadata.json)。

## 有效样本与排除规则

自动分页只使用以下 JSON：每份都有两个 `adopted=0/loading=true` 且 marker 坐标完全相同的静止前采样，随后 `adopted=1/rows=40`。不能用仍在移动的 drag 采样作 adoption 基准。

| 视频 run | `history-uikit-auto-<ID>.json` | 静止基准至片尾（含端点） | adoption 首个新计数帧 / PTS | adoption 前静止帧数 |
| --- | --- | --- | --- | ---: |
| 1 | `1794031774517` | 536–596（61帧） | 571 / 9.516667s | 35 |
| 2 | `1794031787606` | 524–580（57帧） | 554 / 9.233333s | 30 |
| 3 | `1794031800750` | 522–582（61帧） | 556 / 9.266667s | 34 |

`history-marker-0381/0382/0383` 基准 AX y=278/400/538pt，与模板像素 y=834/1200/1614 对应。adoption 时页数 1→2、rows 20→40、adopted 0→1、auto=1/manual=0。静止窗口开始前的真实拖动与弹性回弹保留在逐帧 CSV 和原帧里，但不计为被动跳动。连续图额外保留窗口前 8 帧，可看见回弹收敛而不是人为裁掉 adoption 闪跳。

**保留并排除** `F22-uikit-automatic-run-1.mp4`、`F22-uikit-settled-run-2.mp4` 等旧失败探针；它们把用户拖动/弹性回弹混入基准，不用于本次接受结果。旧 AUTO `1794031554456` 只有 adopted 后样本，`1794031680853` 只有一个 adoption 前样本，均不满足这里的双静止前采样准入。其余未列入本表的旧录像/JSON也没有并入结果。没有删除或改写这些原始证据。

## 三轮增长、追加、前插

只使用 validated 录像对应的**最新三组** JSON，而非更早、before/after 未跨越真实事件的记录。该录像从 page=5/rows=103/adopted=4 开始，到 page=8/rows=166/adopted=7；drags 始终 5，三个阅读 marker 在整段 **0–1431 帧**保持原坐标。

| 模式 | 首个变化帧 / PTS（轮1、2、3） | `history-uikit-<mode>-<ID>.json` |
| --- | --- | --- |
| growth | 150/2.500000、628/10.466667、1112/18.533333 | `2033498`、`2041479`、`2049527` |
| tail | 238/3.966667、718/11.966667、1201/20.016667 | `2034963`、`2042976`、`2051005` |
| prepend adoption | 430/7.166667、910/15.166667、1393/23.216667 | `2038167`、`2046236`、`2054227` |

上表 ID 均省略共同前缀 `179403`。growth 以 `growths` 真正增加为准，不把约 1.8 秒前只改变 `growthMarker` 的点击帧当增高完成。源夹具 `history-uikit-fixture.tsx` 的增高量确为 160pt；增长行分别 0301/0281/0261，位于当前阅读区外。它验证的是离屏行增高对阅读锚点的影响，**不能替代可视 TextView 自然增高/图片加载验收**。每轮 tail +1 条，prepend +20 条且 adopted +1，均核对 JSON 的 before/after。

## 持指期间 adoption

| run | `history-uikit-held-<ID>.json` | 静止窗口 | adoption 帧 / PTS | 前静止帧数 |
| --- | --- | --- | --- | ---: |
| 1 | `1794032537210` | 112–219（108帧） | 156 / 2.600000s | 44 |
| 2 | `1794032542408` | 58–166（109帧） | 102 / 1.700000s | 44 |
| 3 | `1794032548576` | 102–209（108帧） | 147 / 2.450000s | 45 |

三次均为 heldPrepends=1/manual=1/auto=0/requests=1、rows 20→40、adopted 0→1。固定 marker 改为 0397/0398/0399，AX y≈264.333/386.333/524.333pt，对应像素 y=793/1159/1573。AX 约 2.27×10⁻¹³pt 的差是浮点尾差；此处独立像素结果不是从该差值推导的。

只读检查 `.scratch/nsh/probe-history-uikit.ts`：`begin`→10次 `move`→读取 loading 前状态→等待1100ms→读取 adopted 后状态→`end`，请求延迟900ms。视频 header 也呈现请求后约900ms采用，且 adoption 前已有约0.73秒静止编码帧。录像没有触点可视化，**触点仍按下的输入时序由探针与主线程记录支撑**，不声称单凭画面能识别物理手指；画面的连续稳定性则独立逐帧核对。最终保留的窗口同时包含松手后的片尾，不只看采用后的 AX。

## 逐帧方法与可靠性

1. `inspect.swift` / `analyze.swift` 用 AVFoundation `AVAssetReaderTrackOutput` 解码 BGRA 样本，逐个读取 PTS，检查 completed。不是按目标时间抽样，不补帧、不插值、不依赖 ffmpeg/Pillow，也没有安装依赖。
2. 每段末尾原始解码帧作为固定外观模板。每个 marker 使用 x=36..<420、48px 高的二维灰度块（取 BGRA 绿色通道，夹具为中性灰），横向每2px采样、纵向每1px。先搜索 ±6px；低质量时才全阅读区行签名候选搜索，再用二维块核对。坐标是模板块顶边，不是 OCR 字形顶边。
3. **全局候选可能混淆相似编号，绝不凭候选位置直接接受。** `analysis-summary.json` 明确标为 unfiltered；其中手势区的大位移/错配不是被动漂移结果。正式结果只取有独立计数事件及静止前基准的窗口，要求三个 marker 同时匹配、MAE≤1.5（0–255量纲）、距离最佳位置至少3px的局部备选 MAE≥15。
4. 同时逐帧比较完整阅读正文条带：x=36..<1050、从首个 marker y 至2040（横向每3px、纵向每1px）。记录 MAE、灰度差>25且任一像素<200的变化采样点数；>300即报警。正常 footer 的“载入中→较早行内容”和右侧滚动条不在此静止正文区，不把它们误计为锚点移动。三个 marker 和正文条带共同防止相似行误认、空白闪帧或大位移后回归被掩盖。
5. 无时间平滑、投票或忽略单帧异常。`calibration/synthetic-shifts.json` 对原始正文帧注入 ±1/3/4/300/366/414/600px 的独立空间位移；±4px（1.333pt）准确定位，±300px（100pt）及相邻行周期错配均触发正文复合报警。负大位移时出屏 marker 的身份可能不可靠，这已保留，不能解释成精确坐标。校准证明这些平移不会被静止复合检查吞掉，但不是重新编码或真实 UI 的测试。
6. 人工查看每段 adoption 静止窗口所有连续 marker 拼图、增长/追加/前插九事件各±4帧、完整增长录像时序条带，并抽查原始全幅事件帧。时序条带每列对应**一个**解码帧、每行对应一个正文像素行，正文位移会表现为条纹折断；它不能单独识别编号，故只作为二维匹配和原帧的辅助证据。

| 窗口 | 最大 marker MAE | ≥3px局部备选最小MAE | 正文变化采样点最大数 | 最大额外位移 / 相邻帧位移 |
| --- | ---: | ---: | ---: | --- |
| auto 1 | 0.252170 | 17.745985 | 8 | 0 / 0px |
| auto 2 | 0.008355 | 17.717882 | 0 | 0 / 0px |
| auto 3 | 0.004557 | 17.719618 | 0 | 0 / 0px |
| 三轮 growth/tail/prepend 全片 | 1.258355 | 17.740777 | 29 | 0 / 0px |
| held 1 | 0.578559 | 18.385091 | 16 | 0 / 0px |
| held 2 | 0.692383 | 18.398980 | 19 | 0 / 0px |
| held 3 | 0.410373 | 18.379449 | 16 | 0 / 0px |

所有正式窗口均无报警帧。剩余细微灰度差与有损视频压缩一致；不是把残差强行换算成精确几何位移。

## 失败门控与终页：只核对计数证据

- failure JSON `1794032482062`、`1794032507023`、`1794032530469`：失败后 rows=20/requests=1；再3次拖动 requests仍1、旧数据保留；显式重试 requests=2/retries=1/rows=40/error清空。三份一致。对应 `F22-uikit-failure-run-{1,2,3}.mp4` **未做逐帧或平滑度验收**。
- `history-uikit-all-1794032448842.json`：逐页8→20，每次+20条、adopted+1；末态 rows=406=400+6 appended、requests=19/adopted=19。现存 JSON 最后一条 drags=5，**没有保存终页后额外拖动的末态**；探针源代码的该检查只打印结果。主线程报告“后续拖动不增加请求”，但此项尚缺可独立复核的持久化 before/after 证据，不能写成独立验收完成。

## 证据入口与复算

全部产物在 [`.scratch/nsh/video-analysis/`](../../.scratch/nsh/video-analysis/)：

- [window-summary.json](../../.scratch/nsh/video-analysis/window-summary.json)：正式窗口、最大值、报警帧、九事件与门控证据。
- [input-sha256.json](../../.scratch/nsh/video-analysis/input-sha256.json)：本次使用的原始视频及 JSON 哈希。
- [evidence-consistency.json](../../.scratch/nsh/video-analysis/evidence-consistency.json)：3790行逐帧数据与PTS对应、1936帧正式窗口无全局错配候选、原帧留存及15组校准的一致性检查。
- 每个视频同名目录：`per-frame.csv`（所有帧，不仅静止窗口）、`pts.json`、`header-ocr.json`、`consecutive-markers-*.png`、`continuous-<帧号>.png`、`all-frame-ink-raster.png`、`visual-index.json`。held 三段位于 `held/` 子目录。
- 自动/持指窗口逐帧全幅 PNG 均保留，并额外保留窗口前8帧；增长九事件各±1帧保留全幅 PNG、各±4帧保留 marker 拼图。其余每秒原帧和 header 变化原帧也保留。
- [README.md](../../.scratch/nsh/video-analysis/README.md) 记录离线复算命令及列含义。OCR 只帮助定位 header，不作为亚点坐标测量，也没有把 JSON 的探针时间直接当视频 PTS。

本次只验证离线分析脚本可编译、顺序解码完整、证据断言通过与上述可视帧；没有运行生产构建、NSH/设备测试或真实 Host 回归。
