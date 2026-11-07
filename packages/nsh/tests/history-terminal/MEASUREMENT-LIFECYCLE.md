# 测量生命周期修正与真实失败保留

## 已失败的候选

main 在独占 Simulator 实际运行 `build-wtJRBv`：

- 默认 OFF：`.scratch/nsh/chat-frames/terminal-footer-1794044345279/captures.json` 仍为约36pt红。
- 显式 ON：`.scratch/nsh/chat-frames/terminal-hold-1794044412170/captures.json` 和同目录 `ax-events.json`；本 agent 离线 checker 再次得到 **red / 35.999755859375pt / 239 samples**。measuredHeight始终0、minHeight0，候选没有生效，不能登记为“暂留/释放通过”。

旧 capture 的 JS 单调时钟顺序：

| phase | JS ms | helper active/enabled | measured | 说明 |
| --- | ---: | --- | ---: | --- |
| 唯一 visible `footer-layout` | 28.786 | false/false | 0 | 旧 onLayout active guard 拒绝；main 补充当时实际自然高36。旧事件自身未保存 raw layout height，不能从0补造回调数值 |
| Hold ON | 2641.204 | true/true | 0 | 仍是同一个已布局 footer，不会因切开关自动再触发 layout |
| before-js-commit | 40860.718 | true/true | 0 | native/footer实际36；helper当前offset0、native offset0 |
| 下一次 `footer-layout` | 40861.282 | true/true | 0 | 已隐藏，实际高0；不能拿该事件恢复丢失的自然高 |

## 修正合同

1. **同 scope 的首次 mounted-layout admission** 不要求 lifecycle 已发出 active；自然 footer 的 layout 可以比首次 active 通知更早。即使实验 disabled 也记录实际高度，但 inactive/disabled 永远不建立 hold。
2. 仅初次 mounted、尚未真实 active→inactive 的同 generation 可暂存该测量；重复初始 inactive 通知不清除它。同 scope 后续 enable 保留确认的测量，不等待不存在的新 layout。
3. 真正 active→inactive、scope改变、reset 清除旧高度。真实 deactivation 关闭旧 layout admission；旧 scope 回调拒绝。恢复时没有新的测量就没有保护，不能复用前一可见代际的高度。
4. fixture 在 enable 边界缺测量时，窄读当前 footer `ref.measure().bounds.size.height`。首次 inactive-layout 的同 generation 确认值可直接沿用，不为了开关强制重排；真正隐藏回来则设置 `footerNeedsActiveRead`，即使有迟到同 scope 回调，也在启用/下一次实验 commit 前强制新 ref 读取。
5. 每个异步 ref 读取验证当前 active、scope、同一个 footer ref、仍有实际 footer 内容、measurement generation；隐藏/销毁使旧读取作废。读不到正有限自然高会显式报错，保持 OFF 或保留未提交 flight，不塞固定36，也不假装提交成功。若 footer 尚未进入可测树，不能把测量失败作为通过；在真实可测位置显式重试。
6. `ref.measure` 只提供**该节点的自然 height**。它是 NSH core measurement，不是 UIKit offset。读取 offset/旧端 admission 仍只来自真实 List 的 onScroll/drag/rest 事件；不得用 pagePosition、core contentSize 或文本长度推测 native offset。
7. 新 `footer-layout` 和 ref 确认事件记录 `measurement.source / scope / height / admitted`；不再只记录处理之后的0，便于 main 检查原回调是否到达和为何未采用。原生 frame 仍由 Swift 独立读取。

## 2579 与 0 的调查结果

旧 UI `footerHold.offsetY=2579` 是最后一次**发布快照**（开关/上下文变化时发布），不是 owner 后续缓存一直停在2579。`onScroll` 特意只更新 owner 私有事件缓存，避免每帧 signal 触发重排。

旧材料里的 `manual`、`before-js-commit` 的 **JS payload `footerHold.offsetY=0`**，同时 native scrollViews offset0；但当时原生观察到的 UI label 仍是旧发布快照2579。也就是说，旧候选失败是缺高度，不是 commit 使用了2579。

新 counters 区分：

- `footerHold`：每次正常 UI/capture commit 重新读取 helper当前事件缓存；不增加逐滚动发布。
- `footerPublishedOffsetY`：最后一次显式 layout/context/hold变化的已发布快照，允许滞后。
- `footerOffsetPolicy`：明确“last-List-event cache，只在其它UI commit时刷新”。
- Swift `scrollViews.offsetY`：该次实际原生采样，始终是 native offset authority。上述 JS 数据不冒充原生采样。

## main 复验前置条件

新 App config build=4，仍默认 Hold OFF。显式 ON 后先确认：`footerExperiment=true`、`footerMeasuring=false`、`footerHold.measuredHeight>0`；有相应 `onLayout` 或 `ref.measure.bounds.size.height` 来源记录。再进行原有三轮 OFF 红 / ON 暂留 / ON 释放；不能只看到 ON 文案就把“测量成功”视为成立。

范围与释放条件没有改：仍不能把合成36pt当真实Host53pt，ON 暂留和释放都需 main 的真实 UIKit 录像。没有新增 offset/inset 写入、定时器或第二 scroll owner。

## 红绿与未执行

按真实启动顺序新增纯测试后，旧实现 **15 tests / 2 failed**：首次 inactive layout 丢失，以及新scope首次layout无法接纳。修正后全目录 **4 files / 26 tests passed**，包括 disabled→layout→active→enable（无新layout）→cache offset0→hide，以及真正hidden返回不得复用旧高度、旧scope拒绝、1000次scroll不发布UI。

focused tsc、独立 NSH/Swift 构建通过。未安装、launch、运行 engine、操作设备或真Host；新 App 的 UIKit 结果仍待 main。
