# Bot 侧滑验收记录与合同（2026-11-08）

## 当前结论

生产源码未变的7f4fc51e完整`History Production QA`应用已在真实UIKit中显示普通Bot的「编辑／删除」rail。9b16cd9a固定Row、working Row及abe3d73a实际`AssistantHome → List → card → AssistantSwipeRow`的真实通路也已有通过证据。不能再将此前AX无子按钮或延迟截图无rail解释成“生产侧滑必坏”。

**完整Bots尚未签收**：主会话仍在验证完整应用的实际Edit点击、无Host写入、刷新关闭及公开AX custom actions。本记录只签收下表的具体范围，不把可见性、点击、业务写入和辅助功能合并成一个结论。

## 证据与范围

| 范围 | 当前结果 | 证据与边界 |
| --- | --- | --- |
| 9b16cd9a固定Row | 真实responder快拖到release/offset-open；截图可见Edit/Delete | `.scratch/nsh/pointer-9b16cd9a-fixed-swipe-a1/`。单Row，不等于完整页 |
| 9b16cd9a working Row | 真实快拖到release/offset-open；后续周期刷新retire-binding/offset-zero | `.scratch/nsh/pointer-9b16cd9a-working-swipe-a1/`及主会话下一读取。快拖成功与后续关闭分别记录 |
| abe3d73a实际AssistantHome/List | 真实trace到normal/release→normal/offset-open | `.scratch/nsh/list-pointer-abe3d73a-swipe-a1/after-early.json`含start→claim-yes→grant→page/page-reveal→block-yes→move/offset-partial/open→release。真实List通路已证；该trace不代替完整页点击 |
| 7f4fc51e完整应用普通Bot rail | **真实截图可见编辑／删除，通过可见性范围** | `.scratch/nsh/uikit-7f4fc51e-bot-swipe-immediate-a1/after-immediate.png`。同目录before/after-early AX根为History Production QA；gesture.json记录10帧单WS横拖，host发送跨度约146ms，无native receive ACK |
| 完整应用实际Edit点击、无Host写入 | 待主会话验证 | 必须确认进入预期编辑入口，记录相应Host审计，不能由rail截图或夹具纯回调代签 |
| 完整应用刷新后关闭 | 待主会话完成独立关闭验收 | working夹具已经观察到刷新退休并归零；旧完整页延迟截图与此解释一致，但不能冒充完整页的精确刷新/关闭时间线 |
| 完整应用公开AX activate/menu与接管行为 | 待主会话验证 | AX树缺少rail子按钮不等于custom actions已失败或已通过，须执行公开动作并确认结果 |

主会话报告即时截图是在同一手势脚本内、end后约120ms直接spawn `xcrun simctl io … screenshot`取得，避免跨tool call延迟。保存的host时间仅是发送时间，不能当作native接收或截图完成时间。

## 保留旧观察，修正推论

旧证据目录`.scratch/nsh/uikit-7f4fc51e-bot-swipe/`和`.scratch/nsh/uikit-7f4fc51e-bot-swipe-compact-a1/`完整保留。它们确实记录AX未见rail子按钮、后续截图没有rail；这两项观察不删除，也不改写为当时已经拍到rail。

新的即时截图表明：**同样AX仅有父row时，画面仍可显示rail**。此前多工具采样延迟可能跨过2.5秒目录刷新，观察窗口不足以判断rail是否曾出现。working夹具的retire-binding/offset-zero支持“刷新后关闭”的机制解释；不能反向断言每张旧截图都已精确证明某次刷新发生。

因此旧记录的分类为“采样窗口不足，未证明侧滑失败”，不是生产缺陷结论。不得据此修改grant返回值、删除snapshot/binding/generation fence或全停刷新。

## 后续验收合同

1. 以当前AX实际row frame注入手势，记录host发送时序并在同一脚本立即采图。即时rail可见性与后续关闭分别取证；AX按钮枚举不能单独作为rail可见性的判据。
2. 完整应用实际点击Edit，确认预期入口；Delete入口与确认/取消另记。通过Host审计验证无意外写入；只读夹具拒绝写入不证明完整应用没有请求过写入。
3. 单独验证刷新前rail与刷新后关闭，以及当前binding上的新动作、旧回调的拒绝。不能为延长观察窗口而改生产刷新或fence。
4. 单独执行公开AX activate/menu及接管后的迟到terminal行为。保留single-View长按、press token和旧binding/generation/Host fence。
5. 若需比较Web同语义snapshot刷新是否保rail，先核对双方数据reconcile owner与实际引用合同，再作为独立问题决定最窄修复；当前没有该差异的充分源码证据，不创建平行cache，也不改Native生产源码。

此次收敛仅更新文档，不新构建fixture、不访问设备/真实Host、不运行Git。历史冻结包及其source/manifest哈希保留为构建时快照，不以新结论重写旧证据。
