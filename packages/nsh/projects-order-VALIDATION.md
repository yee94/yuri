# Projects 拖拽专项

## 已实现的生产合同

- 首页目录和置顶正文采用 Web 的 **350ms hold / 6pt tolerance**。候选阶段保留原生滚动和横滑，激活后才接管 responder/root Scroll；正文不再长按开菜单，菜单保留显式 more，项目/工作树头仍长按开菜单。
- 每个可见 SessionList 有独立 geometry、scope、序列令牌和 epoch。进行中列表不排序；置顶与所属目录互不转移。原额外 SessionOrderControl/Sheet、首页工作树 drag handle、项目与工作树 up/down 菜单已移除；ProjectDetail 保留真实工作树 handle，其 distance 8 与 Web 编辑入口一致。
- grant 一次测量真实变高行与根 Scroll viewport/content，不使用 `dy / 56`。正文仅纵轴移动；原行 30% opacity、实测尺寸的 root Overlay、邻行位移。工作树 handle 保留自由平移，按真实 header 中心落点。
- 边界自动滚动采用已安装 dnd-kit 6.3.1 的 pointer / 20% threshold / 移动方向意图，按 16ms 原生命令预算缩放其 10pt/5ms 速度；只有采用实际 native offset 后才继续发下一条。指针帧不读布局、不发网络、不遍历 session catalog；停在普通区域无持续 timer。
- release 采用最新松手坐标及已确认 scroll offset 重算落点，再至多提交一次。提交携带手势可见 IDs，controller 重新读 Host order 后仅重排该子集，并保留隐藏 ranks、完整 activity 和其它 scope。drop 的身份/隐藏 rank 验证使用 Set，避免 500 行子集二次方扫描。
- 多指（包括第二指落在别行）、原生 scrollstart、内容尺寸变化、成员/顺序变化、epoch/current 失效、terminate、卸载、测量缺失/失败均取消，不猜几何、不遗留滚动锁。拖排激活清掉旧横滑偏移；拖后只吞一次点击。
- controller.scope 同时检查 alive，dispose 后晚到目录读取不落地。ACK 后读取失败只允许读取恢复；旧 Host 排队事件不访问新 Host。未修改这些协议的 metadata 或未知结果语义。

## 红绿与独立 review 证据

- 首轮真实工作树闭包：header 中心 28/328/388，拖 300pt 原来错误写向第三棵，修复后第二棵；150pt 不再跳第三棵。原 Sheet 的固定步长同样错误，现该 UI 依用户要求删除，覆盖已转到正文手势。
- 首页正文接线回归修前报 `expected undefined to be type of function`；另有额外首页 Sheet/项目上下移入口回归红灯。两者修后通过。
- release 的最后 scroll ACK 与末次 move 合并分别真实红灯，修后绿。
- 完整顺序 a/b/c/d/e、可见 a/b/e，把 a 拖到 e：原 controller 写 b/c/d/e/a；修后写 b/e/a/c/d，与 Web 可见子集一致。回归先红后绿。
- 同模型独立只读 reviewer 发现 release offset、可见子集、横滑复位三项；修正后同一 reviewer 复核确认三项消除，限定范围未发现新确凿问题。review 仅本地 read/grep，未改文件、未跑 engine/设备。
- `projects-order-body.test.ts` 执行**当前生产** Group → SessionRow → touch owner → controller scope 的闭包接线；不是复制算法。验证原生 Scroll 初次无 onScroll 事件时仍通过实测 content 得到 extent、菜单隔离、取消、滚动锁释放与一次点击抑制。它仍不是 UIKit responder 分发证据。

## Web 实际入口对照

