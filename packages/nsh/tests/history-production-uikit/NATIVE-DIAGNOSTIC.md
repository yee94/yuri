# 已安装 production App 的 native-only 红灯诊断

原生产重放仍为三块 `[-53,-53,-53]pt`；原SDK adoption未证明、编码帧间1033ms缺口不变。本工具继续定位原生机制，不能关闭原53pt，更不能交strict PASS。只新增独立runner/纯测/本说明；原strict smoke、stationary/moving checker、recorder guard和所有旧artifact保持不变。

当前冻结结论见 [NATIVE-A3-FINDINGS.md](NATIVE-A3-FINDINGS.md)：a3 的 Chat chrome 已确认，但无安全导航目标，不能沿用下文历史 a3 命令盲跑。driver 分开保存 chrome、导航目标、三完整 anchors 状态及全部候选排除原因；现有 AX 缺正文 parent 链、旧 observer 缺独立导航栏边界，下一步由主会话在新 artifact 增加只读 observer，方案及真实 blocking 见该报告。

最新a2实际证据及deadline修复见 [NATIVE-A2-FINDINGS.md](NATIVE-A2-FINDINGS.md)：0次older分页、无mark、探索后段因固定0.76终点退化为10.073pt输入而停止进展；33个native gap中32个与flush同窗。本轮已改成非抛异常alarm、可靠结果持久化、未完成操作不认ACK，并改用实际composer边界作为手势终点上限。a2手动保全不算finalization，原文件原样保留。

main的native a1探索后真实chrome已collapsed，旧parser仍要求expanded控件而在4.7秒误拒绝。现同时识别展开态与完整compact控件组；compact-send可以正常disabled，不将其当启动失败。第二轮a1只有两个完整body（0497/0498）和partial 0495，三anchor门槛仍不满足，但页面身份成立，可以继续有界探索。

## main 直接运行，无需新build

main先自行boot/launch已经安装的冻结 `cec5b612`，保持其production App/Chat在前台。运行仓库中的新入口，不把脚本复制进旧artifact/tools：它只导入仓库已修正的纯匹配/原生计算函数，绝不实例化 `Smoke`。runner不安装、启动、终止App或helper，不执行engine/Host/Git，不调用模型，不创建替代App。它只调用旧包已有的clock/mark/flush文件客户端、读取本机已有helper AX，以及官方tap/gesture。现有observer没有reset/drain API，flush只原子保存；采样已overflow或接近18000上限时需main重启同一个App，不能伪清零。

可直接复用main a1的已有配置文件；runner仅取 `build/clockClient/data/udid/helperOrigin/serveSim`，不使用其中recordBinary、recordCheck、developerDir或framebuffer字段：

```sh
# 纯离线解析，退出码2表示inconclusive，不操作设备，也不读recorder状态。
python3 packages/nsh/tests/history-production-uikit/native-diagnostic.py \
  --inspect-saved .scratch/nsh/history-production-cec5b612-smoke-a1

# 只由main执行；输出目录必须全新，不覆盖a1或artifact。
python3 packages/nsh/tests/history-production-uikit/native-diagnostic.py \
  --config .scratch/nsh/history-production-cec5b612-smoke-a1/config.json \
  --output .scratch/nsh/history-production-cec5b612-native-diagnostic-a3 \
  --modes pagination --max-navigation 12 --pan-distance 0.5 \
  --execute-main-only
```

若sandbox/设备配置已改变，main在新的config里更新实际读口；不改旧证据。可选 `maxNavigation` 为0–64（默认8），`panDistance`为正数且≤0.55（默认0.24），可用上述CLI显式覆盖；输入起点仍来自实际AX/native正文，终点为当帧实际composer/viewport边缘内一个screen pixel，不再固定0.76。不操作offset；<32pt的导航候选拒绝，这是驱动输入准入而非UIKit阈值/位移验收阈值。`modes` 可取 `["pagination", "partial-footer", "body-growth"]`（默认全部），a3仅聚焦首个older事件，其他验收范围不缩减。读capture默认上限64MiB，可用 `--max-capture-mib` 或 `maxCaptureMiB` 配置1–128MiB；超限停止读取，不截取JSON或覆盖原始文件。所有设备/控制文件工作总预算仍70秒，62秒alarm只置过期标志，由同步预算检查结束工作；清理前先屏蔽/取消/忽略pending alarm，失败仍原子保存actions/phases/result。提高次数不保证会执行完，不保证触发页，更不构成通过。完成后的分析只读新目录中保存的数据。App生命周期始终由main管理。

