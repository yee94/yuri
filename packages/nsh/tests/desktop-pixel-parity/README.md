# 桌面像素对齐：未签收

用户纠正原文：

> 你必须要跟我的 PC 去做 1:1 的像素对比啊，你现在的设计根本就不是我原来那个样子

功能实现、headless、类型检查和构建不替代这一验收。先比较真实 Web 和真实 AppKit/Win32 窗口，再修正差异；不以自拟界面替换原版。GUI 插件暂不在功能范围内，但对照图上的插件品牌和入口差异必须单独标明，不能混入内置布局的通过结论。

## 当前已取得的证据

- 真实 Web 新会话页：client viewport `1068×832`、DPR `1`、中文、Cursor Dark。
- 页面实测：侧栏宽 `260px`、主标题栏高 `48px`；欢迎标题框 `x=288, y=291.046875, w=752, h=36`，字体 `30px/36px`、letter-spacing `-0.75px`；输入外框 `x=288, y=385.046875, w=752, h=99`、圆角 `24px`，文字 `14px/21px`；快捷项行 `y=500.046875, h=24`。这是该固定状态的实测，不是所有窗口大小的固定坐标规范。
- 本地 capture harness 挂载真实 `YuriNativeApp`，只替换 Host 边界为合成只读数据并预置隔离 UI Storage；选择 `yuri/main`、同模型/variant 和同快捷项。会话 ID、路径仍为合成值，不能冒充真实 Host 联调。fixture 的目录与标题尽量匹配参考页，但尚未形成同状态原生对帧。
- 最小 AppKit 页面能通过 `app.screenshot()` 输出真实 PNG；整个 App 的首次失败是开发 bytecode `21,340,732 bytes` 超过 WS 默认单帧 `16MiB`，不是截图权限证明。修复边界见 [DevBundleFrameLimit.md](./DevBundleFrameLimit.md)。
- 诊断 digest `8a261f52b450ac75cc77225f2751bda1dc59097dd1e48ac5677f67d3ad77ff25` 的真实 AppKit 运行已经输出 `loading build 1`，不再因大包退出；它仍是带已知 List core 契约阻塞的诊断产物，不可发布。

## 真实窗口阻塞

默认显示器和显式主显示器均未进入新会话页。直接原生诊断报告 `active=false, running=true, visible=false`，页面停在连接入口；系统只读检查确认 `CGSSessionScreenIsLocked=1`。

没有把 lifecycle 改成 active，没有关闭业务前后台门禁，没有用 headless 图片或不同页面状态替代目标截图。连接页 timeout 图只证明该错误状态可被绘制，不计为像素对齐证据。开发测试宿主还报告了 fixture 范围外品牌 SVG 的 asset 404；解锁后须解决或明确区分这一 fixture 资源限制，不能将缺图画面判为还原完成。

**当前没有成功的新会话原生对照图，没有有效并排/叠图结论，没有像素相似度通过声明。Windows 实机像素尚未验证。**

## 继续验收的门槛

1. 桌面解锁、真实原生窗口可见且进入前台；重跑原流程，不伪造生命周期。
2. 同一 client viewport、DPR、主题、语言、页面、展开状态、稿件和选择；确认 assets 与字体实际加载，分别记录合成数据和插件差异。
3. 输出未拉伸的并排、50% 叠图和差分图。窗口内容尺寸不一致时重新采集，不用缩放掩盖几何误差。
4. 分别测量 chrome、侧栏、欢迎区、composer、工具栏和快捷项的边界、字号/行高、间距、颜色与形状。先记录偏差，再改 owning 模块，重拍同状态验证。
5. 新会话页通过也不代表 Chat、助理、计划、设置、文件、Diff、终端、浏览器、模态和异常/恢复组合通过；Mac 与 Windows 分别记账，原始范围不裁剪。

截图、DOM 几何 JSON、fixture 和比较脚本目前仅保存在 ignored 本地工作目录；它们不是已随仓库交付的跨机器运行证据。
