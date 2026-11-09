# 真实 AssistantHome / List pointer 诊断夹具

仅用独立UIKit app收集实际List中的responder证据。真实生产模块为`AssistantHome`（实际联系人页名称）、原`List.children → card(entry) → AssistantSwipeRow`、`AssistantAvatar`、`createPageOperations`、`state.loadConnections`及原2500ms working轮询。没有另写列表或可滑替代。Swift内存Host仅提供connection.list和两个GET：capability/snapshot；严格拒绝非GET、body、错误scope和其它路径，绝不接真实Host或写业务数据。

```sh
NSH_BIN=/path/to/nsh/bin/nsh node packages/nsh/tests/assistants-pointer/build.mjs --production-list
```

此模式**只构建，不运行engine/设备**。采用已修复的`nsh/bundle.nshc`加载路径及有界phase/error记录。唯一输出目录与bundleID见fixture-build.json。只在stage副本对生产page和row插桩，manifest分别保存原/插桩哈希。List、头像、数据wrapper创建、snapshot应用与刷新周期完全保留；没有canonical reference缓存，也没有关闭生产刷新。

默认production-list。两个synthetic Bot与完整包所用的seed/id相同：pinned outer-bot-1为working，normal outer-bot-2为非working；整个目录仍按原逻辑2500ms刷新。卡片内容、头像与可见性回调来自生产组件。连接通过真实loadConnections接纳，Host scope由synthetic Swift签发，无JS手设runtimeReady。顶层控制条和底部200pt固定trace区是测试UI，未复制完整应用NavStack/TabBar；这项区别须保留在验收解释中。

## 主会话复验

1. 安装本次app，确认根AX为`Assistant List Pointer UIKit QA`，模式production-list，无pointer-native-error/list-pointer-boot错误。normal目标`assistant-row-outer-bot-2`，主体`assistant-open-outer-bot-2`。总是读取当前AX frame，不能沿用完整包或旧fixture坐标。
2. 点击Reset后尽快用单WS的约144ms横拖80%→25%，采before、实际host发送时序、early AX及截图。`list-pointer-trace` AXLabel含最多64条固定枚举，按**实际同步回调/写入执行顺序**追加；normal/、pinned/、page/都是固定角色前缀，无身份/坐标/正文。没有时间戳或native receive ACK；序列不代表HID接收时刻，也不保证每个物理move都独立分发。
3. 关注normal/start→claim-yes→grant→page/page-reveal→block-yes→move→offset-*→release。page/snapshot-read、snapshot-apply、load-end标明真实读取/接纳，retire-binding记录对应wrapper变化；page/viewability标明List可见性回调。无normal/start时不能用纯row通过推断List通路通过。Reset前的初始close-unrevealed/offset-zero正常。
4. 在下次snapshot应用前立即确认rail截图，并点击Edit验证回调可达（normal/edit）；Delete仍走生产确认弹窗，**只Cancel**。若确认Delete/Pin，Host必须拒绝写入并显示失败，不能把拒绝视作支持业务变更。读取trace以区分rail自动关闭与根本未出现。
5. Fixed row按钮卸载List页及其轮询，挂载与之前同一生产row的固定binding对照，目标`assistant-row-list-control`。这只是测试场景切换，不修改生产刷新代码。重回Production List会新建页面并重新读取。固定row菜单只记menu，无业务弹窗；真实page保留生产ActionSheet及公开AX activate/menu。
6. 补验证纵向List滚动、长按不进Chat、AX menu/activate、打开另一row关闭旧rail；pinned不支持侧滑。64条可能被下一次refresh挤掉，所以及时保存完整AXLabel。底部trace固定高度，追加不会移动row。

## 结论边界

9b16cd9a单row fixed/working快拖由主会话真实验证，working下一次refresh确会retire-binding/offset-zero。abe3d73a实际List的真实trace也已到normal/release→normal/offset-open。生产7f4fc51e完整应用在同脚本即时截图中明确露出编辑／删除；此前AX无子按钮、延迟截图无rail保留为观察窗口不足，不能再作为生产侧滑失败结论。证据路径与逐项状态见[侧滑验收记录](../assistants-pointer/ACCEPTANCE.md)。

本fixture用于缩小List载体差异，**不签收完整Bots页**。完整应用rail可见性已实证通过；实际Edit点击、无Host写入、refresh close与AX custom actions仍待主会话验证。无生产改动，所有fence、single-View长按和AX token保留；不再为已确认的可见性新增构建。
