# Remote Project 验收记录

依据：[确认后的 spec](remote-projects.md)。本文件记录验收状态，不替代 spec。

## 状态定义

- 未验证：还没有符合验收口径的运行证据。
- 未通过：已测量且失败，或者缺少必需功能。
- 已通过：有匹配构建、环境、数据集及断言/测量的证据。

实现代码、单元测试通过或生产构建成功，不等同于跨端或性能已通过。

## 当前结论

2026-11-12 范围收紧：按用户最新要求移除新增手机终端及文件页/手机 MCP 独立配置面板；既有桌面终端、文件、Git、预览的远端适配保留。机器 → 目录入口复用统一 Dialog/Sheet，目录 IO、注册 model、展示 Adapter 分层；Query mutation 接管提交状态，ReactUse 接管事件与挂载生命周期。参考会话的移动卡片/菜单及 ViewModel 分层保留。完整审查说明：`.scratch/remote-projects/scope-audit-result.md`。

本轮 7 文件64项定向、3文件29项Adapter回归通过；UI type-check通过，focused ESLint无错误（既有3条路径规范化warning），dead-code已检查，新增产品模块无未使用命中。完整UI最终 **10518通过、8失败、111跳过**，失败名称与 `mobile-remote-structure-ui-all.log` 的8项逐项一致，无新增失败；日志 `scope-audit-ui-final.log`。中间整包的6项新增测试失败来自footer替身与重构后的源码定位，已修复并复验，原日志 `scope-audit-ui-all.log` 保留。

隔离浏览器使用生产展示组件、目录model及CSS，核对1280桌面明暗、390手机明暗及320窄屏、长机器名/路径。发现步骤文字受挤压换行并修正，最终无横向溢出；10张截图与测量在 `directory-visual/`，手机目录3张为修正后重拍。fixture数据为内存Host，不是实际安装版App/SSH/Relay验收。浏览器空间和本轮视觉服务已释放。

故事43限既有桌面终端，45改为现有整窗配置管理，52排除手机终端；下文手机Terminal等旧证据仅属历史，不再是当前实现要求。完整性能、真实UIKit与跨端平台门槛仍未通过，本轮未恢复已暂停的平台任务。

## 历史增量与原始证据

移动项目卡片与职责拆分增量：远端手机项目改为复用 `MobileProjectCard` / `MobileSessionRow` / 移动浮动分组，桌面复选框、可见拖拽柄和常驻新建文件夹按钮不再进入手机卡片。`RemoteProjectSection` 仅组装；读取/投影、操作与回滚、展示契约、桌面/手机适配器及可选资源分别归属独立模块。菜单统一复用 `MobileActionSheet`，保留图标、触感、分组和禁用状态。5文件61项定向回归通过，含新增两端文件夹层级/折叠/拖拽命令矩阵；随后补入离线缓存仍可见、菜单禁用且不发写请求的断言，UI整包 **10510通过、8失败、111跳过**。8个失败名称与 `native-mobile-final-ui.log` 完全一致，本轮相关5文件61项仍全部通过。日志 `mobile-remote-structure-ui-all.log`。UI type-check早期通过，最后复查在本轮未修改的 `DirectoryExplorerDialog.tsx:200` 因缺失 `remoteProjects.next` 翻译键失败，不将当前工作树标为类型检查全绿。focused ESLint零错误（`MobileProjectCard`原路径规范化warning保留），dead-code已检查，新增模块无未使用命中。独立浏览器fixture以生产组件/CSS和内存远端数据核对390×844明暗主题、长标题、项目菜单与折叠；实际读取截图，窄屏无横向溢出、无checkbox，折叠组padding为0。证据目录 `.scratch/remote-projects/mobile-cards-visual/`；定向日志 `mobile-remote-structure-tests.log`。这是隔离浏览器展示证据，不是安装版iOS、原生IME或真实触摸拖拽/侧滑竞争验收；完整平台与性能门槛仍未通过，旧客户端hash不代表当前源码。

用户截图增量修正：移动端远端聊天不应出现左侧prompt缩略导航。本机入口已有移动端排除，`RemoteChatContainer`此前却直接传递桌面偏好；现仅将该prop限定为`!isMobile && promptNavigator`，桌面开关保持不变。mounted远端入口回归先复现mobile=true时错误传true，修复后mobile/desktop与偏好四组合通过；连同composer/rail共18项通过，UI type-check、两份文件focused ESLint通过。日志`mobile-rail-red-confirmed.log`、`mobile-rail-green.log`。未声称新手机构建/截图已复验。该修正又改变RemoteChatContainer.tsx/test及chat DOCUMENTATION，因此上一轮b310febe客户端清单不再代表当前源码；后端未改。用户要求后续工作由main直接执行，不再委派。

最新收口增量：性能第二阶段backend8为 `f638cb476c1d400a98b972dd6000b1faa7d3566bac6f0b8314b23f21bb6b3dfa`，完整Web **4059通过、20跳过、0失败**；50次普通JSON消费后deadline **51→1**。桌面baseline/candidate各20次实际帧区间对比，最保守P95回退上界 **+2.17%**，仅限该桌面本机fixture，不是完整跨端首paint通过。RSS正反向12轮开关仍约+45.25/+45.50MB，归因未闭环。原始来源见`performance-owner-result.md`及`performance/owner/final-verification-post-json.json`，未升级完整性能门槛。

main已修IME通知去重遗漏composition状态：生产Swift方法编译回归先红后绿，保持同文同选区去重且允许composition状态转换。新客户端2871文件hash `b310febe498184ee48804d79fea9b18ae2381778b9b1f3e1bf53ac272c9985c6`，清单`client-source-ime-completion-final.json`；main核对backend8零漂移。Mobile整包105通过、仅原CSS1失败、5跳过，UI bridge/session/closed-picker25通过，focused ESLint通过。旧三字段source-shape断言的中间失败保留，随后更新为包含composition的断言。真实UIKit完成回调、panel owner与跨listener竞态仍需新native构建复验，未宣称平台修复完成。详细交接`main-ime-completion-handoff.md`。