| 行为 | Web 证据 | Native 状态 |
| --- | --- | --- |
| 首页目录内会话排序 | `MobileProjectsHome.tsx` SessionList，独立 SessionFolderDndScope | 正文 350ms/6pt 分组内拖排；额外 Sheet 已移除，UIKit 待验 |
| 首页置顶内排序 | 同文件 pinned SessionList 使用 `__pinned__` | 相同正文交互，独立 geometry 与持久 scope |
| 进行中列表排序 | 同文件 inProgress SessionList 无 orderScope | 不提供独立排序；保留 |
| 会话跨目录/置顶拖放 | 每个 SessionList 单独 DndContext，不注册跨组 droppable | 不允许；controller 跨 scope 身份零写入测试通过 |
| 首页普通项目头 | MobileProjectCard：tap toggle、long press actions，未接 DnD | 移除额外 up/down，无首页项目拖动 |
| 首页工作树头 | MobileWorktreeGroupLabel：tap toggle、横滑、long press actions，未接 DnD | 移除首页 handle/up/down，保留正文与 more 菜单 |
| 编辑项目的工作树排序 | `MobileProjectEditSurface.tsx` SortableWorktreeRow：handle，PointerSensor distance 8 | ProjectDetail 保留 handle，distance 8/真实 header geometry，UIKit 待验 |
| 会话触摸激活 | `sessionFolderDnd.tsx`：TouchSensor delay 350ms/tolerance 6，纵轴、closestCenter | 生产正文已接线，右侧 more 排除，变高行最近中心 |
| 保存时机 | 会话 drag end 保存；Web 编辑页 handleWorktreeDragEnd 当场调用 setWorktreeOrder | 松手提交，取消未完成手势不提交；读取失败不重放写入 |

## 已执行的限定验证

- Vitest 限定五文件：`projects.test.ts`、`projects-order-gesture.test.ts`、`projects-order-touch.test.ts`、`projects-order-body.test.ts`、`projects-order-uikit.test.ts`。原 50 controller 断言全部保留并执行；新增 scope/ACK/队列、实际正文接线与 Foundation Host 合同覆盖。
- 最新限定运行 127/127 通过。独立只读复核确认 release、可见子集、横滑复位三项已消除，未发现新确凿缺陷；UIKit 仍未验。
- `node packages/nsh/scripts/build-projects-order-uikit.mjs --stage-only`：生产 fixture 的完整 TypeScript 依赖图通过，152 项源码/依赖逐字节 stage 与 SHA 验证通过。没有运行 NSH 编译。manifest 的 bundleBuilt/appBuilt/launched/uiKitGestureValidated 均为 false。
- `xcrun --sdk macosx swiftc -swift-version 5 -typecheck .../SyntheticHost.swift`：通过；Foundation Host 纯测试也编译执行该文件，不包含 NSH 或 UIKit。
- 仓库全量 tsc 会随并行 worker 变化；最近一次只报范围外 `chat-changes-workspace.tsx` 的 For 未定义，未改其文件。上述 fixture-root 依赖图独立类型检查通过。
- 后续并行全仓 tsc/dead-code 的 60 秒运行超时；dead-code 独立后台重跑已完成并检查报告，只有已有广泛报告与独立 CLI fixture 的 unused 入口提示，未把新生产 touch/gesture owner 列为 unused。全仓 tsc 超时不算通过，fixture-root 独立类型检查通过。
- 500 行 × 240 次 move：每行仅 grant 测量一次，move 零 measure / 零写入，重复 release 最多一次 commit。此为操作次数预算，不是 UIKit 帧耗时验收。
- `projects.test.ts` 只隔离 NativeSheet UI leaf，实际 `createPageOperations` 与 Projects controller 均执行生产代码；显式推进 generation 时重跑 effect，旧 read 的 `page_operation_stale` 按生产合同断言。同 Host 新快照采用单调 revision，未重置为 revision 0。
- 未启动 engine、模拟器、真实 Host 或产品模型请求；只执行了用户授权的同模型只读 review。未运行 Git 命令。

## 交给 main 的 UIKit fixture

真实载体与完整操作见 `tests/projects-order-uikit/README.md`。入口 `tests/projects-order-uikit/fixture.tsx`，Foundation Host / main 位于同目录，构建脚本为 `scripts/build-projects-order-uikit.mjs`。**由 main 独占实际构建/设备**。旧 `projects-order-fixture.tsx` / `projects-order-host.js` 只是 CLI `--web-host` fixture，不能作为公开 NshAppView 的 UIKit 注入方案。

