# AppKit 菜单 Shift accelerator：NSH 0.4 兼容修复与验收边界

`AppKitMenuAccelerators.test.tsx` 必须使用 NSH 0.4.0 的 `--target macos`；不能以 headless 或菜单点击代替物理键断言。

## 原发行版已复现

- `mod+p` 由 keymap 消费一次；撤下 fallback、发布菜单 ownership 后由 native menu 消费一次。
- 未发布菜单 ownership 时，`mod+shift+k` 正常进入共享 keymap，来源为 `keyboard`。
- 经过改键、取消分配及恢复后，`mod+p` 仍能进入当代 native menu callback，来源为 `menu`。
- 将同一动作交给 native menu 的 `cmd+shift+k` 后，物理键不触发；原正向断言保持失败，未降标。

## 最小证据

独立原生 NSH fixture 仅使用 `Menu.setApplicationMenu`、`keymap.bind` 和计数器，不导入 Yuri：未带 Shift 的菜单可在多次 replacement 后触发，Shift keymap 控制也能触发，但 Shift 菜单同样失败。

独立 Swift/AppKit `NSMenu.performKeyEquivalent(with:)` 实验以相同 keyCode 40、Command+Shift flags、字符 `K` 构造事件：菜单 equivalent 为 `k` 时不匹配，为 `K` 时匹配且触发一次。NSH 0.4 实现的对应链路为：

- `crates/nsh-platform-macos/src/synth.rs` 的 `key` 在 Shift 下正确生成 shifted 字符，再通过 `NSApplication.sendEvent` 发送 Command 事件。
- `crates/nsh-platform-macos/src/chrome.rs` 的 `key_equivalent` 对 `Key::Char(c)` 直接使用 `c.to_string()`，未转换 Shift 字符；`menu` 将其交给 `NSMenuItem`。
- `crates/nsh-core/src/desktop.rs` 的 `Shortcut::parse` 统一转小写；公开 shortcut 传 `K` 也不能表达 AppKit 所需的 equivalent。

因此不是 Yuri callback 换代或 modifier 丢失。应由 NSH AppKit backend 修正 key equivalent；不能在产品安装第二个相同物理键 owner，也不应改写测试驱动发送非真实的小写 Shift 字符。

## 保持的接口与边界

`installNativeDesktopMenu`、`ownedKeystrokes`、`installNativeDesktopShortcuts` 和 routing API 无改动；application 与 NSH 上游无改动。菜单只声明实际登记的 canonical 物理键，keymap 排除这些键；编辑快捷键、IME 与 capture 准入保持原实现。此证据不代表 Windows 或完整桌面视觉已验收。

## 此前基线验证

- Focused Vitest：`desktop-core`、`desktop-shortcuts`、`desktop-shortcuts-routing`、`desktop-shortcuts-routing-native`、`desktop-keyboard-native`，5 文件 41 项通过。其中真实 headless engine 回归覆盖两平台各 50 次输入零 plan rebuild、action scan 和 storage write；它们不是 AppKit 替代证据。
- 真实 AppKit：新增的 Shift keymap/菜单 callback 换代控制通过；独立取消分配、聚焦输入的编辑改键及 Settings gate 通过。原 Shift 菜单正向用例仍失败（2 通过、1 失败）。
- 真实 AppKit `Keyboard.macos.test.tsx`：Shift/Alt+Return 仅编辑、不发送，通过。

## 项目内兼容 preparation

后续已增加 [版本锚定的项目补丁](../../patches/nsh-0.4.0/README.md)，在忽略目录的源码副本修正 AppKit Shift 字母 equivalent，统一构建并校验 CLI、物理 devhost 与 Yuri Host；不修改外部 checkout。原正向物理键断言仍保留，不能以补丁应用成功冒充测试转绿。