main上一轮Web整包回归：**4047通过、20跳过**（308文件通过、6跳过），日志`.scratch/remote-projects/main-final-web-regression.log`，退出0。覆盖scope/file-header/Terminal admission收尾后的后端源码，早于下述deadline性能补丁，不能作为新后端整包或正式性能证据。

最新源码检查点：客户端 `6c1785e501297a521339d401f357ac303cb2c554d5d3b29bc5e208c6b883be59`（2870文件）已补前台远端native资格及手机Terminal菜单/生命周期，UI10515通过、仅原8失败，Mobile104通过、仅原1失败，全仓typecheck/lint通过。历史client2870/backend5复核见`main-remote-native-mobile-terminal-verification.json`；性能补丁后backend5已失效，新backend7为 `e0f5ff9417acc5e21fa0783ce69ec200306baa80de8f893e153e183a6a83c7c9`，见`performance-owner-backend-source.json`。独立iOS候选未被性能补丁修改，平台结果须保留原构建来源。收尾由main集中推进，性能由同一个完整owner负责。

### 取消后的deadline资源回收

统一性能报告：`.scratch/remote-projects/performance-owner-result.md`。真实隔离Hub的两轮12次开关中，关闭后的远端deadline timer由 **792/784降至0/0**；保持原超时长度、正文预算、TimeoutError、共享、容量和释放行为。main已审阅helper及Gateway/transport调用边界。定向后端90项、既有性能19项、远端计数30项、工具20项通过。

main对新backend7完成Web整包：**4054通过、20跳过**（309文件通过、6跳过），退出0、360.97秒。日志`.scratch/remote-projects/main-deadline-regression.log`，回执`main-deadline-regression.json`；运行前后client2870和backend7逐文件及aggregate均匹配、零漂移。该结果覆盖取消后deadline回收补丁，不代表后续优化源码或平台/性能预算通过。

这些是development/synthetic loopback和profiler诊断，不是生产Electron/iOS预算。修复后释放时RSS仍较起点约+13.16/+14.61MB，每状态10MB/每内容30MB尚未证明；历史故障隔离+33.27%保留为未解决。下一优先候选是普通JSON消费结束后的deadline显式释放，须先量化收益，不能在收到headers时清除正文超时。正式串行比较等待平台资源释放与测量窗口交接。

完整 spec 尚未验收。候选 `9e5eea3cf4ed0f1d8cf3690f8ad7e6e7f6e90327c5adb00eb3571dda4c1e349e` 已通过 Electron 首次添加/自动发现、初次模型选择与实时回复、真实选区往返、文件资源图和附件校验。候选 `122e6bae1cba62c09cac99b7ac6c9b5b9b070a97aead5fcfe0fe818fe04699fd` 已通过双链路桌面Terminal UI/FilesView，以及iOS远端Web首次添加/发送、A Relay-only/B direct MobileFilesSurface图、有效图片上传与新回复。后续635d18补充了远端native及手机Terminal实际证据，仍有panel owner、迟到原生事件和IME完成通知缺口；Q→A已确认为UIKit自动更正，不据此修改产品回写。平台已释放窗口，原性能owner继续新冻结、优化和独立可用场景的正式比较；有功能阻断的场景不能标性能通过。正式baseline/candidate、L数据集及真实网络画像仍未完成，故障隔离性能历史有一次超标。以下历史轮次保留原始结果，不能跨hash合并为当前源码全部通过。

修复前收口结果：主agent Web整包 **4037通过、20跳过**（308文件通过、6跳过；`.scratch/remote-projects/web-contracts-final.log`）；UI owner整包 **10459通过、仅原8失败、111跳过**，新增失败0；全仓类型检查通过。Web生产构建和Electron release-profile main bundle通过（`build-web-contracts-final.log`、`bundle-electron-contracts-final.log`），没有发布或安装到用户真实应用。这些结果不代表后续修复源码或真实端到端通过。

### 冻结候选真实失败与修复状态

完整证据见 `.scratch/remote-projects/performance/candidate-final/DIAGNOSTIC.md`，2703 个交接文件匹配冻结源。以下失败保留，不以 reload 或手动同步作为通过条件：

- 自动索引：Hub 摘要及 renderer index-changed 已到达，正常展开仍无会话；手动同步才出现。iOS 新增远端后需重启。已确认 global WS 的 Host 帧未进入 Yuri bus；生产 ingress 现已接通，真实归档帧驱动 mounted 侧栏红→绿，待平台正常添加/展开复验。
- 初次远端 scope：历史/模型为空，持续 `Remote Host connection changed during request`；reload 后恢复。修复事件入口后 mounted Provider 能自动重绑新 entry，旧请求仍被 fence 拒绝；未放宽 generation，但真实初开故障尚不能据此宣布消失。
- 实时回复：真实模型已生成，同 canonical directory/session 的 started/delta/ended 经 Remote SSE、Hub SSE 到达 renderer WS，但 5 秒内不显示新回复；reload 历史可见。与自动索引共享上述 ingress 断点，真实归档21帧有序子序列回归已转绿；首 delta 在新 history read 之前出现，待平台真实发送复验。
- 输入：本机→远端→本机草稿保留，选区从 6–21 丢为 0–0。已补 composer owner 级卸载捕获/恢复，按 store 与 immutable DraftRecord 隔离；mounted 真实 ChatInput→RemoteChatContainer→ChatInput 回归恢复6–21，无新增 focus/scroll。iOS 搜索框可输入而 composer 未保留文本、未显示键盘、未发送，工具与产品焦点原因尚未分清。
- 文件入口：Remote optional read 返回 `x-yuri-file-exists:true`，Gateway 丢失该头导致真实入口 `Failed to open file`。现仅补网关响应白名单，并补附件所需的大小、摘要、MIME、文件名请求头；未放宽 UI guard。真实生产 FS routes→Remote→Hub 两项红测转绿，覆盖存在/空/缺失文件、二进制及 JSON 原字节、中文文件名、摘要不匹配拒绝、Hub 凭据不转发。联合 Gateway/FS/file-target/CORS **92 通过**，focused ESLint 通过（`gateway-file-headers-{red,green,joint}.log`）。Electron/Capacitor 实际文件入口与完整资源图仍待复核。