最终静态 stage：`.nsh/projects-order-uikit/2026-11-07T14-46-16-731Z-fc144c92/fixture-build.json`，152 项逐字节副本/SHA（含构建器自己的 stage 字节）。它记录 bundleBuilt/swiftTypechecked/appBuilt/launched/uiKitGestureValidated=false；Foundation Host 的 macOS 单独 typecheck/运行不冒充 iOS UIKit Swift 编译。

UIKit 导航会把真实 `nav.routes().at(-1) === route` 传给新增的 Projects active 合同。main 已确认 production application 接入根路由且 tab0 的 Home active，以及顶层 route 的 Detail active；application 仍由 main 所有，本 worker 未修改。根 Tab 的 If 卸载已有 cleanup，覆盖页依赖显式 active，不能由本模块猜 nav 状态。

尚需 main 实测：UIKit responder/Scroll 竞争、Overlay 根坐标、真实变高行与滚动中布局取消、持指边界自动滚动、后台/导航取消、NativeSheet 协调及真实 Host 持久化跨客户端回读。NSH 手势的触觉反馈目前没有可用既有桥；未新增 Swift 触觉实现。提供静态/纯测试与载体不等于触摸还原验收完成。

## main 的增量 UIKit 证据与时间格式修复

- main 实测置顶 `s1-0 → s2-0` 后的可见顺序正确。证据 `.scratch/nsh/projects-drag-pinned-reorder-20261107-a1/`，本 worker 只读取已存在的采集结果，没有操作设备。
- `.scratch/nsh/projects-drag-pinned-audit-20261107-a1/after.json` 已核对：sessionOrderWrites=1、worktreeOrderWrites=0、rejected=0，journal 仅 `scopeKey:__pinned__`，order 为 `[s0-0,s2-0,s1-0]`，activity 空对象。目录 orders 保留完整成员，进行中专属 s0-11 没有进入 pin rank。这只验收该置顶拖排样本。
- main 后续 Detail AX timeout，Detail handle 不算完成验收。main 报告修正独立 builder 的空 assets 根目录处理并重建签名安装包 `2026-11-07T14-52-49-656Z-bf8958ac`；该 builder/main 改动归 main，本轮未改。
- main 真图还揭出旧 timestamp=1000 显示 20764d。Native 生产 formatter 回归已先红：`expected 20764d to be Jan 1`（该测试运行环境的 Intl 日期）。现将 Web Home 与 MobileSessionsSheet 完全相同的算法抽到已有 import-free `time-format-core.ts`，三个 reader 直接复用；不复制算法，不导入 Web/React runtime，不修改 UI 设计。
- 保留默认 Intl locale/时区和未来时间 now；精确覆盖分钟/小时/天/七天边界，非法/范围外 Date 不显示文本。37 条共享时间测试、6 条 Web model/reader 测试、107 条限定 Native 时间/controller/手势测试均通过。Web 与 Native 生产 reader 依赖图分别类型检查 0 diagnostics；独立只读 review 未发现确凿问题。dead-code 已完成，保留原有未使用 barrel 导出提示，未删兼容导出。
- 本轮未运行 QuickJS/NSH engine、UIKit、设备或构建脚本；main 的 full iOS build 正在独立运行。时间修复的设备呈现需要后续包含该源码的新 bundle，纯测试绿不能替代真图。

## Detail 真实 red 后的 handle 修复（等待 main 新包复验）

后续 main 的 df5bda28 包已通过初次竖拖/斜拖两个样本，后台恢复 e1 仍为 red；最新 ref 所有权修复、fixture 前台 admission、纯测装载、源码 SHA 和待跑命令见 `PROJECTS-FIXTURE-VALIDATION.md`。以下原始 handle 修复记录保留为当时证据，不代表后台恢复已验收。

