# load more 分组行重置排查

2026-11-07。范围是生产 Chat 倒序 List 的条目身份，不改分页协议，不新增滚动 offset writer。

## 原因和修正

NSH TSX `List.each` 按对象身份 `===` 匹配；`keyExtractor` 只命名 viewability token。原接线传入 `NativeBodyRow` 对象，旧页扩展同一 assistant run 时，即使 key 不变，也会替换该对象。原生 List 因而收到整行删除/插入，不能靠同名 key 保住阅读位置。

真实 Host 两个 20 条页面的只读诊断显示：合并前后都是一条分组行，保留 key，但未保留对象身份；组内消息由 17 条扩展为 36 条。未保存或输出消息正文、连接凭据。

生产 `application.tsx` 改传 primitive `bodyRowKeys()`，cell 内由 `bodyRowsByKey()` 读取最新投影；暂时缺失用 `If` 处理，不缓存旧正文。分组、head/tail、最新定位、分页意图及唯一原生滚动 owner 不变。

## 已取得的证据

- 最小 UIKit 反例：20 条 assistant 合并为同一行，真实拖动后加载 20 条更早消息，原阅读标记从 175pt 跳到 3244pt，位移 **3069pt**；仅修正 List 条目身份后，同场景位移 **0.67pt**，原生测量为 0。此为合成载体，不是生产 Host 端到端通过。
- `history-grouped-layout-fixture.tsx` 将同一分组连续扩展八页，每页原生测量 30 次。在独立 UIKit 模拟器完成三轮，共 **24 页 / 720 次原生测量**；三轮最大原生位移为 **0 / 0 / 0.00048828125pt**。独立 AX 取样前后同一标记的位移为 0 / 0 / 约 5.7e-13pt。每轮真实拖动后，经 fixture 的连续八页按钮采用数据；不是八次独立触摸分页，也没有声称取得逐帧视频验证。不能拿交替 user/assistant 的旧独立行 fixture 代替。
- 定向 Vitest 六文件 **59 passed**：history rows、scroll、state、focus、footer controller、messages。机器负载较高时首次 state 测试超时，重跑使用 20 秒测试超时。
- 新增生产接线 guard，临时恢复旧的对象条目接线后实际变红；恢复修复后 `history-rows` 等三文件 **14 passed**。没有删除或 skip 原失败断言。
- 完整 `ios:build` 重试成功，产物 `.nsh/out/YuriNative.app`；其 source map 已核对包含 primitive List 条目与最新投影读取。首次 600 秒构建超时，不计为通过。
- `dead-code` 已运行并检查；新 fixture 与其它经 NSH CLI 打开的 fixture 同列 unused files，不作为生产入口或 export 引入。
- 已将完整修复包安装到原用户模拟器并启动 `com.yee94.yuri.nsh`；确认仍连接当前 Yuri，项目/会话列表已加载，没有重新配对或发送模型请求。临时验证设备的配对已单独撤销，临时设备已删除；用户设备未清除 App 数据或 Keychain。

## 未通过或未完成

- `history-focus-chat.test.ts` 的生产搜索 headless 场景仍在 `composer` 可见性断言失败；临时恢复旧 List 接线后同样失败，不把它列为本次修复通过。
- `nsh:check` 仍有共享 `packages/ui/src/lib/relay/tunnel-client.ts:65/124` 的 BufferSource 类型错误。
- headless `measure()` 在该倒序场景即使修正身份仍报告 1800pt，不能替代 UIKit 几何。一个未等待阅读几何静止的 AX 取样报告 21.67pt、同期原生测量为 0；未计作通过，后续探针要求取样前后几何静止。
- 重复 UIKit 运行曾因超时中断；一次现场为 7 页 / 210 次测量 / 原生最大位移 0，仍不算完成八页验证。
- 真实 Host 的自动触摸探针未完成三页可靠判定：长正文区域没有可见控件标记，且窗口可能已经载入探针预期的页面，不能仅凭出现某个旧消息 ID 宣称又采用了一页。该次取样不计作生产分页通过。
- 真实 Host 的完整 Activity/Markdown、图片晚到、持指分页、软键盘和逐帧闪跳尚未验收。合成载体不能关闭这些缺口。