冷 renderer bootstrap、布局保存/重开、scoped 文件 HTTP 和真实 node-pty WS 有独立证据；不能替代侧栏、聊天、文件与终端 UI 完整验收。正式性能比较待同一功能场景转绿后恢复。

UI修复最终交接：`.scratch/remote-projects/final-ui-native-fix-result.md`。完整UI **10473通过，仅原8失败、111跳过**；完整mobile **103通过、原CSS1失败、5跳过**；全仓type-check与完整UI lint通过（0 errors、150既有warnings），dead-code已检查。客户端2709文件hash为 `c01ff1c29ddc1d981e9bffb2c7d11fe23e917215617cb66a73733e5f383f9c17`，不是完整平台产物hash。主agent复核客户端清单及本轮Gateway三文件清单均 `changedSinceCapture=[]`（`main-ui-file-handoff-verification.json`）；平台任务已接重冻结复验，旧候选失败证据保留。

### 新候选 2f2c50ba 的真实复验

完整6238文件冻结、两份交接清单全部匹配、独立 Electron/iOS 构建成功且结束零源码漂移。证据：`.scratch/remote-projects/performance/candidate-ui-native/DIAGNOSTIC.md` 与 `FIRST-SCOPE-HANDOFF.md`。

- Electron 正常添加后的项目/会话自动出现通过；没有手动同步、reload 或额外 admission/summaries/active 读取。
- 首次 scope 选模失败、未发送。约3.064秒内676条 Host status 含675个不同物理 generation；主agent核对原始网络，同窗口 `/fs/home` 发出677次、`/fs/list`162次。目录 picker 随物理代际更换取消/重发请求，最后无引用短请求释放连接，下一请求再产生新代际，形成反馈循环。
- 正常本机/远端往返后的独立发送场景通过：真实配置模型生成，420ms内 ChatViewport 新增回复。该值是功能窗口内 DOM 观察，既不是精确 paint，也不能合并成首次 scope 通过。
- 草稿文本隔离仍通过；真实 Home/Right/Shift+Right 已建立6–21选区，返回后仍为0–0。前轮 mounted 回归不能证明平台修复，UI owner继续查真实导航/焦点边界。
- iOS 签名/安装/配对通过；首次添加远端目录持续连接中，随后 AX 超时，未重启 App/Simulator 补成功。只读 UIKit/WKWebView 仍可观察，超时不足以证明产品主线程死锁。FilesView/MobileFilesSurface完整资源图、附件、Terminal UI仍未验收。
- 单独 iOS 输入诊断已锁定产品边界（`performance/ios-first-input/UI-OWNER-HANDOFF.md`）：聚焦时 input-view/HID 模式变化产生 keyboardWillHide，Web 回调主动 blur，native 回调主动 resignFirstResponder；软件键盘触控、删除及后台恢复有成功对照。不能泛化为全部 iOS 输入不可用，也不能用软件触控成功抹去硬件输入切换失焦。

首次 scope 的后端修复新增 `scopeGeneration`：按授权/目标配置身份稳定，物理 `generation` 继续隔离旧连接事件。无引用短 HTTP 结束仍关闭连接、零状态订阅/后台扫描；配置变化、凭据A→B→A、删除后同ID重加均刷新scope，晚到物理响应仍拒绝。三项真实HTTP红→绿，remote-hosts联合 **41通过**、focused ESLint通过（`gateway-scope-generation-*.log`）；后续UI配套收口见下一节，首次真实入口仍待复验。正式性能待新同一候选功能转绿后恢复。

### 客户端 eb568e6f 源码收口（待平台复验）

最新交接以 `.scratch/remote-projects/client-production-coordinator-result.md` 顶部为准。UI配套现已完成：稳定scope保留同一entry/query，真实scope撤销、退休token、缺字段降级与unavailable边界仍拒绝旧请求；chooser在JSON消费后再次检查scope，无首次连接自激重发。

真实定向选区红测进一步确认：恢复6–21后，`TextSelectionMenu` 的session-switch清理调用全局Selection清空，使聚焦textarea变0–0；二次合法卸载再保存了0–0。现仅在聚焦chat textarea时跳过该全局清理，菜单关闭与其余清理保留；生产诊断探针全部撤除。修复后的真实往返仍待复验，不把mounted红→绿外推平台成功。

iOS Web/native已将keyboard hide与结束编辑拆开，保留显式结束编辑、导航和独立后台blur。新原生壳的Web定向软件Q/delete及HID/minimized后继续输入已有独立证据（`real-input-fix-coordination.md`），native完整六阶段及真正主动dismiss仍待交接；不是远端Chat或完整手机矩阵通过。

最终UI **10501通过、仅原8失败、111跳过**；Mobile **104通过、仅原1失败、5跳过**。全仓typecheck、lint通过；dead-code已检查。主agent已读取原始汇总、失败名称对照，确认生产探针标识搜索无匹配。`client-source-scope-selection-ios-final.json` 含2869文件，POSIX lexical配方hash为 `eb568e6fe8591627df3d9e63f0cc91b310b6eb6497adb84f40ae50084b3de370`；与Gateway四文件清单均逐项匹配，见 `main-scope-selection-ios-handoff-verification.json`。此为源码范围，不是完整构建输入或已验收平台产物；平台任务已接新冻结/首次scope与真实发送复验，定向输入任务继续其独占设备，不合并旧候选结果为新候选全绿。

Web 中途整合轮次曾因共享 UI `session-ui-store.ts` 的 `explicitProject` 重复声明导致 1 个套件加载失败（`.scratch/remote-projects/web-regression-integrated.log`）；修复后的下一轮完整通过：305 文件、4019 测试通过，6 文件及20测试跳过（`.scratch/remote-projects/web-regression-worktrees.log`）。之后的远端索引初始化/form修复另以30项网关回归及 focused ESLint 复核，不把上一轮整包数冒充更新后结果。