- 实际失败包仍为时间修复前的 `bf8958ac`。已读取 `.scratch/nsh/projects-drag-detail-vertical-20261107-c1/` 的 touches、held/after 真图，以及 `projects-drag-detail-audit-20261107-c1/after.json`：a/b/c 未变，worktreeOrderWrites=0、rejected=0、journal 空，不能归因为 Host 拒绝。斜拖证据 `projects-drag-detail-trees-20261107-b1/after.json` 确实回到 Projects order UIKit QA 根。
- 原 handle 仅在 move 时申请 PanResponder，grant 未返回 true，也未接入根 Scroll 租约或 NavPage 返回保护。真实样本未有旧回调审计，不能据源码断言原生在哪一个阶段抢走；修复和新增审计共同覆盖这些缺口。
- 当前 handle 改为 raw touch capture/responder owner。按下取得唯一 Scroll 租约并测量实际 header，grant 明确返回 true，超过 8pt 才激活拖排。父横滑在租约期间拒绝准入；激活时收起旧横滑。Detail 的 popOnSwipe 和 Scroll.scrollable 均由同一租约控制，松手/取消释放，不永久关闭返回。
- release 使用最后手指坐标，只允许一次 drop，等异步测量返回后才选择真实中心。serial、Host generation、页面 current 与完整成员顺序均须仍有效；release 后正在等待测量的 settling 手势也会在页面关闭/重开、成员变更或卸载时退役。取消、多指、scrollstart、内容 layout 变化会释放租约并禁止迟到写入。controller、scope、隐藏 ranks、metadata、ACK/unknown-write 规则未改。
- 新生产回调测试先红：旧 WorktreeRow 的 handle 缺少 onTouchStartCapture；修复后限定六文件 141/141 通过，其中 gesture 文件 23 条。包括竖拖 18 move、斜拖父横滑拒绝、真实 NavPage/Scroll 属性表达式共享租约、8pt 边界、未 grant 零写、测量在松手前/后返回、多指、terminate、页面失活/重开、epoch、卸载与 500 行/240 move 的操作次数预算。此预算不是 UIKit 帧率证明。
- Web 共享时间与 reader 两文件 43/43 通过；现有 UI setup 拦截并报出未 mock 的启动 fetch，没有访问真实 Host。生产 UIKit fixture 依赖图独立类型检查为 0 diagnostics。额外把 Node 测试硬塞入 Native tsconfig 不适用；改用 Node 类型配置后仍有原有 JS 合成 Host 的五处联合返回值类型报错，因此未将 callback 测试独立 tsc 标记通过。Vitest 实际执行通过。
- 同模型独立只读 review 未发现确凿缺陷；dead-code 已完成并检查，未报告新 gesture/type unused，保留既有 formatRelativeShort barrel 提示。未运行 NSH、设备、UIKit、构建脚本或 Git；未修改 main/application/state/runtime/生产 Swift/builder。
- fixture 新增只读 `projects-order-uikit-gesture-audit`：仅阶段计数和最近 32 条 phase，无正文、身份或坐标；没有替代拖动按钮。main 新包的复验步骤与判读见 `tests/projects-order-uikit/README.md`。必须以实际 write journal、排序真图及恢复后的系统滚动/返回一起验收，当前 Detail UIKit red 仍处于待复验状态。

交付时四个核心源码的 SHA-256（main 若有后续编辑，应以新构建逐文件 manifest 为准）：

```text
ad5241bc3d3ac286531a302314560d66467d8c6b49a6d389c6429637ee073132  packages/nsh/projects-order-gesture.ts
bf52c875ec0ca7205c58115f5c35a66111c47eed4d0f6deaa300544183e48546  packages/nsh/projects.tsx
b41d0aede965d7822423c52f3e3256f9815c754b2fab5a6515b9b6da2589f1fa  packages/nsh/tests/projects-order-uikit/fixture.tsx
9b8a741c265822e0fcecbe9eaaa0c10c4890c352edd7626647f3ecc1e16a99f2  packages/ui/src/lib/time-format-core.ts
```
