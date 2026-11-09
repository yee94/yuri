# Preferences 原生选择字段

`../settings-preferences-fields.tsx` 只拥有 `chatRenderMode`、
`messageStreamTransport`、`diffLayoutPreference`、`fileEditorKeymap` 的 section label 和控件 material。
字段 metadata、默认值、dirty、receipt、导航、Host/设备保存及恢复全部仍归原 owner。

Web 来源为 `packages/ui/src/components/sections/yuri/YuriVisualSettings.tsx`：
402pt 手机下渲染模式两张卡片纵排；协议为选项 chips 与当前协议说明；Diff 为三行单选。
fileEditorKeymap 复用既有十语 Default/Vim 标签，以两项 Radio 呈现；AX 名称由外层 `View accessible={false} role="radiogroup"` 提供，内部保留 RadioGroup 与各自可访问的 Radio。NSH RadioGroupProps 本身没有 accessible 字段，不能给它添加未声明的属性。unknown/非法值不选中任何项，禁用态拒绝旧回调，不生成预览或 timer。此字段仅保存本机偏好：实际 DedicatedMobile 的 MobileFilesSurface 为只读 preview，没有 CodeMirror/Vim 或写文件入口；不新增 Native Vim、编辑菜单或文件写入。
没有可直接导入且不携带 React 的共享预览 helper；原生直接按该源码的圆点/线条 primitive
绘制真实周期，不是空矩形或生成图片。字段内唯一 420ms clock 产生 `(tick + 1) % 24`，
两张卡共享 `tick % 12`。sorted 第 i 行自 phase >= (i+1)*3 显示，宽度恒为 92%；
live 第 i 行按 phase-i*3 的 <=0 / 1 / 2 / >=3 分别为 0/42/68/92%，宽度 >0 才显示。
六行始终占据 8pt 高度，隐藏只改 opacity 与 4pt translateY；宽度、透明度和位移由
NSH 原生 300ms style transition 插值。没有每行 timer，没有任何 transcript 订阅。

## 主会话最窄装配 seam

`settings-preferences.tsx` 已装配以下 import；receipt、保存和恢复仍归原 owner。
后续可见性修正仅修改该文件的 Scroll/layout 与 renderer prop 区域：

```tsx
import { hasPreferenceChoicePresentation, SettingsPreferenceChoiceField } from './settings-preferences-fields';
```

在既有 `fields.filter(field => field.id === id())` 的 `Each` 内分支。
目标三字段直接挂在 `SettingsTarget` 内，替换其整层 `SettingsGroup`/`SettingsChoice`，
不能把本组件塞回已有 Group，否则重复标题和 material。其它字段仍走旧分支：

```tsx
<If when={hasPreferenceChoicePresentation(field().key)}>
  <SettingsPreferenceChoiceField
    field={field()}
    value={value(field().key)}
    disabled={disabled() || props.active === false || !state.current()}
    active={props.active !== false && state.current()}
    previewVisible={previewVisible()}
    onChange={next => update(field().key, next)}
  />
</If>
<If when={!hasPreferenceChoicePresentation(field().key)}>
  {/* Existing SettingsGroup and all its existing field controls. */}
</If>
```

`field()` 结构可直接传入，不创建第二份 metadata。title/options.title 是既有 i18n key；
组件内部消费当前语言。value 必须原样传入，禁止在展示 seam 用 `text(...) || default`
补默认值；unknown/null/非法值保持无选中，不显示猜测的协议说明。
owner 对合法空配置的既有 initial 解析不在此模块变更。

保留 owner 已有 consumer/local/availability 说明与真正的准入限制，主会话可将其
提取为三字段分支前的共同说明，不能因换 presentation 声称 unconnected 能力已接通。
`disabled` 必须涵盖页面 inactive 与当前 operation 已退役；组件拒绝 disabled 时
保留的旧 callback，但不拥有 operation，也无法自行推断当前 Host。
`update` 仍须保留 owner 的 current/disabled 安全判断。onChange 只接收选项的原始 string，
不得改成直接保存、Host PUT 或 receipt 操作。