中途 `MobileSessionStatusBar.tsx` 的可空 `session.time` / 不存在的 `time.pinned` 类型错误已修复。最新客户端交接的全仓类型检查通过（`.scratch/remote-projects/client-integrated-typecheck-post-dialog.log`）；UI整包10441通过、仅原8失败、111跳过，新增失败0（`.scratch/remote-projects/client-production-ui-regression-post-dialog.log`）。源码hash见 `client-source-post-dialog.json`，不是完整构建候选冻结。后续补齐布局/预览后需重新验证。真实 server smoke 复核通过；dead-code 报告无 Remote Project/Host 新命中（仍有仓库既有项），repository-neutrality 与 diff whitespace 检查通过。

## 功能追踪

### 新候选9e5eea3c及Terminal修复

`.scratch/remote-projects/performance/candidate-scope-selection-ios-final/FUNCTIONAL-HANDOFF.md`记录6250文件冻结、2869客户端与4后端清单匹配、独立构建与结束零漂移。

- 正常首次添加自动出现会话，无Sync/reload/预先离开返回或inspect GET补成功；home1次/list3次/summaries3次，添加阶段5条Host状态、1个logical scope/4个wire，后续初开选模和发送无churn。
- 首次scope真实指定模型streaming后405ms内ChatViewport出现新回复，仅为功能窗口DOM证据，不作正式paint或性能预算。
- 真实键盘Home/Right/Shift+Right建立6–21，正常local→remote→local后仍6–21，文字保持且远端不串。
- 正常FilesView入口完成A Relay-only/B direct同名文件完整CSS/module/dynamic/fetch/image/nested iframe资源图，内容隔离；实际附件入口上传并发送，temporary storage的fixture SHA256一致。
- 实际Terminal创建200、WS101但无输出/marker，约10秒重连。旧2f Relay成功不替代本轮失败。main真实terminal runtime回归已确认Hub在二次鉴权前未安装接收器，丢失即时binary `ok`；现socket创建即收消息，按1MiB/256帧有界缓存、二次鉴权后保序/保类型flush，撤销/超限/关闭均不转发。直连、真实E2EE Relay和安全边界联合 **97通过**（`gateway-terminal-admission-joint.log`），仍待实际Terminal UI复验。源码范围见`gateway-terminal-admission-source.json`。
- 新候选iOS远端添加/发送/MobileFilesSurface尚待定向native交接；正式性能继续暂停。任务进程/设备已精确清理，原始失败保留。

### Terminal新backend 122e6bae：实际双链路通过

证据 `.scratch/remote-projects/terminal-ui-platform-result.md`。新6252文件冻结与backend5匹配、零drift，客户端仍eb568e6f；前端产物按源/依赖/资源逐项相同复用9e，backend实际解析至新目录。早期node_modules错误映射到旧9e的轮次另存`candidate-terminal-admission-workspace-miswired/INVALID-RUNTIME.json`，不计通过。

A Relay-only及B direct均走正常sidebar→底部Terminal→新标签→canvas焦点→真实逐键输入；实际 `ok → UI自发b → bok`、可见marker及完整pwd、远端marker/cwd文件字节全部核对，分别93/92条输出帧，关闭面板通过。同候选FilesView完整资源图也通过。没有手工HTTP/WS bind替代UI；截图已实际读取，时间戳不用于正式性能。精确清理`remainingOwned=0`。

iOS定向交接 `.scratch/remote-projects/performance/input-targeted-final/PLATFORM-OWNER-HANDOFF.md` 已解除资源等待：该组合d17仅有focus、HID继续字符、HID状态主动dismiss通过；软件Q/delete及software→HID切换因旧硬件模式前置blocked，navigation/background前未聚焦，不能证明结束编辑。主平台已接继续手机远端链路，并要求fresh软件键盘以及导航/后台前实际firstResponder前置；不以旧e39/d17结果补齐新候选。完整64故事与25性能gate仍未通过。

### iOS新backend验收增量与剩余缺口

`.scratch/remote-projects/performance/candidate-terminal-admission/IOS-HANDOFF.json` 对应122e backend、eb568客户端/原生源及独立签名App；6252冻结文件、backend5和client2869均无漂移，实际workspace/backend解析正确。

- 远端Web：正常配对Hub、机器picker添加、自动会话、首次模型、软件Q/delete与真实dismiss、实际发送/流式新回复通过。不是远端native通过。
- MobileFilesSurface：手机到Hub正确Relay配对后，A Relay-only/B direct完整资源图及截图通过。有效104字节PNG的上传请求/声明/响应/远端磁盘SHA一致，实际prompt200、仅1个文件，图片与新完整回复可见。
- 首个68字节PNG自身CRC错误、替换时仍残留坏附件、早期测试Hub30分钟超时以及不含Relay的初始配对均单独保留，不作为产品成功或已证实产品失败。有效图片场景含一次误触留下的额外`a`，该场景不声明原文字严格保留或之前附件移除成功。
- 远端native缺口明确：开关1/plugin可用，但`RemoteChatContainer`的secondary输入surface被primary-only gate排除，实际为WKContentView而非UITextView。UI owner正在补正确前台native资格与Host/draft隔离，不以本机primary替代。
- 本机native的软件Q/delete、HID和真实已聚焦前提下导航/后台DidEnd及20字符草稿保留有证据；但单字符Q在transcript dismiss后AX显示A，原因未证实，定向诊断继续，未宣称exact-Q保留通过。
- 实际手机workspace菜单无Terminal。spec第52条明确要求手机远端终端，已交UI owner补入口/复用既有scoped终端能力，不能用桌面双链路通过代替。
- 本轮14个进程、3台专用设备均已清理；17项工具测试、28项语法检查通过。它们不替代功能或性能验收。正式性能继续暂停。

Q→A后续定向归因：`performance/candidate-terminal-admission/ios-q-diagnosis/DIAGNOSIS.json`。main已核对原生调用栈和先后顺序：真实transcript触控后，UIKit `acceptAutocorrection → applyAutocorrection → replaceRange`先产生`DidChange("A")`，随后NativeComposer上报A，最后产品hostTap调用blur结束编辑。没有产品A写入先于替换，排除工具误点、JS/native echo及draft回写作为起因。搜索框保留Q仅作不同控件配置的对照。原exact-Q保留失败不改写；后续测试应验证正常系统提交后的确切文本与draft/恢复一致，不能关闭自动更正或简单改成固定期待A来掩盖任意替换。此诊断零产品改动/零构建，17项工具测试通过且自有资源清零，不放行完整功能或性能。

