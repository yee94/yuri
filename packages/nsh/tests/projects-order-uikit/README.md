# Projects order UIKit fixture

此目录才是 UIKit 载体。`projects-order-host.js` 仅供 CLI `--web-host`，不能注入公开 `NshAppView`。这里由 `uikit-main.swift` 注册 Foundation-only 内存 Host，加载生产 TSX bundle；不加载生产 RuntimeBridge、ConnectionStore，不连接网络、Keychain 或模型。

生产 UI 是 `ProjectsHome` 和 `ProjectDetail`，fixture 只提供导航及只读 audit。不存在替代拖动的排序按钮。Host 仅允许两个排序协议写内存；所有 runtime 请求都必须携带原样的 synthetic `expectedHost`，其它 session/model/filesystem/Git 写入均拒绝。

## 构建边界

- 静态 stage：`node packages/nsh/scripts/build-projects-order-uikit.mjs --stage-only`。只做 TypeScript 检查、Bun 依赖图、逐字节副本及 SHA 清单；不调用 NSH/Swift、签名、engine 或设备。
- **main 独占执行**实际构建：设 `NSH_BIN` / 可选 `NSH_DIST`，运行 `node packages/nsh/scripts/build-projects-order-uikit.mjs`。
- 脚本为每次构建生成独立 `example.nsh.projects-order-uikit.run-<suffix>` 与 `.nsh/projects-order-uikit/<buildID>/`，不覆盖生产 App；Swift 编译使用同一 stage 的原始字节副本。
- `fixture-build.json` 保存源码/依赖逐文件 SHA、seed、Swift 源、公开 interface SHA、bundle 与可执行文件 SHA、签名验证状态；未实际构建的字段保持 false。构建脚本不安装、不启动、不执行设备测试。
- `--bundle-only` 仅供 main 构建 NSH bundle；也不启动 engine 或设备。

## 真实路由和触摸 IDs

根导航：

- `projects-order-uikit-open-home` → 实际 ProjectsHome。
- `projects-order-uikit-open-detail` → 实际 ProjectDetail 原生 NavPage，原工作树 handle 可触达。
- `projects-order-uikit-open-audit` → 只读 audit。Home header 的 `projects-order-uikit-audit` 也能打开。Detail 返回根再打开 audit，避免往生产详情插测试按钮。

固定 seed：主目录 `/fixture/repo`、工作树 `/fixture/a`、`/fixture/b`、`/fixture/c`；前两者各 12 条会话。置顶 `s0-0/s1-0/s2-0`；运行中 `s0-11`。偶数行含 change summary，目录/置顶行自然高度不同。持久化 worktree rank 额外保留 `/fixture/retained-unloaded-tree`，它不出现在 catalog 中。

1. 进入 Home。直接在正文 `project-session-touch-/fixture/repo-s0-0` 按住 **350ms** 后拖到第二行 `s0-1` 中心，松手。原行应变淡，浮层保留实测尺寸，邻行让位；不能打开会话或菜单。松手后 audit 的 `sessionOrderWrites` 只加 1，scope 为 `/fixture/repo`。
2. 在正文 350ms 前移动超过 6pt：纵向应滚动，横向应露 Pin/Archive；零排序写。正文菜单只由 `project-session-menu-s0-0` 打开。项目/工作树头仍可长按菜单。
3. 置顶正文 `project-session-touch-__pinned__-s0-0` 拖到 `s1-0`。只写 `__pinned__`，不写两个目录。拖出其它目录也不能把会话转移过去。
4. 主目录初始可见前三条及运行中的 s0-11。拖 s0-0 到 s0-11 后，audit order 应先 `s0-1,s0-2,s0-11,s0-0`，再保持隐藏 `s0-3..s0-10`。不能按全目录把隐藏行插回预览中间。
5. 点击 Show more 展开目录；按住正文并移到**当次实测 viewport 的底部 20%**，保持手指，应向下自动滚动，落点随实际 native offset 更新。移动到顶部 20% 则向上。松手/取消后不能继续滚动，下一次普通滚动仍可用。
6. 先左滑露栏，再长按正文拖排；激活后旧横滑偏移应归零。松手后仅吞该次拖动点击，下次正常点击应能打开会话。
7. 取消：多指（包括第二指在另一行）、native scrollstart、内容重排/折叠、返回、后台恢复、系统 responder terminate 均不得提交；不得遗留禁用滚动或继续自动滚动。后台同 Host 恢复旧手势不得复活。
8. Detail 中从 `project-worktree-drag-/fixture/a` 拖到 b 的实测 header 中心。audit 的 `worktreeOrderWrites` 仅加 1，paths 为 b/a/c/retained；首页不能出现该 handle 或额外排序 Sheet/项目上下移菜单。