`active` 是新增的窄展示需求，必须显式 true 才启动周期；未传时不启动 timer。
它不等同于 `disabled`：保存忙碌不要求关闭仍然可见的演示。可选 `previewVisible`
默认为 true；生产调用方显式传入下述真实 viewport intersection，几何未知时为 false。
组件同时读取 NSH 0.4 官方响应式 `lifecycle()` 和 `reduceMotion()`（`.nsh/types/nsh/index.d.ts`），
不从 Host 设置猜测系统偏好。inactive/background、active false、previewVisible false、
reduceMotion true 均取消 timer 并 fence 已取消回调；effect cleanup 同时覆盖卸载。
恢复只从保留的 tick 在下一次 420ms 前进，不补跑后台累计 tick。
系统 reduceMotion true 时无 timer/transition，使用 phase 9 完整显示两卡内容；关闭后恢复原 tick。

## Scroll viewport 可见性

`settings-preferences-preview-visibility.ts` 仅持有一份字段范围、viewport 高度和 content offset；
每次 Scroll/layout 事件做 O(1) 交集判断，仅 boolean 改变时调用 changed，不逐行扫描或测量。
页面初始 signal=false。未知/非法/零高度范围不启动 timer。

本机 NSH 0.4 `.nsh/types/nsh/types.d.ts` 的 `Bounds` 使用 `origin`（不是 `position`），
`onLayout` 明确是父坐标。`SettingsTarget` 返回的唯一原生 View 是 Scroll content 直接子节点；
其外部只有不增加原生 View 的 If/Each，因此 `bounds.origin.y` 就是 content 坐标。
`SettingsTarget.onLayout` 只新增转发 port，原有 target/ref 判定和 onReveal 调用保留。
如果以后在 Scroll 与该 Target 中间增加原生容器，必须重新建立坐标合同，不能继续套用父坐标。

Scroll.onLayout 提供真实 viewport 高度，Scroll.onScroll 提供 `offset.y/size.height`，
chat.render-mode Target.onLayout 提供真实 top/height。初始新 Scroll offset 为 0，之后全部由
原生事件更新。正面积交集为 `field.top < offset+viewportHeight && field.bottom > offset`；
相切为不可见，部分露出为可见。resize/字段重排更新同一模型；没有估算行高或固定索引。
Scroll.onScroll 先原样交给 `navigation.onScroll(event)`，再更新可见性。搜索 reveal 的
唯一 scroll writer 与原有测量逻辑保持不变。此可见性模块没有 measure/scrollTo/异步任务。

离屏后 `previewVisible=false` 立即 gate timer 回调，随后 effect cleanup 取消唯一 timer；
再次进入视口只恢复一只 timer，不补跑离屏 tick。inactive/background/reduced motion 和
卸载继续由同一字段动画 owner 处理，不新增页面级轮询或第二个动画 owner。

生产 callback fixture 的 modules 表需要新增本模块映射；可 evaluate 真实模块并补
`View`、`Radio`、`RadioGroup` primitive，也可在只测 owner 的 fixture 内使用明确的展示 stub，
并由本模块 focused tests 独立负责真实控件回调。不能删除原 owner 的恢复测试来迁就装配。
动画 fixture 的 NSH mock 须提供真实形状 `signal/effect/lifecycle/reduceMotion`；
`reduceMotion` 为 accessor，不能给生产代码注入固定假值当系统支持证据。

## 带名称单选父容器的 AX 契约

Chat 渲染模式与消息流传输方式的两个 `View role="radiogroup"` 必须显式
`accessible={false}`，保留原 `accessibilityLabel` 与 role。子 Button 继续各自拥有
原 testID、option label、`role="radio"`、`selected`、`disabled` 及 onPress；Diff 的
RadioGroup/Radio 不变。这里只取消父级单元素合并，不隐藏父级子树，也不更改布局、
动画、previewVisible、dirty 或保存 owner。

本机 SDK `.nsh/types/nsh/types.d.ts:754–768` 的 HostProps 明确区分：
`accessible` 决定自身是否为一个 AX 元素（为 true 时子元素不独立暴露），
`accessibilityElementsHidden` 隐藏自身及整个子树，`importantForAccessibility`
支持 `auto/yes/no/no-hide-descendants`。本修正只用已声明的 accessible，不添加伪 prop、
类型断言、原生 setter 或 `no-hide-descendants`。