可在任何主重跑前纯离线复核a1折叠阶段：

```sh
python3 packages/nsh/tests/history-production-uikit/native-diagnostic.py \
  --inspect-saved .scratch/nsh/history-production-cec5b612-native-diagnostic-a1 \
  --inspect-phase pagination-01-before
```

## 实际阶段与触发

先从ready绑定真实processNonce/双hash，执行fresh nonce JS↔Foundation clock握手，再flush核对原生采样确实前进、startupSweeps≥1/rejected=0/mutations=0。AX Chat控件与native body共同确认production Chat；正文AX可以没有testID。手势坐标来自实际AX文本范围与native body rect对应，排除内层Scroll、实际header/status/composer区域，优先唯一ANCHOR文字；没有有效对应就停止该尝试，不猜空白坐标。

展开态使用实际AX header控件和composer几何。折叠态使用compact-attach/edit/dictation/latest/send的当帧rect，a1实测最上沿为compact-edit y=780，不沿用旧展开态composer位置。已检查a1 `controlAncestors/windowBounds`：前者只有历史footer祖先/全屏容器，后者只有窗口，均不提供可识别header边界。因此折叠态header明确unknown，不把全屏UINavigationTransitionView当header，不推算StatusBar高度；该状态只允许唯一ANCHOR与完整native body对应的正文范围作为起点，禁止generic状态栏文字、partial body、copy图标或compact范围内文本替补。`*-chrome.json`保留真实状态和几何来源。

探索导航明确标记为 `exploration-*`，保存AX、原生完整capture及scroll/body/footer祖先/load事件，但不mark、不作三anchor验收。实际找到三个不同消息的完整旧body、且有真实250ms静止baseline后，才先调用旧包mark进入 `diagnostic-*`；正文增长目标消息排除在旧anchor之外。缺三块、发生复用/遮挡/减速、读窗或clock模糊均只能inconclusive，不降门槛。

`*-geometry.json`记录footer实际位置、距可见边界的必要位移，以及当前已观察到的三body跨度、完整数量和必要平移区间。a1第二轮三body跨度约755pt，viewport到compact顶部的**最大外界限**为780pt，只有两个body当前完整；在忽略未知header的外界限下，必要平移区间约[61,86]pt，非空，所以这份证据不能证明“始终容不下3”，也不能证明该区间一定无header遮挡。footer完全进入该外界限至少需约3766pt平移，8次小拖动未必可达。几何报告只作可达性证据，不自动写offset或把必要区间当可见性ACK；未知的离屏body也不能据此推断全历史不可容纳。

| 模式 | 实际动作 | cec5b612 normal的边界 |
| --- | --- | --- |
| pagination | 原history-load-older可见就官方tap，否则真实正文pan触发生产自动分页 | 可用；实际older cursor request/20条response必须处于诊断相应窗口 |
| partial-footer | 有真实history-page-error时，点原Retry并观察error retirement及祖先高度 | normal没有脚本503；自动记不可用/inconclusive，不注入错误，不宣称局部footer已测。现有normal loading/按钮祖先变化仍原样记录 |
| body-growth | 真实可见的推理/工具/Activity展开按钮；必要时先探索展开Activity来暴露内部入口 | 可触发生产自然布局/已有slim exact-fill；不是normal源自动流式加段落。若未观察到body增长/新body实例，则inconclusive |

当前normal/terminal都从同一500条tail起步，每页20条；terminal标签不是跳到末页的捷径，真实终页仍需逐页到达。原review的三regions是两个用户短气泡与assistant动作栏，和本诊断的三个完整body不是同一取样形状；后者要求不放宽。原review没有raw message pages，不能臆造原Host payload；本轮不改SyntheticHost、不做minimized carrier，更不把当前合成源当原场景。

每次诊断动作后保存至少一秒实际native读窗；pan只用同一generation连续changed/tracking/dragging区间，release/decel不参与输入扣除。三旧anchor同向位移扣除保守2/scale端点量化误差后，下界>**1.1pt**才可能红，逐采样保留，最终复位不能抹掉单采样红。clock须同App/process、fresh nonce、真实JS往返、前后有界且一致。没有用nominal fps、平滑、延迟历史、裁正文、第二offset writer或SDK内部adoption ACK。

输出只可能 `diagnostic-red`（exit1）或 `inconclusive`（exit2）；没有exit0/PASS。没有录像、coded pixel或完整显示时轴的声明。即使诊断红，也只是合成源下真实production UIKit机制反馈；原53pt仍要回原真实场景验证。

## 输出和优先证伪的假设

