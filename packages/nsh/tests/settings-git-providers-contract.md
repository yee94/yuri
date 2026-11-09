# Git / Provider 设置：当前生产接线与验收边界

本轮核对当前 Web、Host 和 Native 源码，不引用旧审计行号作为结论。

| Web / Host authority | Native 对应行为 |
| --- | --- |
| `ui/src/stores/useGitIdentitiesStore.ts` 在创建前分配 profile ID；`web/server/lib/git/identity-storage.js` 强制 ID、userName、userEmail | 普通 Git 编辑器为草稿分配一次 ID；创建、编辑只发送 metadata 白名单；未知结果按该 ID 和全部已提交字段 GET 核验，不重放写入 |
| `GitIdentityEditorDialog.tsx` 保存颜色、图标；token 清空 sshKey，SSH 清空 host | 普通编辑器与 discovered 编辑器共用现有 palette/icons；提交时采用相同 trim、name fallback、nullable 字段规则 |
| Web Git store 写入后重读 profiles | Native 创建、编辑、删除成功发布 Host identity 范围 revision；父页已挂载且忙于旧 GET 时排队刷新；重新成为顶层也重读 |
| `web/server/lib/opencode/custom-provider.js` 接受客户端 `custom-*` ID 并返回 providerId | Native 提交前固定 ID；ACK 或恢复 GET 采用同一 ID，清空内存 API key，发布 Host + directory 范围 catalog revision；Done 不再创建 |
| `ProvidersPage.tsx` 的全部添加／移除及模型能力信息 | Native 保留原 hiddenModels 合并规则，全部添加不影响其他 Provider；显示 tools、reasoning、image 和 context/output；按当前 catalog 的 toolcall、modality 布尔表读取，不把未知当支持 |
| Host 模型编辑保存配置后返回；随后 catalog 可以暂时仍是旧值 | Native 保留提交快照，直到 catalog 的名称、工具、图像和限制字段吻合；ACK 后读失败／旧值仅 GET 重试，不重发 PUT，也不以旧目录替换提交表单 |

普通 Git、Provider 创建、模型编辑及模型显示偏好的恢复记录只属于当前已挂载页面；沿用 `settingsPageLifetime` 的 operation retirement、同 Host 恢复与 A → B → A 永久失效边界。没有新增持久 journal、凭据日志或跨 Host 重放。Git profile metadata 不包含 token；Provider API key 仅留内存，成功采用或销毁时清空。Provider 已存在只证明 catalog 中的 ID authority，不声称验证 API key、连通性或模型付费调用。

模型 Sheet 使用既有 `NativeSheet`，提交期间同时设置 `closeOnSwipe=false`、`closeOnEscape=false`、`closeOnBackdropPress=false`，`onOpenChange` 和取消按钮回调也检查 busy。系统 UIKit controller、gesture delegate 和 dismiss completion 仍归通用 owner；没有修改通用 Sheet 或 NSH engine。

模型名称按 Host `provider-model-config.js` 的原始字符串 `.length <= 1024` 校验，超长时在分配 pending 前本地拒绝，零 PUT，原稿可直接修正。模型 PUT 只有明确的 `status:400 + code:INVALID_MODEL`，或当前 Host 路由映射及 `runtime.ts` 解码得到的精确 `status:400 + message:"HTTP 400: Unable to save provider model"`，才证明该尝试在写入前被拒绝：清除该次 `pendingModel/modelSaved`，保留编辑稿并允许修正后新提交。这个 catch 仅包围模型 PUT，不处理之后的 catalog GET；其他 400、5xx、网络错误和丢失 ACK 均保留 pending，重试只 GET。现有 Host 路由没有把内部 INVALID_MODEL 作为 code 输出，因此不能仅测试虚构的结构化 code 而漏掉真实 wire，也不能把所有 400 都当作可重写。

纯测试文件 `settings-git-providers-production.test.ts` 用 TypeScript VM 执行真实页面及 `settings-controls.tsx` 生命周期，替换的只有 native／UI ports。测试调用真实事件回调，覆盖稳定 ID、白名单与认证清理、ACK、未知结果、旧读与 revision、顶层恢复、Host A → B → A、批量偏好、catalog 格式及 500 模型上的 50 次筛选零请求。它不启动 NSH、设备、真实 Host 或付费模型请求。测试夹具不等于 UIKit 或真实完整导航验收。

聚焦命令：

```sh
bunx vitest run --config packages/nsh/vitest.config.ts \
  packages/nsh/settings-git-providers-production.test.ts \
  packages/nsh/settings-git-credentials.test.ts \
  packages/nsh/settings-provider-removal.test.ts \
  packages/nsh/settings-protocol.test.ts \
  packages/nsh/sheet-presentation.test.ts
```

主会话串行运行 UIKit 时使用以下真实组件 ID。尚未运行这些设备用例，不能以纯测试通过宣布 1:1 完成。