固定 NSH 0.4 源码依据为
[`native_view.rs` at e626a8d](https://github.com/longbridge/nsh/blob/e626a8d/crates/nsh-platform-ios/src/native_view.rs)：
`a11y_element()` 使用 `accessible.unwrap_or_else(...)`，未显式指定时带 label 且非
container 的 View 成为单元素；`is_container()` 仅列出 Group/Region/Navigation/Tree/Toolbar，
不含 RadioGroup。因此原 `radiogroup + label` 会命中默认合并；显式 false 优先于默认值。
同文件 `accessibilityElementsHidden` 直接返回 hidden，radio traits 映射 Button，selected
与 disabled 分别添加 Selected/NotEnabled。本修正保留 radiogroup 元数据；不声称它在该版本
自动获得 UIKit SemanticGroup container type。Context7 本次查询因额度限制未返回文档，
契约以本机声明与上述固定版本源码为证据。

主会话报告冻结产物 `43826d3f` 中两组只暴露带名称 GenericElement，而子按钮的独立
ID/label 不可达，Diff 三个 Radio 正常。本修正的重建验收 seam 仍是既有
`SettingsPreferenceChoiceField`，调用方无需变更：在新的 UIKit 产物中核验
`settings-preference-chatRenderMode-{sorted,live}` 与
`settings-preference-messageStreamTransport-{auto,ws,sse}` 五个按钮分别可达，保持 label、
选中/禁用状态及显式点击→原 owner dirty→原保存链路；同时复核 Diff 与预览可见性。
旧产物现象是主会话提供的基线，不是本 worker 新采集的 UIKit 证据。

## 验证与边界

- `settings-preferences-fields.test.ts`：真实 TSX callback/render tree，三字段准确选项、
  仅显式点击交付原值、disabled 后旧回调拒绝、非法类型无默认选中、协议说明匹配、
  真实缩略图线条、十语既有 key 完整性及只允许三项运行时依赖。
  新增红绿回归验证 24 tick 的精确发布值、每 phase 六行宽度/可见/固定几何、
  单一 420ms owner 不因 tick 重建、hidden/background/reduced motion/unmount 停止与旧回调 fence。
  非预览字段没有 timer；所有周期与生命周期变化均不调用 onChange。
- `bunx tsc --noEmit --project packages/nsh/tsconfig.json` 已通过；NSH 0.4 声明为准，
  Button 使用真实 selected/disabled/accessibilityLabel，RadioGroup 名称由外部唯一 Text 呈现。
- 三文件 pure tests 41/41：字段 16、可见性 helper 2、owner production 23。
  production 新测试挂载真实字段/Target 一次，直接触发真实 Scroll/layout callback，
  验证 geometry unknown/离屏 0 timer、回到视口 1 timer、resize/reflow/隐藏/卸载、
  保留 tick、迟到旧 callback 不前进、滚动不增加 GET/PUT，navigation 仍收到原事件。
- `bun run dead-code` 已执行；active 与 previewVisible 均已接到生产 consumer。
- 未运行 engine、UIKit、设备或真实 Host；未改截图基线；不声称 1:1 验收完成。
- 布局、长语言、主题选中色与实际触区、系统读屏/键盘、原生插值帧与真实系统 reduce motion
  切换、inactive owner 装配均待主会话独占 UIKit 验收。pure 测试证明生命周期与输入规则，
  不证明真实设备的帧率、调度精度或逐像素一致。
- Boolean 的 Web Off/On 双按钮可作为后续独立范围；本次未改动任何 Boolean。
- 本次 AX 回归在修改生产 TSX 前得到 16 passed / 2 failed，失败点均为父容器
  accessible 未显式 false。新增两例遍历每个合法选中值，验证父级不合并/不隐藏子树，
  子按钮数量、独立 ID、radio role、label 和 selected 保留。它检查真实生产 TSX props，
  没有模拟 UIKit AX 树，不将 pure render tree 或类型检查当作真实平台通过。
- 本 worker 未运行任何 engine/headless、构建、设备或真实 Host；新的 UIKit 重建与
  AX/交互验收由主会话独占，冻结后交独立 oracle 复核。
- 本次修正后执行 `bunx --no-install vitest run --config packages/nsh/vitest.config.ts
  packages/nsh/settings-preferences-fields.test.ts packages/nsh/settings-preferences-preview-visibility.test.ts
  packages/nsh/settings-preferences-production.test.ts`：3 files / 58 tests passed；
  `bunx --no-install tsc --noEmit --project packages/nsh/tsconfig.json` 通过。
  无新增/删除源文件、export 或 import shape 变化，本次未重复 dead-code。
