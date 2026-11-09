# Native contact pointer fixture

当前真实验证已覆盖9b16cd9a固定/working Row、abe3d73a实际AssistantHome/List的responder通路，以及7f4fc51e完整应用普通Bot的即时rail截图。完整Bots尚未签收，实际点击、无Host写入、刷新关闭与AX custom actions仍在验证；旧AX/延迟截图的观察窗口限制见[验收记录与合同](./ACCEPTANCE.md)。以下构建与复验步骤保留为诊断方法，不表示需要再次构建。

`fixture.tsx` 挂载真实生产 `AssistantSwipeRow` 与真实 SDK，不连接 Host、不发请求、不写业务数据。只把固定事件名写入64项有界界面 trace。此 fixture 供主会话独占 UIKit 窗口验证；builder 会运行本 fixture 专用 headless 启动检查，不操作设备。

1. 用实际 `assistant-row-pointer-a` / `assistant-open-pointer-a` frame 内触摸，短按应记录 open；长按应显示系统 ActionSheet 且记录 menu，松手不应记录 open，取消记录 cancel。
2. 开启 pinned 后重复长按；普通模式左滑显示原 edit/delete，垂直拖动交给 Scroll，scroll-end marker 可到达。edit/delete 仅记固定事件，不进行业务写入。
3. 用公开 AX menu/activate 动作验证可达性。触摸期间 rebind/禁用及 AX 接管后原手势终止不能恢复旧动作；连续当前 AX 动作应可用。
4. 只记录固定事件名，不增加生产日志。该 fixture 不签收真实 Host、联系人正文、caption、完整应用布局或真实 UIKit 测试结果。

生产截图红证据为 `.scratch/nsh/uikit-1b8e19f0-bot-longpress/{before,after}.json`：原长按松手进入 ContactChat。本地 SDK `button.rs:40–46、71–73` 表明 Button 只有 Press/Down/Up；`press.rs:325–350` 的 handled_deeper 拒绝更深 pressable 上方的外层识别器；同文件119–125行只为当前识别器的 LongPress 注册回调，268–272行仅在该识别器已 long_pressed 时抑制 release Press。修复让原生 View 同时拥有 Press/LongPress，不向不支持该事件的 Button 塞属性，也不再依赖外层长按。

`assistants-cell-reuse.test.ts` 的 mounted target 用例在 Node/VM 中检查真实生产挂载层级与该 SDK 边界规则；不是 UIKit 识别器执行证据。编译成功也不代表长按已验收。主会话仍须用新完整应用包按实际 row frame 重复长按，再采 AX/截图确认 ActionSheet。

## 独立 UIKit app（只构建）

```sh
NSH_BIN=/path/to/nsh/bin/nsh node packages/nsh/tests/assistants-pointer/build.mjs
```

复用 `stageNativeApplication` 冻结生产依赖图、主题与资源，按 history/resource fixture 模式使用正式 SDK 编译、swiftc 链接与签名。默认产出唯一目录、唯一 bundleID 的 arm64 **模拟器** `.app`；不是实机签名包。`--stage-only` 仅冻结与类型检查，`--bundle-only` 再编译字节码及运行 headless 启动检查。无设备操作、Host bridge、网络 capability 或 Keychain。测试控制上的英文是 fixture 协议标签，不进入产品字典。

原 `0e74504e` shell 错把 `app/nsh/` 目录交给 `loadBundle`；SDK 的 `nsh_app_load_bundle` 要求 bundle 文件。本版与 history/resource shell 一样解析 `Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh")`，传入 `app/nsh/bundle.nshc`，并在构建与原生加载前验证文件存在。`startup.steps.js` 在真实 headless engine 验证固定 row 挂载、Working 刷新导致 binding 退休及恢复 Fixed；它不执行 Swift loadBundle，不替代 UIKit 重新启动验证。

独立 shell 的 onError 保留 SDK 原始消息（SDK 提供 JS stack 时一并保留），Swift catch 保留真实错误描述及 phase/origin。最多4项、每条message最多4096字符；只在本 synthetic、无Host/凭据 fixture 内启用。显示在单一 `pointer-native-error` label，并原子保存到 app sandbox `Documents/pointer-startup-errors.txt`。主会话可用 `xcrun simctl get_app_container "$SIM_UDID" <本次bundleID> data` 得到目录，再读该相对路径；新bundleID不沿用旧错误文件。出现该label即启动失败，不把错误捕获当成功。phase区分 resolve-bundle、grant-empty-capabilities、load-bundle、bundle-loaded，origin区分engine-onError与swift-catch。

`instrument.mjs` 只修改 frozen stage 的 `assistants-swipe.tsx`，生产文件不插桩；锚点变化或重复会拒绝构建。manifest 保存原与插桩 SHA256、SDK 二进制/interface、bundle、可执行文件哈希。`trace.ts` 只接受固定枚举，不记录坐标、正文、身份、凭据；读取旧 trace 与写入均 `untracked`。trace 显示在 row 后的固定320pt区域，记录增长不改变 row 位置。枚举中的 offset-zero/partial/open 分别表示0、(-128,0)、-128，不含任意数值。Reset 只清 trace，不重置 row/rail/模式。

## 主会话独占设备复验

1. 从本次 `fixture-build.json` 取 `.app` 与 bundleID，主会话自行 install/launch；先确认 AX 根为 `Assistant Pointer UIKit QA` 且无 `pointer-native-error`。
2. 默认 `pointer-mode=fixed-binding`，Bot 非 working，没有刷新 timer。Reset 后按**当前 AX** 的 `assistant-row-pointer-a` / `assistant-open-pointer-a` frame 左滑80%→25%，同一WS发begin、8move、end，约144ms；不要复用生产包坐标或旧 helper 的 `History Production QA` 根断言。采 before、每帧host发送时间、early AX、截图及 `pointer-trace` 的完整 AXLabel。
3. 正常通路预期有 `start → claim-yes → grant → reveal → block-yes → move → offset-* → release`，具体 move/claim 次数由 SDK 合并决定。release 后 offset-open 且截图显示 edit/delete 才算此 fixture 侧滑通过。无 start 定位到命中/SDK raw touch 路径；有 start 无 claim-yes 查 claim；有 grant 后 offset-zero 看 close/retire/terminate 原因。不要用发包完成、Node测试或编译通过代替真实判定。
4. 点击 Working，模式显示 `working-2500ms`，每2500ms记录 refresh 并替换同ID的 binding（模拟生产 snapshot 新 wrapper，generation不变）。Reset 后重复快速左滑并立即采证；另做一次横向claim后保持触摸跨过刷新、再move/end，预期 refresh/retire-binding/offset-zero，旧触摸不恢复动作。快拖若成功后被下一次刷新关闭，须将即时 rail 与后续关闭分别记录。Fixed 会取消 timer，方便同坐标对照；生产刷新完全未改。
5. 两种模式均保留短按、长按系统 ActionSheet、pinned、disabled、手动 Rebind、公开 AX menu/activate。重新验证 single-View 长按、纵向 Scroll 和 late callback fence。edit/delete只记固定事件，无写入。

这是生产 **row + Scroll** 的诊断夹具，不包含生产 List cell 回收、目录轮询调度或真实 Host；working 模式只模拟同ID snapshot binding替换。fixture 通过后仍须回完整 UIKit 包确认侧滑，不能据此签收完整应用。