### 候选635d18：手机native与Terminal平台交接

证据：`.scratch/remote-projects/performance/candidate-remote-native-mobile-terminal/PLATFORM-HANDOFF.json`。完整候选 `635d18d06836c2dc4c2de9357ff7c3c754a57a5f7dd2449f5e3743b118095cae`，客户端为6c1785e5、后端仍为旧backend5；冻结源、签名App与安装产物零漂移。**以下结果不能转记到新backend7 e0f5ff94。**

- 真实native软件/中文候选/HID输入及导航、前后台恢复有证据；同session/cwd的不同Host文本、Agent、模型、附件属性隔离通过。
- 手机Terminal Relay A/direct B完成已测生命周期，包括正常入口、可见输出、关闭/返回及socket释放；关闭最后tab会创建替代PTY，不能声称关闭即零PTY。
- 手机Files双Host实际HTML依赖图、独立WK有效PNG上传与真实新回复通过；原生图片picker使用JPEG表示，不宣称保留原PNG字节。
- 剩余：真实remote-chat panel的唯一native owner尚未从受支持入口验证；34条原生文本事件未观察到跨scope，但未刻意复现旧UIKit payload到新listener竞态，且原生DTO无owner token。
- 中文候选提交后native markedText为空，最后捕获的JS `textChanged.composing`仍为true，完成通知未通过。main源码复核发现`YuriComposerView.emitTextChange`只按文字/选区去重，未包含composition状态；仅composition变化时有被去重的路径。具体UIKit完成通知顺序及可见autocomplete影响仍待复现，不能把文字恢复通过当成完整IME通过。
- `EXCLUSIVE-WINDOW-RELEASED.json`明确释放：13自有进程、唯一设备、14监听端口及构建/测量/helper均无残留。main整包同时已完成，性能窗口已交给原单一性能owner；main不并行运行构建、测试或设备操作。用户既有开发服务不擅停，也不据此声称全机空闲。

本轮没有产品/依赖修改，没有正式25项性能结果，也未完成64故事验收。

| 故事 | 范围 | 验收状态 |
| --- | --- | --- |
| 1~16 | 机器选择、双写关联、幂等失败恢复、实例视角 | 未验证 |
| 17~27 | 侧边栏、运行状态、离线镜像、整理信息 | 未验证 |
| 28~40 | 对话操作、权限、配置候选、草稿与断线恢复 | 未验证 |
| 41~46 | 既有文件、git、桌面终端、预览；机器配置走整窗切换 | 未验证 |
| 47~53 | 手机当前 Hub、前后台、既有项目工具（无新增手机终端）、明确不支持的平台 | 未验证 |
| 54~58 | 授权、凭据边界与 Hub 内容零持久化 | 未验证 |
| 59~61 | 通知去重与导航 | 未验证 |
| 62~64 | 整窗切换兼容、本机零回退 | 未验证 |

## 性能追踪

| 编号 | 核心门槛 | 验收状态 |
| --- | --- | --- |
| 1 | 无远端零新增请求/订阅/定时器 | 未验证 |
| 2 | 本机冷启动回退 ≤5%，≥20 次 | 桌面20+20实际帧区间子集上界+2.17%；缺完整跨端/首presentation证据，整项未验证 |
| 3 | 既有性能套件阈值不放宽 | 未验证 |
| 4 | L 数据集离线冷启动不等待远端，回退 ≤10% | 未验证 |
| 5 | 无关项目 selector 零重算、引用稳定 | 未验证 |
| 6 | token/delta 不触发结构重排 | 未验证 |
| 7 | Host 状态只更新对应行 | 未验证 |
| 8 | 输入 P95 ≤16ms，零 ≥50ms 输入长任务 | 未验证 |
| 9 | 按键不扫描 host/模型/agent/Provider | 未验证 |
| 10 | picker 按需拉取不阻塞文本回显 | 未验证 |
| 11 | 缓存会话 ≤100ms 可见 | 未验证 |
| 12 | LAN/Relay/SSH 冷热连接最新状态时延 | 未验证 |
| 13 | Hub 转发额外 P95 ≤50ms | 未验证 |
| 14 | 断网 ≤2s、恢复补齐 ≤5s，无重漏乱序 | 未验证 |
| 15 | 弱网输入与滚动预算不退化 | 未验证 |
| 16 | 别处启动会话 ≤2s 显示运行 | 未验证 |
| 17 | 无客户端 10 分钟零远端资源 | 部分证据：601.17 秒无新增远端请求/流；全部 socket/timer 未内省 |
| 18 | 每 host 单状态订阅 ≤10MB，空闲 CPU <0.5% | RSS正反阶梯未满足归因/稳定性条件；最新源码300秒CPU未测，旧0.110%不外推 |
| 19 | 内容订阅有界且无损，每订阅 ≤30MB | 共享、8路容量/第9路429及最后观察者释放计数通过；12轮RSS仍约+45MB，单订阅门槛未验证 |
| 20 | 故障 host 不拖慢其他 host 超过10% | 未通过：两轮 HTTP P95 回退 +2.38% / +33.27% |
| 21 | 全局与单 host 刷新预算有界 | 计数契约已通过：单runtime上限1，真实5Host全局峰值2、单Host1、结束0；见performance-owner-result.md，不外推跨链路时延 |
| 22 | Hub 持久化远端 message/parts 零行 | 部分证据：隔离 Hub 全数据目录未检出正文 canary；完整场景未验证 |
| 23 | 手机实时通道数不随 host 增长 | 未验证 |
| 24 | 手机后台释放、前台 ≤2s 刷新 | 未验证 |
| 25 | 手机 L 列表滚动零 ≥50ms 长任务 | 未验证 |

## 测量约定

