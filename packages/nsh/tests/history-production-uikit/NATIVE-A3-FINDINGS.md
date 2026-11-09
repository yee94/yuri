# native a3：目标不可用与 chrome 确认分离

本轮冻结在纯离线诊断。只修改 native-diagnostic driver、专项纯测和文档；未调用设备、engine、Host、Git，没有修改旧 artifact、Observer、SyntheticHost、strict checker 或生产布局。原 −53pt、SDK adoption 未证明和 strict unsupported 均未关闭。

## 证据与阻塞

来源：`.scratch/nsh/history-production-cec5b612-native-diagnostic-a3/`，特别是 `pagination-07-before-ax.json` 与同名前缀 capture。此前七次有效 outer pan 累计约 2648pt；这不等于 older 分页或三 anchor 验收。

| 原始观察 | 含义 |
| --- | --- |
| compact 控件组仍在，composer 顶边 y=780 | Chat chrome 成立，不能报告 Chat 未确认 |
| hp-0489 ANCHOR y=757.000169、h=25，底边约782 | 完整 AX 文字越过 composer，不能裁掉底部后接纳 |
| hp-0488 body y=−10.333201、h=701.333313，partial | 不能作为完整旧 body anchor |
| 0488 普通段落 y=26.000142、h=488 | AX 段落虽在窗口内，header 边界和正文 owner 仍未证明 |
| 系统时间 03:32，y=14.666667、h=20.333333 | 纯几何会误映射至0488；必须保持拒绝 |
| 0488 code ANCHOR y=620.000112、h=70 | 位于 ownerID=body-part-hp-0488:text:0 的内层 Scroll，不能用来驱动 outer pan |

上述正文 marker、段落、code marker 和系统时间的原始 AX parent 都直接为 Application。AX 输出没有正文 container/row owner 链，不能把相邻 sibling、相同宽度、标签顺序或共同 Application parent 当作正文归属。driver 记录真实路径，不补造 parent，也不凭段落文本内容识别“正文”。

旧 Observer 的采样入口只 `visit(surface, ...)`；`controlAncestors` 仅由 history-load-older/error/refresh 向上登记，当前类别是普通 UIView、UIScrollView、全屏导航过渡/包装容器及 NshView，没有 UINavigationBar 的独立身份和边界。`windowBounds`、`surfaceInWindow` 只完成坐标系描述，不是 safe header。不能从系统时间位置、设备型号、公开常用坐标或私有类名推测边界。

## driver 修正与不变约束

`chat_ready` 现在只确认实际 chrome。snapshot 总是先保存 chrome、geometry 和 `*-candidates.json`，再由 runner 分别报告 `chromeConfirmed`、`navigationTargetAvailable`、`threeCompleteAnchors`。没有安全 pan 或适用的真实 action 时，停止当前探索；最终 result 保留 `Chat chrome confirmed; no safe navigation target` 原因，不会重新点击项目入口或盲试坐标。

候选报告保存每个 StaticText 的 frame、AX 路径、原始 ancestor 类型/ID/frame、native 匹配及全部适用排除原因；另存所有已观察 body 的 geometry。离屏或未对应的文字也不从报告中消失。ancestry 字段仅供观察，没有新增授权分支。未知 header 时仍须 ANCHOR + 完整 native body；code/nested Scroll 也明确排除。三完整独立旧 body、250ms baseline、1.1pt、原 native gap/clock 规则全部保留，不生成 PASS。

`--inspect-saved ... --inspect-phase pagination-07-before` 可只读重放并输出候选报告（exit2=inconclusive）。不应再用同一旧 observer 执行一轮相同盲探索。

## 给主会话的新独立 observer 方案

这是待实现的采样合同，不是本轮已新增的能力。主会话须使用新 builder/artifact 和新输出目录，旧包及证据原样保留。

1. 在当前 surface 所属真实 UIWindow 的公开 UIKit 层级中，以 `view is UINavigationBar` 发现 bar，保存实际实例标识和 `NSStringFromClass(type(of: view))` 结果；不能用字符串猜私有类。记录发现数量，0 个或多个无法唯一归属时为 unknown。
2. 同一 native sample 记录 bar.bounds、`bar.convert(bar.bounds, to: window)`、`bar.convert(bar.bounds, to: surface)`、window 实例/bounds、surface 实例及其 window 转换；与原 sequence/native 读窗绑定，不使用另一时刻的 header 坐标。公开 navigation controller 若可确切归属，同时记录 isNavigationBarHidden；不能借全屏祖先推断。
3. 记录 bar 自身及 ancestor 的 hidden/alpha、是否在同一 window、祖先裁剪后的可见交集、transform、原始与 presentation frame 的可用性。动画中或坐标无法确定时拒绝 admission。window 的实际 safeAreaInsets 可独立观测，但不能单独把它当 bar 或全部 header 的底边；真实可见 bar、window safe-area 和现有实际 header 控件的保护范围必须分别保留，边界未知就不放行。
4. 字段建议为独立 `navigationBars[]`（instance、runtimeClass、windowInstance、bounds、frameInWindow、frameInSurface、hidden、alpha、ancestorVisibility、visibleRectInWindow、presentationFrameInWindow、readStartNativeMs/readEndNativeMs）及 `windowSafeAreaInsets`。只读采样，不注册第二个 layout/offset writer，不修改 production。
5. 新字段须先离线验证实际 window↔surface↔AX 转换与唯一性。**header 字段本身不补出 AX owner 链**。若仍需要在 partial body 上使用普通段落，应再提供独立的真实正文 text-view→body→transcript 原生实例归属观测，与 AX 文字范围有可核验身份关联；纯几何重叠仍不够。所有完整文字范围必须安全可见，不能裁段落来造目标或验收。

新观测仍可能证明“没有目标”，那就是实际 blocking。只有观测同时证明正文归属、实际 safe header 边界和完整文字范围时，主会话才考虑最窄 navigation admission 改动；这也不能放宽三 body 验收。

## 离线验证

新增固定精度的 a3 缩减回归：真实 Application 根系统时间、partial 普通正文、越过 composer 的0489 marker、nested code marker 全部拒绝；无目标仍落盘 geometry/candidates；最终 result 原因保留。缩减样本复用已有 compact 控件 fixture，完整 a3 原始配对另以只读 inspect 重放，二者不冒充运行验收。既有回归保持，包括原未知 header 系统时间拒绝与旧导航约束。

本轮未定位到名称为066/077的独立原始 AX 配对，因此不宣称已对这两个具体旧样本完成重放；现有文件没有删除或覆盖。主会话若需要这两份证据的逐样本核验，应提供其准确路径；这不影响当前真实 a3 系统时间误匹配的拒绝回归。

验证结果：两个 focused Vitest 入口 `native-diagnostic.test.ts`、`feedback.test.ts` 通过，内部28+16=44项 Python 纯测。mocked runner 确认无目标时不发 tap/pan/mark；Python AST 解析通过。完整 a3 的 pagination-00…07 原始配对另行只读重放：八组 chromeConfirmed=true，00…06 navigationTargetAvailable=true，07=false；八组 threeCompleteAnchors=false。未运行任何设备、engine、Host、SDK/build 或 Git，也未验证新 observer 的 UIKit 实际采样；文档方案仍待主会话实现。