新增独立 `AppKitMenuCapture.test.tsx` 验证 capture 时撤下所有应用 accelerator、Shift 改键只被捕获一次、关闭设置后恢复唯一 menu owner。使用原发行版的控制回归通过，**不构成 patched runtime 的验收**。

此前曾因离线 Cargo 缓存缺 `oxc`（`nsh-bundler` 依赖）而无法生成 patched CLI/devhost。后续主线按原 lockfile 补齐缓存并交付同链工具；该历史失败不再用于描述新产物的当前状态。不得用旧 CLI、旧 runtime、headless 或菜单点击替代新产物的验收。

## 同链 AppKit 物理专项：86fb08a597f2

本次先验 digest 为 `86fb08a597f2a5b0389f61cac1831a0f3bd55f46a54f35e006ab26269ff1cfe7`，同时含 Shift 与 Diff patch。CLI 和 devhost 均来自该 digest 的 `tools-darwin-arm64`，每条命令同时显式设置 `NSH_BIN` 与 `NSH_RUNTIME`，并固定 `--target macos`。

磁盘内容必须匹配 tools receipt，且在专项结束后再次核验：

| 文件（相对 `tools-darwin-arm64`） | SHA-256 |
| --- | --- |
| `bin/nsh` | `ecceaeedd13ce584aff7a2ad5e8338b4580f0418d049efe95bbcbaa7236ffc6f` |
| `runtime/macos/nsh-macos-host` | `728a7fa8190ac26d617ea498ccaea7ec1b3f37f9e86a1b883accb93dc94af014` |

测试只打开独立 synthetic fixture，不加载 Yuri application、不接触用户凭据/Host、不操作既有 synthetic_smoke 窗口，也不改变系统 foreground gate。结果与后续新 digest 的最终复验分别记录，不能自动继承。

### 物理结果：5/5 通过

| 专项 | 结果 | 耗时 |
| --- | --- | --- |
| Shift 物理键由 keymap 消费、菜单 replacement 后 callback 仍有效 | 通过 | 12.3s |
| 取消分配、聚焦输入的编辑改键、Settings gate | 通过 | 20.4s |
| 默认 Cmd+P 优先级 → native menu ownership → Cmd+Shift+K 菜单改键 → 恢复/取消分配 | 通过 | 24.3s |
| Capture 撤下 accelerator、捕获 Shift 改键、恢复单一菜单 owner | 通过 | 8.9s |
| 普通 Return 提交一次；Shift/Alt+Return 只编辑原 Input、不额外提交 | 通过 | 5.4s |

菜单文件合计 3/3（57.0s），capture 1/1（9.0s），Return 1/1（5.4s）。Cmd+Shift+K 仍使用 `app.keyboard.press('mod+shift+k')`，并断言 `calls:3` 与 `source:menu`；没有菜单点击或 headless 替代。运行后两个 binary hash 与表中及 receipt 完全一致。

从仓库根复跑，必须同时传入两个环境变量：

```sh
export COMPAT="$PWD/packages/nsh/.nsh/compat/86fb08a597f2a5b0389f61cac1831a0f3bd55f46a54f35e006ab26269ff1cfe7"
export NSH_BIN="$COMPAT/tools-darwin-arm64/bin/nsh"
export NSH_RUNTIME="$COMPAT/tools-darwin-arm64/runtime"
cd packages/nsh
"$NSH_BIN" test tests/desktop-workspace/AppKitMenuAccelerators.test.tsx --target macos
"$NSH_BIN" test tests/desktop-workspace/AppKitMenuCapture.test.tsx --target macos
"$NSH_BIN" test tests/desktop-workspace/Keyboard.macos.test.tsx --target macos
```

### 配对旧发行版反例

同一 fixture、同一测试、同一 macOS 目标，显式配对旧 CLI 与旧 runtime 后：菜单文件 2 通过、1 失败（43.6s）。原正向在 `calls:3` 超时，屏幕保持 `calls:2`，已声明 `owned:["cmd+,","cmd+shift+k"]`，来源仍为前一次 `menu`。这是预期反例，不计入新产物失败，也没有删除该断言。