CPU 统一使用单逻辑核 100% 的进程 CPU 口径；常驻内存取稳定后 RSS 增量并单列 heap；不得只用强制 GC 后 heap 代替 RSS。网络额外延迟用同一受控路径的直接访问对照，避免跨机墙钟偏差被误算为 Hub 开销。LAN/Relay/弱网分别报告。

输入同时记录同步处理和 input-to-next-paint，IME、粘贴、撤销、picker 关闭后输入均覆盖。性能提升不得通过减少会话、丢消息或淘汰仍在使用的资源达成。

## 实施初始检查

- `bun install --frozen-lockfile`：按锁文件安装已有依赖，未添加依赖。
- `node scripts/ensure-node-better-sqlite3.mjs`：Node 24、ABI 137 探针通过。
- `bun run type-check`：全部 workspace 通过；这是实施初始状态，最终改动需重新验证。
- `bun run --cwd packages/vscode test`：45 文件、341 测试通过；不是 VS Code 获得新功能的声明。
- `bun run --cwd packages/mobile test`：16 文件通过、1 文件失败、2 文件跳过；103 测试通过、1 失败、5 跳过。失败为 `test/android-native-ime.test.mjs:80` 的既有 CSS 字符串断言，目标 CSS 已有额外 Assistant 排除条件。测试及 CSS 与分支基线无差异；本任务未改它们。此结果不得记成移动端整包通过。
- `bun run check:repository-neutrality` 与 `git diff --check`：初始文档和在途改动检查通过，最终仍需复核。

## 独立性能基线

- 基线提交 `d4fc9e5400c94cc14934e9c895a40efa57fe58d6` 已在独立临时目录提取、安装冻结依赖并完成生产 Web 构建；不使用正在改动的源码冒充基线。
- Apple Silicon、macOS 26.5.2、Node 24.18.0、Bun 1.3.14；基线测试原始结果保存在 `.scratch/remote-projects/performance/`。
- 既有侧边栏、SSE、closed-picker 性能回归：19 测试通过；avatar 基线自身为 `test.skip`，因此第 3 项完整门槛仍未验证。
- 当前实现的相同 19 项回归也通过（`.scratch/remote-projects/integration-counters/`）。5 个测试文件中 4 个与基线 hash 相同，另 1 个仅给 VM fixture 增加 `allProjects` / `remoteNavigationTargets` 上下文，原断言与阈值未修改；不据此宣称真实输入或 avatar 门槛通过。
- L 数据集、fake HTTP/SSE Host、证据格式、测量器的工具自测：7 测试通过。工具自测不计为产品门槛通过。
- 工具与复测命令见 [测量说明](../../scripts/remote-projects/README.md)。真实 Electron/iOS 输入和首帧、真实 Relay/SSH、长期 CPU/RSS 及全部跨端门槛仍需独立证据。

## 首轮整包回归（在途实现，不是最终验收）

- Web：`bun run --cwd packages/web test`，304 文件通过、1 失败、6 跳过；3995 测试通过、1 失败、20 跳过。新增 Relay-only 真实 E2EE 项目关联用例收到 503（预期 200），已要求修复，原日志 `.scratch/remote-projects/web-regression.log`。首次 120 秒超时不计结果，随后 600 秒预算内完成（350.57 秒）。
- UI：`bun run test:ui`，987 文件通过、7 失败、26 跳过；10173 测试通过、14 失败、111 跳过（92.63 秒），原日志 `.scratch/remote-projects/ui-regression.log`。
- UI 失败归因：将 7 个失败文件在独立 HEAD 基线上重跑，6 文件的 8 个断言同样失败（BtwPanel 2、SetupTourDialog 1、ScheduledTasksDialogRequests 1、MobileWindowMotion 1、CustomProviderForm 1、ProvidersPage.oauth 2），确认为既有问题；不为本功能改其阈值或无关界面。新增回归集中于 MobileFilesSurface.refresh 的 6 个测试，缺少 runtime-auth mock 导出，需修复后复核。

上述修复完成后必须记录新的结果；不能把“已交回修复”写成通过。

该轮收敛检查：网关定向测试 `bunx vitest run --project @yuriai/web packages/web/server/lib/remote-hosts` 达到 16/16 通过，含原失败的 Relay-only 场景。真正的 server 入口另由 `node scripts/remote-projects-smoke.mjs` 验证；当时发现有效桌面凭据创建项目被返回 401，后续已修复并复核通过（见下文）。隔离路由测试与真实启动入口测试不能互相替代。

Electron 首轮整包：48 文件通过、1 失败、8 跳过；492 测试通过、6 失败、14 跳过。失败集中在新增通知 helper 与既有 VM 测试的集成，已交回修复。Web 生产构建与 Electron main bundle 的在途版本均成功；源代码继续修改后仍须重新构建。

定向复核已修复的回归：MobileFilesSurface.refresh 6/6 通过；Electron notification-routing 8/8 通过（包含新增远端场景）。这两个结果关闭首轮对应测试失败，但仍不代表整个新功能通过。

Electron 后续整包复核：50 文件通过、8 跳过；504 测试通过、14 跳过（8.19 秒），日志 `.scratch/remote-projects/electron-regression-integrated.log`。

## 后端收口验证

