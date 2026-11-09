# 项目首页 Sheet 与卡片对齐

## 本次范围

用户确认只处理**项目首页操作项**，不将设置 Tab 的二级页改成 Sheet。

参照当前 Web 的 `mobile/projects/MobileProjectsHome.tsx`、`MobileProjectCard.tsx`、`MobileSessionRow.tsx`、`apps/MobileProjectEditSurface.tsx` 和 `styles/mobile.css`，不另行设计一套首页。

## 生产接线

- 加号、项目操作及实例选项由系统 `NativeSheet` 承载；实例保留当前项和禁用/选中状态。
- 首页编辑项目、注册/克隆目录、工作树管理、新工作树不推进应用主 NavStack。目录/工作树的现有 NavPage 仅在 Sheet 内的独立导航容器装配，隐藏重复标题。
- 项目编辑直接复用 `SettingsProjects`，没有另写保存逻辑；dirty/busy 关闭保护仍由原编辑器提供。目录/工作树提交期阻止系统拖关。
- 新工作树使用同一表单；首页 Sheet 内是内联内容，普通项目详情入口仍使用已有的独立创建 Sheet，不同时初始化两个呈现。
- 菜单选择、添加目录和创建工作树的后续导航均等待真实 UIKit dismiss completion。代际或前台页面失效时不执行旧 continuation。
- 首页卡片移除外边框和整块内 padding，按 Web 的标题/内嵌分组/紧凑会话层级排列。分组描边、间距和字号有源码对照回归；保留原拖排与横滑 owner。

## 验证

- `nsh:check`：通过。
- 当前生产 `App.tsx` 的 NSH release bundle：通过。
- 定向九文件：176 passed、4 个原有 skipped。包含 controller、目录重试与 Host fencing、Sheet 生产回调边界、Web 几何、现有正文拖排、项目编辑及导航恢复。未增加或跳过测试来掩盖失败；目录 controller 测试的旧 presentation/request ports 已对齐当前模块边界，跨 Host 用新页面 owner，不再要求旧 owner 重新绑定。
- `dead-code`：已运行并检查；新 Sheet/几何模块未列为 unused，报告仍含仓库原有广泛条目。
- 专用模拟器用**已有原生 simulator host + 当前完整 App.tsx 字节码**运行，不是隔离 QA 页面；本轮没有改 Swift，也没有重编该 simulator host。
- 真实 UIKit 操作已验证：加号→目录 Sheet→关闭；实例选项；项目→编辑 Sheet；修改本地 icon 草稿→关闭→原生丢弃确认→丢弃；工作树列表；新工作树→取消返回首页；编辑关闭后再次打开。呈现时背景首页不暴露在 AX 中。截图位于 `.scratch/nsh/projects-home-*.png`。
- 没有提交项目配置、创建目录/工作树、切换真实实例、发送模型请求或语音请求。

## 不作为已验收的内容

未做全主题/字号的像素级对帧、真实手机触摸/键盘或拖排性能验收；模拟器操作不能替代这些证据。此补丁尚未重新安装到用户手机。
