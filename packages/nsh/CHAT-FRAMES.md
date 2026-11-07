# Chat 逐帧对照清单

本清单的每一行都要保留 Web 基准、Native 修复前/后及交互结果。截图相似、接口成功、fixture 通过分别记录，不互相替代；未取证即未验收。

## 采集约束

- 同一个 Host、同一个会话、同一条消息、同一滚动位置与同一展开状态；不重新调用付费模型制造重复验收流量。
- Web 必须确认 `device-mobile mobile-pointer`，不只是缩窄窗口。采集时记录 viewport、DPR、touch points、主题、字体、字号与 `--dpt`。
- 当前设备为 402×874 pt。用于 app 区域比对的 Web viewport 是 402×778；Native 原图完整保留，比对副本等比归一到 402×874 后，仅排除系统状态区 62pt 与底部 home safe area 34pt。不是裁掉应用差异。
- 主题、字体或状态不一致时不做像素一致性结论，先修环境/接线。系统 Liquid Glass 的动态材质单独标注，不用整体差值掩盖布局错误。
- 账号、凭据、私人金额等在截图后脱敏；不改 DOM 伪造界面。脱敏矩形和不可比较区域须明确记录。
- 关键动画录制连续帧：打开/关闭、键盘升降、流式增长、滚动与回退；静止截图不能证明动画或中间状态正确。

## 帧与功能矩阵