- 真实 `startWebUiServer` smoke 已通过：设备列表脱敏与懒连接、未配对拒绝、远端优先幂等注册、HTTP 转发、删除引用保留远端。401 根因已由受保护 capabilities 统一完成准入而解决；没有放宽鉴权。
- 收口审查另外捕获并修复：WS 握手期间撤销仍可能开终端、普通 HTTP 无响应头超时、某 host 持续流阻塞其他 host 刷新。三个高层回归先失败后通过；该轮网关 23 项通过，连同 auth/event-stream 共 111 项通过。随后区分普通 JSON 与流式 body、短请求与五分钟 operation budget，新增两项回归后网关 25 项通过。
- 短 HTTP 请求只保留目标传输，不启动后台状态扫描；状态订阅跟随已授权的全局流。全局双槽刷新预算原断言保持不变。
- `bunx vitest run --project @yuriai/web` 完整通过：305 文件通过、6 跳过；4014 测试通过、20 跳过（354.32 秒）。原始结果 `.scratch/remote-projects/web-regression-final.log`。此前 SIGTERM 的整包尝试未计为通过。
- 后端新改动和两个主 runner 的 focused ESLint 通过。
- 后续发现并修复 worktree 的 root-only 边界：项目外 worktree 与嵌套目录现在可进入摘要、状态和内容订阅；归属来自远端 Git catalog，失败保留缓存并标 stale。嵌套 `/repo/src` 在checkout `/other` 中只映射 `/other/src`，不吞并整个仓库/兄弟目录；对应读取及订阅正反断言已过（`.scratch/remote-projects/nested-worktree-gateway.log`）。拓扑只在首次连接/重连及拓扑变更时刷新。重连仅打开状态流时，持久化 busy 仍为 unknown，直到当前连接完成权威刷新。原路径缓存重开、失败保留及成功移除回归记录在 `.scratch/remote-projects/worktree-gateway-tests.log`。客户端消费该新契约仍需端到端复核。

## 客户端接线收敛中

前一轮 UI 为 998 文件通过、13 失败、26 跳过；10203 测试通过、36 失败、111 跳过（`.scratch/remote-projects/ui-regression-final.log`）。最新整合轮次已收敛为 1022 文件通过、9 失败、26 跳过；10358 测试通过、24 失败、111 跳过（`.scratch/remote-projects/ui-regression-integrated.log`）。其中 8 项为已确认基线失败，其余集中于 inbox edit、远端聊天生产 pane 和 draft auto-accept 的契约/mock，已交 owner 继续修复。Web 生产构建该轮通过，不能代替未通过的测试。

## Electron 基线诊断（非正式预算验收）

独立 HEAD 的真实 Electron 全应用 probe 已完成 20 次启动和输入诊断，数据见 `.scratch/remote-projects/performance/ELECTRON-DIAGNOSTIC.md`。由于仍有并行实施/测试负载，需在统一空闲测量窗口串行重跑 baseline/candidate，以下数值不判定门槛通过。

- 侧边栏截图完成上界 P50/P95/max：7776/7933/8068ms；transcript 为 8063/10407/11097ms。截图完成不是精确首次 paint。
- typing、删除、撤销、粘贴各 50 次，逐次验证文本/选区/焦点；同步输入诊断 P95：1.6/2.2/2.7/2.0ms。
- 本次 trace renderer 主线程最大任务 9.701ms，没有 ≥50ms 任务；不扩展为 L＋5 路并发或远端场景结论。
- 中文 composition 为 CDP 模拟，系统中文 IME 未验证；本轮未测 iOS（后续 native 证据见下文）。该轮工具自测 9 项通过，不能代替产品门槛。

## 客户端真实 IndexedDB 证据

`node scripts/verify-remote-projects-indexeddb.mjs` 已实际启动隔离 Electron/Chromium 窗口并通过 5 项行为断言：

- 相同 session/message ID 在本机、不同 Host、不同 Hub 间重开隔离。
- 本地桌面 Hub 窗口查看远端时，不构造 Hub HTTP transcript cache 后端。
- LAN/Relay 路由切换后远端 durable transcript 分区稳定。
- 删除某个远端 transcript 不删除本机和另一 Host 的记录。
- 草稿附件的 owner/occurrence 跨 Host/Hub 隔离，重开与释放后保持正确。

fixture 是存储模块边界证据；不替代真实项目选择/聊天入口端到端验证，不证明 iOS 行为或 Hub 全部存储的零正文门槛。既有 Electron package evidence wrapper 中的 `test.skip` 没有计为通过。

## 生产网关资源实测

真实 `startWebUiServer`、独立 Node Hub 和 5 个 synthetic loopback direct Host，原始计数、样本、源码 hash 及限制见 `.scratch/remote-projects/gateway-evidence/RESULTS.md`；不是 SSH/WAN 或 UI 性能证据。

- 两个客户端全局流共享每 Host 一条状态订阅；最后客户端退出后状态及内容流全部释放。随后 601.17 秒每 Host 零新增请求/流。600 秒轮次中磁盘源码有变更，记录的是进程加载的版本。
- 300 秒在线空闲平均 CPU 0.110%，P95 0.229%，max 0.654%（单逻辑核 100% 口径）；RSS P50/P95/max 为 205.70/206.05/212.33 MiB。RSS 总值不能推导每订阅独立增量。
- 持久化保留 5 个独立摘要分区；数据库及整个隔离数据目录均未检出消息正文 canary。此次 HTTP transcript cache 未启用。
- 两轮 30 秒故障注入的健康请求 P95 回退分别 +2.38% 和 +33.27%，保留失败；不能用系统并行负载猜测消除超标。正式空闲条件下的配对比较仍需完成。

## iOS 真实基线环境

已用独立 native 副本完成构建、安装和启动；无签名 Simulator Keychain `-34018` 阻碍经 Xcode Simulator ad-hoc 签名流程解除。真实 App 已配对进入 Hub 项目和会话页，终止重启后仍保留配对；Home→前台恢复可见内容。没有使用发行证书或操作用户真实设备。

原生 composer 的输入 fixture 未被截图/AX 观察到保留，明确为非通过；没有把 `serve-sim type` 的退出码当成输入成功。正式输入/IME、presentation 时延、L 数据集、远端及 candidate 对照未完成。完整证据：`.scratch/remote-projects/performance/IOS-SIGNED-DIAGNOSTIC.md`。工具自测已达到 10 项通过。

## 修复前 candidate 真实平台诊断

`.scratch/remote-projects/performance/candidate/DIAGNOSTIC.md` 对应冻结源码 `b1975956169ce8f19abe328d28055f93be8864932828c2e6c9c7718af854cdcc`，不是最新源码。Electron/iOS 经真实机器选择、目录浏览完成远端项目关联并显示在线标签；Electron 本机与深链远端输入各场景50次断言通过（IME仅模拟）。完整侧栏→发送/SSE→返回本机草稿的闭环未通过；iOS输入首事件也未通过。