| 场景 | ID / 操作与预期 |
| --- | --- |
| 普通 Git 新建与编辑 | `settings-git-name`、`settings-git-userName`、`settings-git-userEmail`、`settings-git-auth`、`settings-git-host` / `settings-git-sshKey`、`settings-git-color`、`settings-git-icon`、`settings-git-save`；切换认证时只展示相关字段；保存后回到保留挂载的列表，名称与身份即时更新 |
| 普通 Git 删除 | `settings-git-delete`；系统确认取消不写，确认成功后父列表不再保留该身份；丢 ACK 后保存位置变为 Retry，只读核验删除结果 |
| Provider 创建 | `settings-provider-name`、`settings-provider-url`、`settings-provider-add-model`、`settings-provider-model-id`、`settings-provider-model-save`、`settings-provider-save`；ACK 后父目录刷新；Done 返回且无第二个 POST；未知结果后切后台再恢复仍只 GET |
| 模型保存 Sheet 保护 | `settings-provider-edit-<modelID>`、`settings-model-name`、`settings-provider-model-save`、`settings-provider-model-sheet`；延迟 PUT，分别尝试 grabber 下拖、内容区域拖关、外点、外接键盘 Escape 和取消；提交结束前均不得丢失 Sheet 或表单；完成后关闭恢复可用 |
| 能力与批量操作 | `settings-provider-filter`、`settings-provider-add-all`、`settings-provider-toggle-<modelID>`；catalog 中 tools/reasoning/image、context/output 与 Web 同数据比对；全部添加在有 hidden model 时可用，移除／恢复不改变其他 Provider |
| 顶层恢复与范围 | 二级页返回、设置被其他导航覆盖后恢复、后台恢复、Host A → B → A、带 directory 的工作树设置；旧响应不更改新页面，不重发未知写入，不读取其他项目来猜目录 |

最小独立审查集合：`settings-git.tsx`、`settings-providers.tsx`、`settings-git-credentials.tsx` 的两个 palette/icon 导出、`settings-git-providers-production.test.ts` 和本文。只读对照 `settings-controls.tsx`、`settings-protocol.ts`、`native-sheet.tsx`、`settings-git-credentials-core.ts`、当前 Web editor/ProvidersPage 及 Host identity-storage/custom-provider/provider-catalog/provider-model-config；这些对照文件不属于本轮改动。

`settings-voice-operation-recovery.test.ts` 的 unknown custom Provider case 由 Sessions owner 修改，本文只记录接线合同：模型必填，先点添加模型、填写 ID、保存本地模型，再提交 Provider。含 API key 的 POST 精确字段为 `apiKey/config/directory/providerId`；校验 `providerId` 满足 `custom-*`，捕获它并用于 catalog 与迟到 ACK。若恢复 catalog 包含同一 ID，采用成功且清空 key，后续按钮为 Done；若 catalog 只有不同 ID，则未知状态不解除、key 不清空，Save retry 只 GET。两种情形均必须保留 POST 总数为一及新 scope 的只读恢复断言；不能用删断言或允许第二次创建来通过测试。用 `settings-provider-save` 调用生产回调可避免 label 随 Save→Done 转换造成 fixture 误选。

## settings-outer 的两个拒绝／重试用例合同

当前 `web/server/lib/opencode/routes.js` 的 settings PUT 调用 `persistSettings`，失败统一返回 `500 {error:"Failed to save settings"}`，没有 visibility 409 或确定未写入的拒绝回执。`settings-runtime.js` 的持久化流程包含写盘和后续通知，失败状态不能替代写入结果核验。模型 PUT 的明确 INVALID_MODEL 前置拒绝是上述精确 400；`provider-model-config.js` 没有模型冲突 409 协议。`tests/settings-outer-host.js` 当前的两个 `409 Fixture ... conflict` 是 synthetic 注入，即使 fixture 知道自己没有改值，客户端也不知道，不能据此添加 409 白名单、清 pending 或再次 PUT。

fixture owner 修改自己的 `settings-outer.test.ts` 与 `tests/settings-outer-host.js` 时采用：

1. **显示偏好加减**：把第一次失败移到点击 `settings-provider-toggle-model` 触发的 GET `/api/config/settings` preflight，返回真实 GET 错误 `500 {error:"Failed to read settings"}`。用独立 fixture 阶段隔离，不能让失败落在页面初始读取。首次按钮操作结束后断言原模型仍已添加、hiddenModels 不变且 `visibilityAttempts===0`；UI 错误为 `HTTP 500: Failed to read settings`。第二次明确点击，同一 GET 成功后执行一次真实 PUT，`visibilityAttempts===1`，原模型变为隐藏且 unrelated hiddenModels 保留；返回详情再添加执行第二个独立 PUT，计数为 2。不得把首次失败改成 PUT 500 后仍期待再次 PUT。
2. **模型 Sheet**：首次模型 PUT 返回真实前置拒绝 `400 {error:"Unable to save provider model"}`，不改模型、catalog，计数 `modelAttempts===1`。生产回调将其显示为本地化 `settings.providers.custom.invalidModel`，英语现值为 `Enter a valid model ID and positive whole-number token limits. Output cannot exceed context.`，因此不应再等待 `HTTP 409: Fixture model conflict`。断言 Sheet 与原稿保留、输入恢复可编辑；用户修正草稿或明确再次保存后，才进行第二次模型 PUT。成功响应必须为 `{providerId:"fixture",modelId:"model"}`，catalog 的 name、tools、image 与 context/output 必须采用这次被接受的值；`modelAttempts===2`，随后回到列表并可重开核验。若要以无效输入触发拒绝，不能用名称超 1024 来模拟 Host PUT 拒绝：该情况已经由本地校验拦截，正确计数应是零 PUT。

独立纯生产回调回归覆盖 preflight GET 失败后首次有效 remove/add PUT，以及两个 synthetic 409 均只 GET、绝不第二次 PUT。已有明确 400 拒绝恢复、network/5xx/lost-ACK 保护均保留。上述两个 engine fixture 文件由其 owner 修改；本轮未编辑，未运行引擎或设备。此合同不表示 engine 复验已通过。