完整原生文件是 `*-capture.json`；AX是 `*-ax.json`，`actions.json`只有host调用前后记录，不能当UIKit触摸接收ACK。`phases.json/attempts.json`区分探索和真实事前mark；`native-sync.json`保留真实握手。`*-signals.json`、`diagnostic-*.json`包含逐采样offset/contentHeight/native pan、old body实例/rect、同实例body/row/控制祖先高度变化、Host request/response与native-first-observed。祖先仅按实际实例/role记录，不能命名为未公开的natural/held owner；SDK adoption始终unknown。

排序是下一轮取证优先级，尚不是根因结论，循环前不改production：

| 排名/假设 | 本工具支持它的可取证signal | 可证伪/限制 |
| --- | --- | --- |
| 1. footer footprint释放造成约53pt旧内容位移 | 三旧实例同向位移，与同实例控制祖先height减少约53pt、more/终页或error retirement同窗；raw逐帧保留 | footer/祖先height全程不变而仍红，会削弱此假设。SDK footer wrapper无ID，祖先相关性不能直接认定owner |
| 2. 倒序List分页采用/重排补偿失配 | older request/response之后contentHeight与offset改变、viewport固定、三旧body实例/尺寸不变且有额外位移；footer几何稳定 | 若位移早于请求或仅随body实际增高，不能归因分页补偿；response/first-observed不是SDK adoption ACK |
| 3. 旧row正文、Activity或metadata自然增长 | 同实例body/turn-row height改变或exact-fill/new body出现先于旧内容位移，height差与偏移关联 | row/body几何全程稳定而仍红削弱此假设；normal只能测真实展开/填充，不能冒称growth场景的自动加段落 |
| 4. viewport/chrome变化造成视觉位移 | native viewport/surface/window rect和AX header/composer前后同步改变，旧内容相对viewport关系另存 | viewport/chrome全稳定则削弱；该类变化使三anchor红灯归因inconclusive，不用它造绿 |
| 5. 节点复用或延后布局造成身份误判 | 相同生产ID的UIView实例更换、first-observed与request/response的顺序、bodyIdentityBefore/After及逐帧旧实例缺失 | 实例全程一致仍红削弱复用解释；内部mutation/adoption ticket不可见，不能从首次挂载编造采用时刻 |

## 本轮验证边界

纯离线a1解析确认真实Chat、公开正文范围与native body可匹配，code Scroll可排除；a1仅一个完整旧body加partial，三anchor仍失败。新增纯测覆盖单采样53pt后复位、零变化不出PASS、复用/减速/gap/clock错误、body/祖先高度原始signal、旧normal不伪造partial，以及不允许launch/Host/recorder命令。worker不运行设备/engine/SDK/build；main独占执行上述新目录循环。`Source changed during locked read`仍由source owner处理，独立native诊断不读取或绕改strict recorder guard。

首次交付执行了两个focused Vitest入口（native-diagnostic与既有feedback），内部共26项Python纯测通过；旧smoke a1原始存档离线重放返回inconclusive，真实定位到hp-0498正文，未把三anchor不足变成通过。新Python语法与旧cec5b612 App/tools哈希已核对，stationary/moving checker逐字节不变。该次dead-code已完成且没有本载体条目，全仓仍有其他unused提示。随后main执行native a1暴露了本说明开头的collapsed识别问题，现场53pt尚未复现。

折叠态修复后新增展开→compact连续snapshot、未知header拒绝generic/partial/copy替补、compact实际rect排除、三body跨度、显式导航参数及capture读大小上限纯测。已用native a1的pagination-00/01原始配对存档离线重放：两种Chat状态均识别，01起点对应body0497真实ANCHOR，三anchor仍失败。a1原phase/touches/前后capture、strict源和旧artifact保持不变；新a2仍需main重启同一旧包执行，无需重build。

本次两个focused Vitest入口通过，内部共33项Python纯测（native diagnostic 17项、原feedback 16项）；新语法与cec5b612冻结App/tools哈希再次核对通过。未执行engine、SDK/build、设备、Host或Git；真实a2尚未运行，原53pt仍红/OFF。

以上为collapsed修复的历史验证。随后main真实a2到deadline暴露异步alarm清理race；最新版本另补deadline/真实pending信号、cleanup故障、Popen取消、flush receipt匹配、hard70预算与手动保全审计纯测，结果与a3命令以 [NATIVE-A2-FINDINGS.md](NATIVE-A2-FINDINGS.md) 为准。a2已运行但未finalize，不能沿用上段“尚未运行”作为当前状态。
