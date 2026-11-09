# Desktop sidebar：本轮交接与验收边界

## 所有权

- `desktop-sidebar.tsx` 继续只创建一个 Projects controller；目录、attention、文件夹、归档、父子读取、排序与删除 journal 均委托该 owner。没有第二份 catalog、socket 或导航选择 authority。
- `desktop-sidebar-projection.ts` 只派生导航头像、未读与 activity、live 父链、内容缩进和相对时间。未提供数据不触发补读，也不从消息历史推测 running。
- `desktop-sidebar-indicator.tsx` 从根已采用的 canonical appearance 读取 PC 状态色；未知主题回退现有 Yuri 主题，不逐行请求外观。
- `desktop-sidebar-archived.ts` 仅在明确的删除动作中驱动原 `sidebar.loadArchived` 排空页面。不拥有网络、缓存或后台扫描。
- `desktop-sidebar-navigation.ts` 保留唯一导航 focus；同一会话在 top/project 中重复出现时，只选中实际打开的表示。行选择不直接清未读，阅读 authority 仍归根/Chat。

## main 需要接的窄接口

`DesktopSidebarProps.authority?: DesktopSidebarAuthority | null` 只接收现有 owner 的只读投影：

```ts
{
  scope: desktopSidebarScope(connection, epoch),
  assistants: { enabled, contacts },
  schedules: scheduledItems,
  sessions: new Map([
    [desktopSidebarSessionStateKey({ id, directory }), {
      hasChildren, running, navigationRunning, unreadCount,
    }],
  ]),
}
```

上例的 `connection/epoch` 必须是当前真实值；无连接不发布该 port。`scope` 完全匹配才采用，Host/授权/代际变更后旧对象无效。省略字段表示未知，不得补 `true`、零或历史推断。

- `contacts` 使用 `DesktopSidebarContact`，保留服务器的 enabled、saved avatarSeed、latestMessagePreview、working、activeContactTurn、unreadCount。能力总开关来自已知 assistant snapshot，而非仅有 `app.bots()` 的数组。排序直接复用 Web `sortAssistantContacts`；未读、working 和 pin 不改变头像排名。
- `schedules` 消费既有任务项的 `task.lastStatus`；只认明确的 `running`，不启动另一份 scheduler/catalog。
- `sessions` 以规范化目录加 session ID 为键。`running` 是会话自身 live execution；`navigationRunning` 才是包含后台 shell 的 live 聚合。父链只提升已知 live 子会话，采用一次共享 O(rows + edges) 投影。
- 现有 controller 的 `sessionFrom` 未保留 index `hasChildren`，因此必须从真实 index/retained authority 提供 hint。不能给所有行画箭头或逐行 GET 猜测。已经显式读取的非空 child page 可以保留箭头。
- `onNewSessionInFolder?: (project, {scope, id}) => void` 交回现有新会话草稿 owner。`project.path` 是实际目录（含工作树）；调用方须将 membership 保留到首次创建/发送 admission，再通过原文件夹 owner 写入。不能仅调用普通 `onNewSession` 假装已归组。未接 hook 时不显示假按钮。

本轮核对的生产 `application.tsx` 尚未传入上述两个新接口；本 slice 没有修改 application、state、Projects 或新会话实现。

## 呈现与交互

- 对照真实 Web 侧栏测得的 chip 为 33pt 高；full-width hover/active wash 不随树层级内缩。根内容 padding 8pt，项目下 30pt，此后每层 +14pt。
- 项目/工作树图标与展开箭头共槽；hover/focus 显示 quick actions。会话右侧只放 pin/archive，不再增加 visible drag handle 或 more 按钮。右键使用原生 ContextMenu；Move to folder 使用原生 Submenu。
- 固定 NSH 0.4 `Button` 的 press 不带事件；需要 pan/modifiers/AX state 的行使用语义 `View role="button"`。没有 any cast、透明命中 overlay 或第二套手势 owner。
- 会话与已有文件夹重命名使用原位 Input、check/cancel；Enter 提交，输入焦点内 Escape 取消。模态 `interactive=false` 保留同一稿、rows、folds 和 source owner。
- busy/retry 会话的菜单仍提供 Sync messages，不替换成 Stop。Share 在当前 OpenCode 2 不支持时像 Web 一样隐藏，不提供点击后才失败的假入口。
- 文件夹提供 hover 的新会话 hook、一级新子文件夹、rename/delete 直接动作；删除文件夹保留内部会话，确认文案反映实际子文件夹数。原非 Web 的 more/parent 选单不再作为可见 chrome；既有 parent 写协议未改动。
- Archived header 使用相同 33pt chip、图标/chevron 槽与内部缩进；移除额外新建文件夹按钮。
- 整组/归档文件夹删除先排空点击时已注册目录的全部 opaque 页；失败、未完成、循环游标、外目录或过期结果均不授权删除。文件夹删除还先回读 membership。确认后逐根委托 controller 的子树枚举、Undo 和失败 journal，不以折叠窗口充当完整集合。某根失败不取消其它根已经有效的 receipt；重试排除已经排入删除 journal 的根。
- 文件夹创建后 membership 失败保留 created receipt，再提交不会重复 Create；未确认写入仍通过原 owner 的只读核验恢复，不绕过其 LWW/无 CAS 限制。

