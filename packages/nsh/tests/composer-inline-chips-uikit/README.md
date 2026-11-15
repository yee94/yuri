# Composer inline chips UIKit carrier

此载体挂载生产 `NativeComposerInlineChips`、真实 NSH multiline Input 和消息 `NativeMessageText`，使用独立 QA bundle；数据均为本地合成引用，不读取真实 Host 或凭据。

## 渲染合同

- NSH Input 保留逻辑文本和 UTF-16 选区；引用范围来自既有 composer document，不把字符替换成 `U+FFFC`，也不重新实现编辑器。
- iOS 在真实 `UITextView` 的触发字符上加透明前景和 `.kern` 预留图标宽度，用 TextKit glyph bounds 定位非交互 `UIImageView`。普通 `@` 字符上的 `.attachment` 经 UIKit 实测不会画图，因此不使用该实现。标签颜色仍通过 text storage 应用。
- 文字处理和编辑器宽度变化重新定位图标；marked text 期间不改写装饰，IME 仍归原 Input。主题、引用和 active 通过 lazy JSX 配置更新；inactive 只清 chips，保留真实 `textLength` 以通过原生长度核验。
- 着色图标缓存上限为128项/4 MiB；原始图标仅固定五种。消息 chip 由 Markdown custom inline view 渲染，整块采用 `verticalAlign: middle`，内部图标与标签居中；`text-bottom` 会把带行高的整块 chip 抬高，不能用于这个容器。
- 输入框和消息共用 `referenceChipColors`：普通引用取 canonical Web `primary.base`，Skill 取 `chat.composerSkill`（缺省按 Web warning 规则派生）。Host 外观尚未到达时取共享默认主题，不能回退到 NSH 中性按钮 `primary` 或普通 `foreground`。

## 运行与证据

先启动 iOS 模拟器，再运行：

```sh
NSH_DIST=/path/to/nsh node packages/nsh/tests/composer-inline-chips-uikit/run.mjs
# 独立复验深色模式
NSH_DIST=/path/to/nsh NSH_CHIP_SCHEME=dark node packages/nsh/tests/composer-inline-chips-uikit/run.mjs
```

结果在 `.nsh/composer-inline-chips-uikit/<run>/`。`chip-audit.json` 的 `attachments` 字段为历史字段名，实际统计可见 overlay 图标数量；七阶段预期为 `[0,1,2,1,0,1,0]`：空引用、插入 skill、加入 file、编辑移除 skill、停用、恢复、清空。检查逻辑文字不出现 `U+FFFC`，并输出第二/第五阶段截图供人工看图。

`chip-geometry.json` 记录实际 UIKit view frame；`VisualChecks.swift` 解码真实截图，在正文和两个 chip 的实际区域量测字形中心（误差须≤2pt）及高亮彩色像素，并检查输入框仍有引用高亮。脚本会失败退出，另输出 `chip-detail.png` 供并排检查。只统计图标数量不能证明对齐和颜色正确。

已执行 UIKit 七阶段检查并人工检查截图：输入图标与消息图标均可见，原始 `@review`/`@notes.txt` 文字及选区索引保留。Swift/Java plan 与同一 mounted wrapper 配置更新另由 `composer-inline-chips.test.ts` 覆盖。

视觉回归先在原实现复现：消息 Skill 字形中心上偏4.33pt、彩色像素为0。只修配色后仍上偏4.33pt；再将整块 chip 改为 middle 后，浅/深色截图中的 Skill 与正文中心差0.67pt，图片引用中心差1.5pt，两个引用及输入框均有高亮像素。对应聚焦 Vitest 五文件22项通过，包含共享默认/自定义主题配色、输入装饰更新、消息引用点击/替换和实际附件预览。

未验：中文 IME 的完整候选/提交过程、复杂换行/光标/删除与物理键盘组合、VoiceOver，以及 Android 设备视觉和 IME。此载体不证明这些交互已验收。