| 旧发行版文件 | SHA-256 |
| --- | --- |
| `bin/nsh` | `cc9676f7d8f763e6903e1b4b1d8f4f21376689e16381a6fe77e68861da106416` |
| `runtime/macos/nsh-macos-host` | `db5a5d62dc9e97788cbb2ec5b8a59ceeb141f911af7564ff523a11fd4500ca01` |

原始日志与前后 hash ledger 保存在会话临时目录的 `appkit-physical-86fb08a597f2-report.json` 及同前缀日志，使用专属 `yuri-native-smoke:appkit-menu-debug` 串行执行。

此 digest 仍是 preparation cache 修正前的先验，不替代后续同链新 digest 的最终复验。Windows、Option/标点/非 US 物理布局、完整 IME 与主 application 仍不在本专项验收内。

## Cache 修正后的同链专项：7834beffee6d

新 digest 为 `7834beffee6dc6dd588bee99f717366a37dca2282ceb53544b80734e800f97e0`。本轮重新执行同一组三个测试文件、五个物理场景；不继承前一 digest 的通过结果，也不修改 consumer 或 preparation。目标保持 `--target macos`，CLI/runtime 同时显式指向新 digest 的 `tools-darwin-arm64`。

| 文件（相对 `tools-darwin-arm64`） | SHA-256 |
| --- | --- |
| `bin/nsh` | `5fcc770349635e237df43fdfa072426af0375084dc006374bf2c376f06a81d5b` |
| `runtime/macos/nsh-macos-host` | `0ac82f67e63258d4438231b5baabee9f9226704c611c6a3b05594722de4a3197` |

旧发行版红反例及 `86fb…` 的原始证据保留。本轮的 binary 前后 hash、测试文件摘要与结果独立写入 `appkit-physical-7834beffee6d-report.json` 及同前缀日志；仍由专属 `yuri-native-smoke:appkit-menu-debug` 串行执行，不操作既有窗口或系统 foreground gate。

### 新工具复验结果：5/5 通过

| 专项 | 结果 | 耗时 |
| --- | --- | --- |
| Shift 物理键进入 keymap、replacement 保留 callback | 通过 | 11.9s |
| Unassign、聚焦输入编辑快捷键与 Settings gate | 通过 | 20.3s |
| 默认键/menu priority、物理 Cmd+Shift+K 菜单 remap、撤销及恢复 | 通过 | 24.4s |
| Capture 与单一菜单 owner 恢复 | 通过 | 8.9s |
| 普通 Return 提交一次，Shift/Alt+Return 只编辑、不额外发送 | 通过 | 5.4s |

菜单文件为 3/3（56.6s），capture 为 1/1（8.9s），Return 为 1/1（5.5s）；三个进程均 exit 0。运行后重新从磁盘计算 CLI/devhost SHA-256，与本节运行前表格及 receipt 均相同。所有场景确实使用 `7834…` 工具，不以 `86fb…` 的结果背书。本轮不重复运行已保留的旧发行版红反例。

| 测试文件 | SHA-256 |
| --- | --- |
| `AppKitMenuAccelerators.test.tsx` | `781255f9cc061396a7af424b13b1e40c63675e8521fbd0d15b753a1ec8a4fd5b` |
| `AppKitMenuCapture.test.tsx` | `cac07ea5da465e26f6ce166c8465b07693345b3f011e4a5cc4110a81589e41af` |
| `Keyboard.macos.test.tsx` | `675f87f18af5ace9e94b76cefd0d89a6e2060397cfa3b3f58ddd43a8e96477fd` |

本轮仅验收到此 digest；如后续加入 shortList snapshot 等补丁并更换 digest，仍须重新核对工具 hash 并执行同组物理专项，不能继承本节结果。Windows、完整 IME/非 US 布局及主 application 的边界不变。