此轮发现 Hub summary 返回空而远端存在会话：Gateway 只读取远端 SQLite，未触发无UI实例的索引scheduler。已补首次连接/重连/拓扑变更时调用已有远端 `/api/yuri/session-index/sync`，后续通过revision事件刷新而非轮询；并补齐 `/api/form` 项目能力代理。新增回归后网关30项通过、focused ESLint通过，真实服务复核已通过（见下文）。UI模型选择/状态、发送操作定位及最终稳定candidate仍需验证。

## 无远端 UI 的真实服务复核

最新后端 `57e73a7ac11d073654bb2d4b46bc5c632aeaa039c0824bd28b68f4ef7c1986ce` 在两套隔离 Yuri + 真实 OpenCode 上完成 HTTP/SSE 复核，源码运行前后 hash 一致（`.scratch/remote-projects/performance/index-http-smoke/REPORT.md`）：

- 从空远端索引开始，未手工预热；Hub 注册项目后自动 sync 返回202，远端完成1/1目录、`failedDirectories: []`，Hub 摘要出现导入会话并发出带 hostId 的索引事件。
- scoped session、20条真实导入消息、`/api/session/active` 与 `/api/form` 均200；无Git目录的worktrees返回200空数组。没有调用模型。
- 旧 `/api/session/status` 确认返回400，已交客户端 owner 改用现有原生 active 读取/归一化；不能把此后端成功当作客户端状态已修复。
- Node ABI137 未重编，所有本轮进程与端点已清理。L fixture 单独补齐worktrees/sync协议，工具自测11项通过，未知mutation仍405。

此证据关闭后端冷索引初始化阻碍，不代表 UI 发送、真实网络画像或性能预算已通过。

## 逐订阅内存及生命周期

稳定后端版本上完成正反向44个窗口、2623个内存样本，包含RSS、heapUsed、external和自然GC；见 `.scratch/remote-projects/gateway-evidence/MEMORY-RESULTS.md`。逐步RSS观察差虽低于10MB/30MB预算，但零需求锚点漂移及12轮开关后约25–28MB RSS增长未归因，因此P4-18/19内存门槛仍未证明，也不宣称存在或不存在泄漏。

真实生产入口已验证跨客户端共享channel、删除单个lease不影响其他observer、第九路429且原八路不被淘汰，以及最后客户端离开后释放流。另复现在线删光引用后最后状态流未释放：DELETE期间临时HTTP需求保护了连接，但请求结束时未重新收口。主agent已在最后临时需求释放时关闭无引用Host，新增HTTP回归先失败后通过；网关31项测试通过。

修复后的原脚本无 `--reset-demand` 短测已通过（`.scratch/remote-projects/gateway-evidence/LIFECYCLE-FIX-RESULTS.md`）：两个独立生产Hub进程正反向保持global SSE在线并删除全部引用，5 Host状态/内容流均归零，未见关闭SQLite后的迟到回调错误；加载/结束源码hash一致。历史失败保留，长时内存门槛仍未证明。

后续确定性回归又发现独立的删后复活竞态：旧远端catalog返回时，刷新用INSERT/upsert把已删引用插回。现改为 `store.refreshProject(reference, remote)`，SQL只UPDATE同一仍存在的引用版本；metadata PATCH也使用该路径。catalog竞争及原最后引用释放回归连续5轮通过（`reference-release-final-*.log`），与资源持有者释放修复分别保留证据；未据此升级内存门槛。

## 文件预览鉴权接线

文件预览资源采用现有preview target下的严格pathname envelope，使相对CSS/模块/图片等保留目标路径。ui-auth已接入helper：仅GET/HEAD接受该路径短URL令牌，file WS及写操作拒绝；显式Bearer优先，client记录不可读/撤销/过期时拒绝，`-`占位符不授予权限。项目目录校验拒绝dot/父目录逃逸，并返回匹配的权威根供远端realpath containment使用。auth+gateway聚焦45项通过、focused ESLint通过（`.scratch/remote-projects/file-preview-auth-gateway.log`）。

该45项结果只验证鉴权边界，不能当作story44整体通过。后续核心生产gate已将file namespace排除在旧network-preview capability旁路之外，file runtime自身也检查普通auth；verbose与OPTIONS日志使用同一脱敏函数，不依赖合法envelope解析。最终fixture明确 `requireClientAuth:true`；早期public-auth配置下的200不单独作为越权证据。

preview worker最终冻结源SHA256为 `5db3fa74cbced0572e8e90b672df716238c1f9c365948ef86e786c59fd52b4dd`，17源文件复核无变化。真实Chromium＋生产auth gate＋Hub→A真实E2EE Relay-only/B direct加载CSS @import/url、静态/动态JS import、相对/根fetch、相对/根图片及嵌套iframe自身fetch；A/B输出各自Host内容，无串读。证据 `.scratch/remote-projects/file-preview/browser-final-evidence.json` 与原脱敏JSON一致，完整命令/边界在同目录 `handoff.md`。HTTP覆盖80MiB读取取消/撤销、过期、错Host/令牌及symlink拒绝；Web联合147/147、UI preview33/33通过。

FilesView/MobileFilesSurface已实际消费helper并通过UI整包；对应Electron/Capacitor实际文件预览入口尚待平台owner，不从Chromium资源图外推平台通过。

## 冷发现与 Hub 布局契约

`hasRemoteProjects` 由当前Hub SQLite只读投影进入既有settings/bootstrap，首末引用通过已有global tip更新，没有无条件新增hosts请求/轮询。`hubProjectLayout={hubId,order,collapsed}` 已接生产保存、读取与UI桌面/手机消费：仅引用ID，不将远端路径写入本机项目列表；保留遗漏项、串行合并、失败回滚、跨Hub隔离。

真实 `startWebUiServer` 的desktop-local与paired-mobile合成客户端覆盖冷bootstrap、首引用发现、末引用hint=false/tip、布局保存/重开与失败保留；最终本域133通过、1原跳过，19项源码hash见 `.scratch/remote-projects/bootstrap-layout-source.json`。它不是完整应用候选冻结或实体手机验收，详见 `bootstrap-layout-result.md`。
