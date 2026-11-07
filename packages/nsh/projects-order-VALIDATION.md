# Projects 拖拽专项

## 已证实并修复

- 原生产 `WorktreeRow` 在 grant 记录 index，release 用 `round(dy / 56)` 推算落点。首页工作树之间含展开会话：header 中心为 28/328/388 时，向下 300pt 原实现错误提交到第三棵；150pt 原实现也提交第三棵。新实现一次读取同组所有真实 header 的 pagePosition/height，采用最近中心；这两个场景分别落第二棵与不移动。
- 原排序 Sheet 行高 56，但 Scroll 的 `gap-2` 参与真实几何。中心 28/92/156、向下 90pt，旧算法错误落第三行，新实现落第二行。
- 原生产两种 PanResponder 均未捕获 grant 的 epoch。旧 gesture 松手可在同 Host 已恢复的新代际调用写入口。新 gesture 代际变化、关闭、卸载、terminate 或成员/顺序变化均取消；异步测量缺失/失败不猜落点。
- 原工作树拖动未标记 suppress，release 后的 click 可展开/收起工作树。现在与 swipe/long press 共用一次 click suppression。
- controller 的原 `scope()` 仅返回 `lane.current`，显式 dispose 后晚到目录读取仍可采用。原 50 条断言恢复执行后暴露此问题，现 scope 同时检查 alive。

`projects-order-gesture.test.ts` 抽取**当前生产函数声明**并执行真实 `PanResponder.create` 闭包，注入几何/Host 端口；不复制生产落点算法。前五条在修前真实失败（不是 VM require 失败），修后通过。它仍不包含 UIKit responder/Scroll/System Sheet 分发。

## Web 实际入口对照

| 行为 | Web 证据 | Native 状态 |
| --- | --- | --- |
| 首页目录内会话排序 | `MobileProjectsHome.tsx` SessionList，独立 SessionFolderDndScope | **未还原**：只有额外排序 Sheet；本次未新增别的 UI |
| 首页置顶内排序 | 同文件 pinned SessionList 使用 `__pinned__` | 同 scope 持久化已有；入口仍为 Sheet |
| 进行中列表排序 | 同文件 inProgress SessionList 无 orderScope | 不提供独立排序；保留 |
| 会话跨目录/置顶拖放 | 每个 SessionList 单独 DndContext，不注册跨组 droppable | 不允许；controller 跨 scope 身份零写入测试通过 |
| 首页普通项目头 | MobileProjectCard：tap toggle、long press actions，未接 DnD | Native 菜单额外 up/down，无首页项目拖动；不是已还原的拖动入口 |
| 首页工作树头 | MobileWorktreeGroupLabel：tap toggle、横滑、long press actions，未接 DnD | Native 有额外 drag handle / up/down；本次保留现状并修几何，不能把额外功能算 Web parity |
| 编辑项目的工作树排序 | `MobileProjectEditSurface.tsx` SortableWorktreeRow：handle，PointerSensor distance 8 | Native ProjectDetail 有 handle；几何修复，UIKit 未验收 |
| 会话触摸激活 | `sessionFolderDnd.tsx`：TouchSensor delay 350ms/tolerance 6，纵轴、closestCenter | **未还原**首页长按拖动；排序 Sheet 为 handle distance 10 |
| 保存时机 | 会话 drag end 保存；Web 编辑页 handleWorktreeDragEnd 当场调用 setWorktreeOrder | Native 松手即写，Sheet Done 仅关闭，不回滚已提交顺序；取消未完成手势不提交 |

## 已执行的限定验证

- `bunx vitest run --config packages/nsh/vitest.config.ts packages/nsh/projects.test.ts packages/nsh/projects-order-gesture.test.ts`：69/69 通过（原 50 controller + 3 条保护 + 15 条生产手势闭包 + 1 条合成 Host）；额外覆盖 ACK 后 GET 失败仅显式只读恢复、旧 Host 队列事件不读新 Host、跨组 drop 无写入。
- `bunx tsc --noEmit --project packages/nsh/tsconfig.json --pretty false`：通过；合成 Host 的 Bun browser ESM bundle 通过。
- `bun run dead-code`：退出 0，已有仓库报告仍存在；新 `projects-order-fixture.tsx` 是显式独立测试入口，被列为 unused，不从生产 App 引入。
- `bun run --cwd packages/nsh nsh:check` 未执行成功：当前 PATH/NSH_BIN 没有 nsh（spawnSync nsh ENOENT）。未为了运行检查启动任何 engine 或设备。
- 500 行 × 240 次 move：每行仅 grant 测量一次，move 零 measure / 零写入，重复 release 最多一次 commit。此为操作次数预算，不是 UIKit 帧耗时验收。
- `projects.test.ts` 只隔离 NativeSheet UI leaf，实际 `createPageOperations` 与 Projects controller 均执行生产代码；显式推进 generation 时重跑 effect，旧 read 的 `page_operation_stale` 按生产合同断言。同 Host 新快照采用单调 revision，未重置为 revision 0。
- 未启动 engine、模拟器、真实 Host、Git 命令或模型请求。

## 交给 main 的 UIKit fixture

入口 `projects-order-fixture.tsx`，Host `projects-order-host.js`。**由 main 独占设备启动**。Host 只含内存数据，无网络/文件/Git/模型实现；使用真实 `loadConnections()` 获取其明确的 synthetic runtimeScope，再挂载生产 ProjectsHome，未绕过 admission。

隔离配置需要 `runtime.request`、`connection.list`、`projects.order.audit`、`projects.order.failRead` 四个 host capability；Host 先用 Bun bundle 为浏览器 ESM，再交给 NSH `--web-host`。不要把 capability 写入生产 nsh.json。

fixture 目录：`/fixture/repo` 主目录 + `/fixture/a`、`/fixture/b`、`/fixture/c`；a 有 8 个会话，其他各 3 个；s0-0/s1-0 是置顶；第一个会话带 change summary 产生变高行。

1. 点击 `project-worktree-/fixture/a` 展开，再 Show more，制造真实变高 group。记录每个 header 的实际框。
2. 从 `project-worktree-drag-/fixture/a` 向下拖到 b header 中心，松手；点击 `projects-order-audit`，`projects-order-audit-result` 应只有一次 worktrees 写入，ids 为 b/a/c。150pt 附近仍离 a 最近时应零写入；不要拿固定坐标替代当次测量。
3. 查看主目录 `projects-order-/fixture/repo` 的排序 Sheet；拖 `projects-order-drag-/fixture/repo-s0-0` 到第二行中心。audit 只改 `/fixture/repo`，不改 `/fixture/a` 或 `__pinned__`。
4. 置顶排序入口 `projects-order-__pinned__`；拖 `projects-order-drag-__pinned__-s0-0` 到 s1-0。audit scope 必须为 `__pinned__`。
5. 从正文快速纵向滑动应只滚动；拖 handle 后松手不应展开树/打开会话；横滑仍显示原动作。测试 system Sheet 抢手势、关闭/重开、拖到不同目录、拖到边界的真实触摸行为。
6. 点击 `projects-order-fail-read` 后做一次排序，其 preflight GET 失败应零写入并保留既有顺序。此开关**不能模拟 ACK 后 GET 失败**；该场景只有 controller 测试证据。

尚需 main 实测：UIKit 触摸竞争、滚动中布局/内容变化、拖到边界的自动滚动、Sheet 下拉取消、长按菜单与正文排序的协调、真实 Host 的持久化跨客户端回读。不以本次纯测试绿灯认定触摸还原完成。