| ID | 同状态画面与触发 | 功能核对 | 当前证据/差异 |
| --- | --- | --- | --- |
| F01 | 短会话静止、一问一答 | 角色、顺序、模型身份、无额外 Yuri 头像、时间/TPS/耗时、按钮归属 | `F01-native-inverted-full.png` 确认用户要求的倒序模式已贴底且旧上新下；`F01-native-speech-clock-content.png` 是此前顶部布局参考，时间/朗读仍有效。未调用付费合成；非像素一致性结论 |
| F02 | 上下文圆环→metadata | 真实 tokens/limit、branch、配额、失败/刷新 | `F02-web-metadata-stable-dark.png` / `F02-native-final-content.png` 均脱敏；真实28.9K/400K7.2%，区分部分加载与稳定帧，不隐藏真实 provider |
| F03 | workspace 菜单打开/关闭 | 新聊天、文件、更改、MCP、同步、远程桌面、自动朗读，逐项返回 | 原 Web 菜单有参考；Native 入口集合未完全一致 |
| F04 | 输入空白→焦点→软键盘 | placeholder、caret、按钮位置、安全区、返回键不重复 | 有 UIKit 英文键盘截图；新 padding/返回修复待重装 |
| F05 | 连续输入、删除、多行增长 | 中文 IME、候选确认、粘贴、撤销/重做、selection、最大高度 | 仅生产输入计数回归；设备逐项未完成 |
| F06 | 模型 Sheet 打开/搜索/清除 | Provider 分组、最近/收藏、当前标记、ctx/能力、空/失败重试 | `F06-web-final-dark.png` / `F06-native-final-content.png`；修安全区后搜索框y252，目录/排序及全部mutation仍未验收；旧高度录像不作最终动画证明 |
| F07 | variant 展开→选择→关闭→重开 | 权威选择、默认/High 等标签、不重复写模型 | F 回归已有；真实配置 mutation 未做 |
| F08 | Agent Sheet 打开/选择 | 原图、主 Agent/hidden 过滤、名称、切换/恢复 | UIKit 长按打开/取消已采 `F08-native-agents-after-content.png`；后续 palette/高度修正未重采。短按/长按唯一触发有生产回归 |
| F09 | `@query` 混合建议展开 | 五域排序、小图标/描述、当前会话排除、防抖、陈旧响应 | `F09-native-references-after-content.png` 已实测混合 Overlay；生产键盘已接上下循环/Enter/Tab/Escape及scope校验。最后高亮/密度、原生软键盘保持与物理 IME 仍待 UIKit 专项 |
| F10 | 选择/删除/编辑引用、光标置中 | 精确替换、尾文保留、scope、引用 sidecar、重开/重试 | 生产状态回归已有；五域 UIKit 待逐项 |
| F11 | `/` 菜单与参数、magic 命令 | 注册命令与 prompt 区分、模板、错误保稿 | F 接线；需 Web/Native 菜单帧与设备交互 |
| F12 | `!` Shell、退出、历史结果 | 独立 shell 路由、输出/退出码、不吞附件/引用 | F 已有；真实无副作用 shell 先前有证据，当前帧待补 |
| F13 | 附件菜单、照片/文件选择、chip | 取消/删除、仅附件、上传进度/失败/重试、切 Host fencing | 原生桥已有测试；完整 UIKit 帧待补 |
| F14 | 流式文字/reasoning 中间帧 | 首字、多次增长、折叠/展开、终态收敛 | 先前真实流式有 52 SSE/6次增长；本轮外观帧待补 |
| F15 | 工具 pending/running/completed/error | 行摘要、图标、状态、展开输入/输出/错误 | H/S 已读真实 shell 完成记录；长用户10行裁剪、9–16编号见 `F15-native-list-gutter-full.png`。正序中间版空闲锚点3轮通过，最终已按要求切倒序、该顶部锚点合同不再沿用；pending/error设备帧待补 |
| F16 | Read/patch/diff/子 Agent 工具 | 精确文件快照、diff、权威子会话、多级返回 | 真实 shell 详情见 `F16-web-current-output.png` / `F16-native-verified-output-content.png`，输出及11.4s已实测；12s/721帧录像记录6次开关，非像素/动画一致性结论。Read/patch/diff/子Agent真实路径仍待逐项 |
| F17 | user/assistant 消息操作 | copy、edit、revert确认/取消、redo、fork、朗读 | role操作条已实测；生产Chat单一朗读owner/听写互斥已接，UIKit显示入口。真实豆包听音、有损历史操作未验收 |
| F18 | 回退后 dock/发送/失败/恢复 | 隐藏回退尾部、commit→prompt互斥、保留原草稿/附件/引用 | C/F；生产 visibleMessages 已接；真实有损历史未操作 |
| F19 | busy→排队多条→编辑/移除/steer | 精确 ID、只消费一次、取消未确认不重投、失败恢复 | C/F；真实 Host/UIKit 各状态待补 |
| F20 | permission once/always/reject | 条件入口、说明、防双击、他端已处理/失败 | C/F；UIKit 逐帧与真实 Agent 恢复待补 |
| F21 | question/form 条件字段与弹层 | 必填/类型、选择/自由输入、取消、失败重试 | C/F；长表/键盘逐帧待补 |
| F22 | 100+历史、前插、晚到图片、跳最新 | 锚点、读中间不抢滚动、恢复跟随、返回原页 | 已开启原生inverted、新→旧展示副本与最新端刷新；旧历史cursor和手动入口不变。100+历史/前插/晚到内容的设备行为尚未验收 |
| F23 | 图片/视频/PDF/Markdown/链接预览 | 授权读取、缩放/保存/分享、Host localhost、Relay、失败返回 | 桥部分完成；HTML/Eficy/插件原生执行等仍有缺口 |
| F24 | 听写开始/初始化/结果/结束 | 内联转写、校正/取消、权限/后台/切页、hold-to-talk | 当前系统 Speech 不等同 Web 全部能力；未验收 |
| F25 | 断网/后台/重连/Host 切换 | 不假空闲、不丢草稿、陈旧响应隔离、缺页提示/重试 | C/F 与先前桥证据；真实场景逐帧待补 |
| F26 | 空会话/新聊天/欢迎建议 | 延迟实体化、项目默认配置、取消不留多余会话 | 当前有行为差异，仍在完整 scope |
| F27 | Goal/Tasks/工作进度相关入口 | Web 实际可达入口、运行/暂停/继续、状态恢复 | 尚未完整对齐，不能省略 |

路径前缀：截图/几何文件位于仓库 `.scratch/nsh/`。旧 `web-chat-reference-dark.png` 等在触摸模式校正之前采集，只作历史参考，不能继续作为精确字号/间距基准。每项最终判定须在 `CHAT-VALIDATION.md` 记录具体帧、测试、实际交互和未测平台。