## 验证

所有引擎 wrapper 使用私有临时 config、generated tests 和 output，结束后清理；不写共享 `.nsh/test`。固定使用 NSH 0.4.0 distribution 与源码 revision `e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3`。

```sh
NSH_BIN=/path/to/nsh/bin/nsh bunx --no-install vitest run \
  --config packages/nsh/vitest.config.ts packages/nsh/desktop-sidebar*.test.ts
NSH_SIDEBAR_MOUSE=1 NSH_BIN=/path/to/nsh/bin/nsh bunx --no-install vitest run \
  --config packages/nsh/vitest.config.ts packages/nsh/desktop-sidebar-mouse-native.test.ts
bunx --no-install tsc --noEmit --project packages/nsh/tsconfig.json --pretty false
```

`NSH_SIDEBAR_FILTER` 可将引擎内场景缩到名称子串；正式回归不设置它。异步排页后出现的 AlertDialog 必须由测试的真实 step 回答；NSH `waitUntil` 只观察，不能把已记录的 dialog 当成已完成确认。

本轮完整 focused run：10 个文件通过、1 个显式平台 opt-in skip，外层 38 项通过。三个 wrapper 内部是 production sidebar 24 场景、macOS/Windows chrome 8 场景、authority parity 6 场景，共 38 个 headless 场景。另以 opt-in 运行真实 AppKit mouse adapter 1 场景通过；它只验证内存 fixture 的生产 drag adapter，不代表完整侧栏窗口视觉验收。

覆盖包括权威缺失/过期/禁用、saved avatar、99+、独立未读与运行、question/permission、hover、child hint、50 次模态更新零 catalog fanout、resize、原位 rename、文件夹子级与 draft hook、opaque 归档尾页/失败保护、删除/Undo、排序失败/unknown ACK 和导出。纯投影包含 20,000 层 live tree 与紧凑相对时间边界。

本轮全包 TypeScript 检查曾通过；最终复跑仅报范围外 `composer-send-test-app.tsx:18` 的 `frame` 可能为 null（TS18047），侧栏没有类型诊断。未修改该并行 slice。`bun run dead-code` 已执行，但加载 Web Vite 配置时缺 `vite-plugin-pwa` 而退出，未产生有效 dead-code 报告；没有为此安装依赖或修改范围外配置。

## 仍未完成，不可按全量 PC 1:1 签收

1. main 的真实 authority 与 folder-draft 接线及生产根回归。
2. 批选 mode、Shift range、BulkActionBar、批量 membership/归档/删除尚未实现。当前 Web 有 mode/store 与 bar，但本轮未定位 mode 启用 consumer；没有凭空新增可见开关。
3. 完整拖排仍缺跨父级 folder reparent、跨 folder session 转出等组合；现有同级 folder/project/worktree/session 排序、session drop 入 folder 已有合成回归。不能把这些称作完整 DnD。
4. Shift+点击 archive 的硬删语义已验证；鼠标静止时仅按/松 Shift 的即时图标/label 切换仍未完成全局原生键盘观察，不能以 mousemove 分支当作完整键盘验证。
5. 文件夹创建呈现、全部 archived-folder destructive/部分失败/unknown 组合、live shell 的生产投影、全量长列表虚拟化与恢复仍须继续核对；没有单独复制 Web 后台任务或设备 owner。
6. 完整侧栏 AppKit/Win32 窗口的深浅主题、长文本、菜单/focus/键盘、AX 读屏和同状态视觉未验。真实 AppKit adapter 测试不代替这些检查；本轮未访问真实 Host 执行写入。

本轮所有生产改动限于 `desktop-sidebar*.ts*`；iOS Projects 与普通 Chat 消息呈现不变。
