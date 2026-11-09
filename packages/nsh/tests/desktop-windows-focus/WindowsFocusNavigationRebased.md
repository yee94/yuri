# Windows focus — 8a261f52 rebased handoff

## 父链与所有权

- 唯一父基线是只读 `8a261f52b450ac75cc77225f2751bda1dc59097dd1e48ac5677f67d3ad77ff25/source`，其 receipt 的 source tree SHA 为 `2d4a065aff91749447d055f317b28a6a79f14815fd4c8714831617361f56dfbe`。
- 父链顺序：Shift → Diff → List → DevFrame。只在新的 ignored `.nsh/compat-win-focus-rebased-work/copy` 重基，不复用或覆盖旧候选副本。
- 本 worker 未修改原 `windows-focus-navigation.patch`、旧 hash、manifest、preparer、原 compat/source/tools 或其他 worker 代码；新补丁由 main 后续登记。并行 preparer 已登记 ListContract 并产出 `9b0dad8e…`，本候选仍严格以用户指定的 8a 父树为 before，不改用新基线或借用其全绿结果。
- `mount.rs` 的冲突已手工合并：完整保留 List 的 `ReadScrollSnapshot` arm，再接入 Focus/Blur；headless `mod.rs` 的 reply pump 与 `screen.rs` 的 snapshot queue/read 路径保留。
- 收紧原候选的 stop/destroy 清理：engine 重启只释放 owner 和焦点状态，保留系统消息给出的 inactive 标记；surface 销毁才移除该条目。新增对应 Windows 源码测试，不能把这项未执行的 native 测试称作物理验证。
- List-contract-fix 的 `crates/nsh-core/src/js/host.rs`、`crates/nsh-core/src/js/mod.rs`、`crates/nsh-core/unitless.txt` 与本补丁无重叠，且已核对其 before SHA 等于该父树文件。未代替唯一 preparer 应用或登记此追加补丁。
- 所有新补丁文件的 beforeExists/beforeSha256 都针对 **8a 父树**，不是旧 e626 的同名文件。新补丁使用 preparer 支持的严格 unified 格式；验证要求坐标、创建声明与所有 after SHA 精确一致，不以 fuzzy apply 代替。

## 本轮实际验证

完整命令、退出码、每份日志 SHA、二进制 SHA 以及通过/失败数见 `packages/nsh/patches/nsh-0.4.0/windows-focus-navigation-rebased.verification.json`。完整文件清单见同目录 `windows-focus-navigation-rebased.hashes.json`。

1. 父 digest 配套 CLI 的最小 Windows headless 红测重新执行：Tab/Enter 后仍为 `calls:0`（期望 `calls:1`），354ms / 总计 397ms。没有把旧 7834 的红测移作本次证据。
2. 新副本编译并执行新增两项 Rust headless 测试，首次运行 2/2 通过；声明 feature 最终重跑 headless lib 为 **49 通过**，JS declarations **17 通过**、List headless **2 通过**。base focus 关闭默认 feature 的磁盘恢复重试 2 通过；随后默认 feature 独立重跑也为 **2 通过**，不将两者混写。
3. consumer 由副本自身编译的 CLI 执行；不是直接运行从 cache clone 得来的旧 binary。所有 consumer 未指定 native target，均为 headless。无真实 Host、用户 App 或用户连接。
4. Rust 构建与测试保持 `--offline --locked`，没有下载、安装依赖。独立 target 由已有 cache 的 APFS CoW 副本暖启动，不是 hardlink，也未向原 target/tools 写入。
5. 源码按用户明确授权串行测试。headless lib 排除会创建 loopback 网络的 `net_fetch_tests`，不启动真实 macOS 窗口、不绕过 foreground/锁屏 gate。

headless lib 的首轮 `--features bundle` 真实报出 `every_export_is_documented` 失败（所有文档 metadata 为空）。原因是未打开已有的 `nsh-core/declarations`；CLI 本身启用该 feature。保留首轮红灯，再用 `--features bundle,nsh-core/declarations` 重跑原断言，不改源码或跳过这个测试。

CLI 首次以测试目录为参数时，因目录自身没有 `App.tsx` 在 entry 解析处失败（1），并未执行任何 consumer。最终测试使用独立 consumer 目录，新增导入 `./Focus` 的入口以及最小配置。冻结的原 fixture 有两处 API 写法错误：`If condition` 和 View 顶层 `pointerEvents`，首次 consumer 类型检查失败、headless 为 1 通过/7 构建失败。保留原文件和红灯，在 `rebased/` 新建 Contracts 副本，仅改为 `If when` 与 `style.pointerEvents`，测试文件逐字相同。再次类型检查通过，**8 项 consumer 全部通过**（6.0s）；测试断言未改。main 应分别传原 `Focus.test.tsx` 与新 `rebased/Contracts.test.tsx` 路径，由包根现有 App 解析，不能重用冻结旧 Contracts。

首轮后续构建发生 `No space left on device`，未能持久化 base focus 的退出码，也未执行后续 consumer；该中断日志保留，状态为 unknown/aborted，不伪造 101 或通过。首次 `cargo clean` 又因缺少 `CACHEDIR.TAG` 被安全保护拒绝（101），并未开始回归。确认没有本线程残留进程后，通过本线程创建记录、精确路径、非 symlink/inode 与目录内容校验，只移除新建副本的 target，改用 `debug=0`、`incremental=0`、两编译任务重试；不删其他 worker cache。最终 base focus 仍按默认 feature 验证，不因磁盘问题降低断言。

13 个修改源码的 rustfmt/check 均通过。按根脚本同参数使用已缓存 knip（`bun x --no-install knip@5.80.0`）尝试 dead-code，加载现有 Web 配置时因缺少 `vite-plugin-pwa` 失败；未安装依赖，未获得完整报告，不将其记为通过。

## 红灯与未验边界

- **core 父链已知红灯保留**：本次实际为 **989 通过、2 失败、9 ignored**。8a 源码尚不含 List-contract-fix；失败恰为 `js::tests::every_event_is_typed_or_internal` 和 `geometry::unit_types::public_api_is_typed`。没有为让回归全绿修改这三个 core 文件或降低断言，也不拿不同 feature graph 的历史计数混写。
- **Windows native 未签收**：本机没有 Windows target/SDK/link 环境，离线 `gl_generator` 缺失也不能擅自补齐。Windows crate 在 Darwin 为空，不把 Darwin metadata/零用例输出称为 Win32 编译、UIA、IME 或物理键盘验证。
- **tabIndex 缺口仍在**：只实现并验证既有 `focusable`、Button、pressable View、Tab/Shift+Tab、Enter/Space 合同。没有新增 tabIndex API，不声称完整复刻 Web 焦点排序。
- 原 designer 的 fixture/test、Windows skip 与所有真实 PC 像素验收仍由 main/designer 所有，本 worker 未修改。锁屏状态下没有继续做 UI 设计、抓取真实窗口或 fake-active。

## 集成要求

main 应先核对新 hashfile 的共享文件 before 链，再以唯一 preparer 登记新补丁、生成新 digest 与对应 CLI/runtime。若 List-contract-fix 先追加，因文件集合无重叠，Win 补丁三个共享文件的 before SHA 仍应保持同值；实际登记前仍需重新核验。新工具出来后再由 main 串行复跑对应 headless 与 Windows native 场景。原候选及其“未测试”交接记录只作为历史，不覆盖本次真实回归结果。