Audit IDs：`projects-order-uikit-count-sessionOrderWrites`、`projects-order-uikit-count-worktreeOrderWrites`、`projects-order-uikit-orders`、`projects-order-uikit-treePaths`、`projects-order-uikit-activities`、`projects-order-uikit-journal`。`projects-order-uikit-audit-refresh` 只读，不改变排序计数。

Detail raw responder 修复需要 main **新构建**，旧 `bf8958ac` 包不含本次 handle 修复或共享时间修复。新 build 的源清单必须同时包含 `projects-order-gesture.ts`、`projects.tsx`、本 fixture 与传递依赖 `packages/ui/src/lib/time-format-core.ts`；本 worker 不操作 builder、engine 或设备。

新增 `projects-order-uikit-gesture-audit` 为进程内只读阶段计数和最近 32 个阶段，不含项目/会话身份、坐标或触摸正文；它只接收真实生产 handle 的回调。阶段有 start、claim、grant、move、activate、measured/unmeasured、release、drop、terminate/cancel/stale。重复 capture/responder move 可以各计一次，不能把 move 计数当物理帧数；drop 只应一次，Host journal 才是写入结果证据。

main 新包复验顺序：

1. 记录新 build ID、源码 SHA 与初始只读 audit；重新读取真实 handle 的当前 frame，不复用旧包坐标。
2. a handle → b handle 垂直约 64pt，保留原 400ms hold/18 move/288ms release 样本。held 应仍在 Detail，原 Scroll 不滚；松手后 b/a/c，可见排序与 Host journal 一致，worktreeOrderWrites 只加 1、sessionOrderWrites 不变、rejected=0，隐藏 retained rank 保留。
3. 返回根打开 audit。start/claim/grant/activate/measured/release/drop 均应存在；只有 start 没 claim 表示准入/租约失败，claim 无 grant 表示原生 responder 仍失败，unmeasured 表示几何失败，stale/cancel/terminate 表示手势或页面被废弃。零 Host 写入不能再据纯测试推断成功。
4. 重开 Detail，以实际新 frame 重放向右斜拖，held/after 必须仍在 Detail，不能回根；确认独立的一次排序写。松手后普通竖滚和系统 swipe-back 都必须恢复。零位移点击 handle、native terminate、多指、后台/覆盖页取消都应零排序写且不遗留 Scroll/返回锁。
5. 在 Home 与 Detail 核对旧 timestamp 的时间标签与同环境 Intl 短月/日一致，不再是 20764d。首页 pinned 之前的实机成功证据只适用于原样本，不能替 Detail 验收。

## 验收状态

提供 fixture、静态 stage 或 Foundation Host 纯测试不等于 UIKit 已构建/运行。当前 worker 不运行 NSH 构建、engine 或设备；由 main 记录实际构建、启动、触摸视频与 audit 前后证据。UIKit 的 responder/Scroll 竞争、Overlay 根坐标、真实触摸自动滚动、NativeSheet/导航取消仍须实际验收。此载体不证明真实 Host 跨客户端持久化。

### 后台恢复增量（main e1 仍为 red）

main 的 `df5bda28` 包在 d1 已验证初次竖拖和斜拖各一次、Back button 恢复、隐藏工作树保留；累计 worktreeOrderWrites=2、rejected=0。e1 的持指后台取消没有新写入，但恢复后的 fresh drag 出现 unmeasured=1、stale=1，write 仍为 2，因此后台恢复尚未通过。

后续源码修复了同路径新行 ref 登记后被旧行 cleanup 删除的确凿生产回调失败；并让此 fixture 复用 Projects 专属 admission helper：每次前台调用实际 `loadConnections({ forceReconnect: true })`，等待确认后才给 Home/Detail active。ready 一旦建立不因挂后台卸载 NavStack；旧 operation/sender 不被借给新 Host。新 build 必须包含新增传递依赖 `tests/projects-fixture-admission.ts`。

main 新包还需重放：持 a handle → 后台 → 抬指 → 同 bundle 回前台，取消阶段新增 write=0；确认恢复后新拖 a→b 必须新增恰好一次 write，累计从 baseline 增一、rejected=0，a/b/c 与隐藏 rank 正确。fresh drag 必须有 measured/drop，不能以 unmeasured/stale 或零写入作为通过。随后验证普通滚动、Back button 与系统 swipe-back 均可用；d1 旧包样本不能替这一项验收。
