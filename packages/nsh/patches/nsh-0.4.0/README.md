# NSH 0.4.0 项目内兼容补丁

唯一 owner 为 `scripts/nsh-compat.mjs`。不修改外部 checkout，不增加依赖，不调用系统 `patch`，不在 TS/keymap 安装重复 accelerator。

## 基线与 manifest

- revision：`e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3`。
- `source.roots` 固定参与编译的源码范围，`source.sha256` 是按路径字典序排列的 `{path,sha256}` 数组的紧凑 JSON SHA-256。当前基线覆盖 1,740 文件，应用 Shift→Diff 后为 1,741 文件，再应用 List 后为 1,745 文件，不只检查版本或被修改文件。旧 1,739 基线遗漏了合法源码 `crates/nsh-core/src/image/cache/tests.rs`；修正后的完整基线 SHA-256 为 `5764bf7d27dd530634a007ec2ca2df8d37b63903584f9b47401a1238e875b4d1`。
- `source.files` 另单列关键文件 hash，必须包括 `Cargo.lock`；完整清单保存在准备产物的 `receipt.json`。基线源码及 lock 必须完全相同。
- `patches` 按数组顺序执行，每项为 `{file,sha256,files:[{path,beforeSha256,afterSha256,beforeExists?}]}`。新增补丁由 preparation owner 审核并追加；同文件的下一项 before hash 必须等于前一项 after hash。不能重复登记同一 patch。
- 既有文件只接受 `--- a/path` / `+++ b/path` 和带精确坐标的 unified hunks。新增文件必须精确声明 `beforeExists:false`、before hash 为 SHA-256(empty)，原始源码及此前 patch 输出均不存在该路径，且位于已审计 source root 内；只接受 `--- /dev/null` / `+++ b/path` 和唯一 `@@ -0,0 +1,N @@` 全新增行 hunk，完成后验证完整 after hash。不能覆盖现有空文件、目录或符号链接。新增文件同样进入最终树、receipt 和缓存复验。
- 不接受 `diff --git`/`index` 前导、重命名、删除文件、二进制、CRLF 或无末尾换行形式。零 fuzz、零偏移搜索，所有 context 必须逐行匹配。路径不得逃逸、使用符号链接或包含缓存目录。

准备时将选定源码复制到忽略的 `.nsh/compat/<digest>/source`，无 hardlink；保留 `.git`、`target`、`node_modules`、`.nsh`、`.cache`、`dist` 路径段的既有排除及 patch 路径禁入规则。`cache` 不再按 basename 全局排除，只排 checkout 根 `cache/` 与 `.cargo/cache/`、`.cargo/registry/`、`.cargo/git/` 这些已知缓存位置；合法源码 `src/image/cache/` 与相邻 `cache.rs` 均参与哈希、复制、receipt 和缓存复验。digest 同时覆盖 manifest 和 preparer 实现。独占锁 fail-fast，不抢锁、不轮询；过期锁须先确认没有 owner 后人工处理。完整 staging 验证后才 rename 发布。缓存复用时重新验证 source 和全部 hash，失败不删除旧产物或改写外部源码。

## 唯一构建路径

```sh
export NSH_SOURCE_DIR=/path/to/audited/nsh
node packages/nsh/scripts/nsh.mjs check packages/nsh
node packages/nsh/scripts/build-desktop.mjs --check-host
node packages/nsh/scripts/build-desktop.mjs --test-host
node packages/nsh/scripts/build-desktop.mjs --debug
```

所有命令先验证同一 preparation。CLI `nsh-cli` 与本平台 `nsh-macos-host` / `nsh-windows-host` 由同一复制源码、同一锁文件，以 `cargo --offline --locked` 构建；不从旧发行目录补找 runtime。返回并显式传入配套 `NSH_BIN`、`NSH_RUNTIME`，发布前及缓存命中时核验两个可执行文件 SHA-256。旧 `NSH_BIN` 不是兼容产物的证明。

preparer 不自动联网或安装工具链。用户明确授权时，可在新 prepared 源码目录独立运行 `CARGO_NET_OFFLINE=false RUSTUP_AUTO_INSTALL=0 cargo fetch --locked --target aarch64-apple-darwin` 预热已有 lock 的缓存；执行前后必须核验完整 source tree 及 `Cargo.lock` hash 不变，不能借此重解 lock 或改 manifest。随后仍走原 offline/locked 构建。若显式使用已安装编译器而非 rustup shim，须同时记录真实 cargo/rustc 版本、路径及覆盖参数，不把这类本机证据写进仓库 manifest。

Yuri Host 用同一复制源码的八个 embedding crate path patch，Cargo manifest/lock 副本在独立 staging，Rust 源及 include 仍指向原 owner。仓库 Cargo.toml/Cargo.lock 不写本机路径、不被 Cargo 改写。失败不自动重解 lock、不联网获取缓存。check/test/build 均不回退 crates.io 的未打补丁 NSH。

产品 bundle 在独立 staging 编译，再与 compatibility digest、每个输出文件 hash 一起发布。`--skip-bundle` 仅接受同 digest 且内容完整匹配的既有 bundle；它不保证产品源码在上次 bundle 后没有变化。最终 App 也在独立 staging 装配/签名，保存 Host/CLI/runtime/bundle hash receipt，发布失败恢复旧 App。没有新增 release/更新服务。

最终 rename 成功后即视为发布 committed；如果旧备份清理失败，只报告 cleanup pending 并保留备份，不把已成功发布误报为构建失败。

## Shift 补丁边界

`appkit-shift.patch` 只在 AppKit `key_equivalent` 中把带 Shift 的 ASCII 字母转为大写，附同源 Rust 回归。Shortcut canonical 字符串、菜单 ownership、Windows 后端不变。不能把这项字母修正称为标点、Option、非 US 布局或完整 IME 验收。

物理验收必须使用此处构建并校验的 CLI 和 runtime：`tests/desktop-workspace/AppKitMenuAccelerators.test.tsx --target macos`；旧发行版、headless 和菜单点击均不能代替它。补丁应用成功不等于编译成功，编译成功也不等于真实 OS 用例通过；离线缓存缺失时必须报告具体 package，不能宣称已生效。

## Diff parent viewport 补丁

第二项 `diff-parent-viewport.patch` 保留 Shift patch 顺序，覆盖 16 个文件（含新建 Rust `parent_tests.rs`）。补丁交付时仅去除 16 行 `diff --git` 前导；所有 before/after 内容 hash 不变，实际登记 patch SHA-256 为 `202591f994247fc2eb5ab5c560a0c31a2ccaa3998ea8ce1d9aa0e9c1f480e258`。它提供原生父滚动视口和 Diff consumer 所需 API；这不表示 Yuri consumer、平台构建或物理交互已经验证。

历史 digest `86fb08a597f2a5b0389f61cac1831a0f3bd55f46a54f35e006ab26269ff1cfe7` 使用旧排除规则，core lib 测试缺 module，虽可构建 CLI/runtime，但不是当前完整基线的证明。此次修正重新审核基线指纹并发布新 digest，未向旧 source 填文件、改 receipt 或挪用旧 binary。

## 第三项 List scroll snapshot 补丁

`list-scroll-snapshot.patch` 按 Shift→Diff→List 登记，SHA-256 为 `a68c39e74ab98f2685b12464086796f644bceea5281a62180295feff5270e674`，21 个文件、4 个精确新建。未修改交付 patch 格式、实现或文件内容。四个新文件为：

- `crates/nsh-core/src/core/scroll_snapshot.rs`
- `crates/nsh-core/src/core/tests/list_scroll_snapshot.rs`
- `crates/nsh-testing/tests/testing/list-scroll-snapshot/App.test.tsx`
- `crates/nsh-testing/tests/testing/list-scroll-snapshot/App.tsx`

冻结契约是 `ListRef.getScrollSnapshot(): Promise<ScrollEvent | null>`：读取平台真实 scroll owner，不使用 core pending replay，不触发 `onScroll`、分页、手势预算、timer 或新的 scroll writer。iOS/Android/Web 等不支持路径显式为 null；消费方仍须复验 exact ref/owner/operation/layout generation。完整契约归 [CONTACT-READ](../../tests/desktop-application/CONTACT-READ.md#hash-chain-and-focused-evidence)，此处不把底层 API 验证等同生产短内容已读或物理交互验收。

登记前重新核验 `7834beffee6dc6dd588bee99f717366a37dca2282ceb53544b80734e800f97e0` 的全部 1,741 文件及 receipt SHA-256 `6abd0dfdf8cf36ba99e10def61a44096abc2afdf03c50cbcfbdb3b7cdfe8bf43`。21 项 beforeExists/before/after 与 worker ledger 逐项完全相同，严格重放后最终树为 `ae3d1110ae6413af1d3b8cc584cbb1cb720289f9e95773cd726a23d06a8c7e7e`，Cargo.lock 不变，合法 image/cache 源码保留；preparer 未放宽规则。

新 preparation digest：`f7dedc80f52dec12c4055a93b6c9cbdc437d038727f5120817e33db9a6eb0a1d`。严格 preparation 75 项和测试文件自身类型检查通过，涵盖第三项乱序/旧 before hash、四文件隐式新建/非空 before/错误 after/重复/未声明目标拒绝，以及失败保留既有 source/App。统一 CLI/runtime、声明生成与 Rust 验收由该 digest 的后续证据记录，不借用 worker scratch 或历史工具。

该 SHA 的登记不等于验收通过：paired CLI/macOS runtime 已以原锁 offline/locked 构建，CLI 生成 `.nsh/types`，独立精确 `Promise<ScrollEvent | null>` / 仅 ListRef probe 和当次整个包 tsc 均通过。但完整 core lib 为 1,017 通过、2 失败、10 ignored；base 930 通过、4 ignored。两项阻塞为：

- `js::tests::every_event_is_typed_or_internal`：新增 `onScrollSnapshot` 未进入 `src/js/host.rs` 的 `EVENTS` 或 `INTERNAL_EVENTS` 契约。
- `geometry::unit_types::public_api_is_typed`：新增 public `core::scroll_snapshot::ScrollSnapshot.zoom_scale` 为裸 `f32`，未提供符合 owning typed-API 规范的类型或无量纲登记。

preparation owner 未编辑 List 实现、放宽 guard 或向既有 digest 补文件；须由补丁 owner 修订后重新提供 patch SHA/before/after，另建新 digest。当前工具是编译成功的待验产物，不是全绿正式验收。原始失败日志为该 digest 的 `rust-lib.log` 与 `build-and-validation-evidence.json`。独立补跑已通过：AppKit lib 80、List core focused 6、headless focused 2（包含 5 个 macOS/Windows/iOS 场景和像素比边界）、JS declarations 17；逐命令日志/hash 见 `supplemental-validation-evidence.json`，不能掩盖上述两项完整 core 失败。所有步骤前后完整源码树和 Cargo.lock 均未改变，paired tools 的缓存 hash 复验通过。

后续 Windows 补丁必须以此第三项的实际产物为 before：例如 `nsh-testing/src/headless/mod.rs` 已从 `c56b812f…` 变为 `7555333c…`，不能沿用 Shift/Diff-only before hash。第四项仅按明确授权登记下述 DevFrame，未登记 Windows focus。

## 第四项 DevFrame：仅限真实 PC 截图诊断

按 Shift→Diff→List→DevFrame 登记 `dev-bundle-frame-limit.patch`，SHA-256 为 `86eee6d37cd33a8c74a469a25e72b4a1114b2502f5867b20c1c0c1d3655946af`。仅修改 `crates/nsh-dev/src/client.rs` 和 `crates/nsh-dev/tests/roundtrip.rs`，无新增文件、无前三项重叠。已核对冻结 ledger、f7ded 完整树与原 manifest 指纹，并用未放宽的 strict applier 精确重放两个 before/after；最终 1,745 文件完整树为 `2d4a065aff91749447d055f317b28a6a79f14815fd4c8714831617361f56dfbe`，原 Cargo.lock 不变。

客户端仅显式设置有限 `max_frame_size(Some(64 << 20))`，保留默认有限 message 上限及 3 次 redirect，不改 bundle 编译模式、业务网络、Relay 或鉴权。用途是同 PC 可信开发服务器约 20.4 MB bundle 的真实 native 截图诊断；不是扩大生产网络信任边界，也不代表真实 App 已成功截图或像素对比已完成。候选的真实 WS 红绿/边界/恢复证据归 [DevBundleFrameLimit](../../tests/desktop-pixel-parity/DevBundleFrameLimit.md)；其 scratch 裁剪 lock 不是此处正式构建的锁，此处仍使用原完整 workspace lock offline/locked。

新 digest：`8a261f52b450ac75cc77225f2751bda1dc59097dd1e48ac5677f67d3ad77ff25`。严格 preparation 76 项及测试文件类型检查通过。paired CLI/macOS runtime 已用原完整锁 offline/locked 成功构建，前后完整 source/lock 不变：CLI SHA-256 为 `3e8819b606a7f44150c5f3bcb34a36e6c23871c76eb362b8a5ffdfab94f14866`，runtime SHA-256 为 `d21e6a12eb20410ab68865a24393841ebdccd2f2ec9ec63cf3986d5c6e08ba35`。已优先交付 main 进行真实开发截图；证据为 `diagnostic-tools-evidence.json` / `devframe-registration-audit.json`，补测完整结果已记录到 `rust-validation-evidence.json`：包类型生成/tsc、nsh-dev 7 unit + 9 roundtrip（含 17 MiB/redirect、64 MiB 边界/越界拒绝/恢复）、client-only check、base 930（4 ignored）、AppKit 80、List core focused 6、headless 2、JS declarations 17 均通过；完整 core 仍为 1,017 通过、2 失败、10 ignored，唯一非零命令为 `full-rust-lib`（101）。所有命令前后完整 source/lock 不变，paired tools 缓存 hash 复验通过。

**此阶段明确禁止 release，不能称为 full green。** List 的两项完整 core 失败仍按原样保留；没有删除 List、跳过/削弱 guard 或修改旧 digest 来绕过它们。工具仅授权开发图像诊断，后续补丁修订及各项物理复验仍需新的明确证据。

main 已回报该工具的真实 whole App 能加载 build 1，原 16 MiB 断连解除；当前另有真实 AppKit active/visible gate 阻塞、停留连接页，primary 同样受影响。此为 main 的物理观察，不是本 preparation owner 的窗口复验；没有伪造 lifecycle，1068×832 的功能/像素签收仍未完成。8a261 继续保留诊断状态，不修改其 source、receipt、工具或既有证据。

## 第五项 ListContract：追加修复 core 契约

经明确授权，将冻结 `list-scroll-snapshot-contract-fix.patch` 作为第五项追加，SHA-256 为 `5e83490bd17df64e1d1206b50da823468639bbaac772c1379a6db25eb510f887`。原 List 与 DevFrame 补丁字节及顺序不变，未登记 Windows focus；只保存 patch 和去除个人机路径的 [三文件 hash ledger](./list-scroll-snapshot-contract-fix.hashes.json)，不复制 scratch candidate 的环境路径。

修改范围与 owning 依据：

- `crates/nsh-core/src/js/host.rs` 将异步只读回执 `ScrollSnapshot` 登记到 `INTERNAL_EVENTS`，而非用户 props 的 `EVENTS`；遵循现有内部读取回执分类。
- `crates/nsh-core/src/js/mod.rs` 在现有私有 props 排除断言中加入 `onScrollSnapshot?`，防止误公开事件；不删除或弱化 `every_event_is_typed_or_internal`。
- `crates/nsh-core/unitless.txt` 为 `ScrollSnapshot.zoom_scale` 登记实际的无量纲 extent ratio，遵循上游 `docs/dev/geometry.md#typed-api` 允许带理由的 scale factor/ratio 规则及已有 `ScrollEvent.zoom_scale` 先例；不改 scanner、`untyped.txt`、长度类型或数值行为。

三文件均存在且与前四项无重叠，已核对 8a261 实际 before hash、冻结候选字节与完整 after hash，严格零 fuzz 内存重放通过。基于含 DevFrame 的实际 1,745 文件树独立计算，最终 aggregate 为 `e848c8ccbbb3113688dc04f2363a0522c9969ed3c29e02c522245c14e7aed60d`，**不是**候选仅基于 f7ded 的 `6c09b29e…`。Cargo.lock 仍为原完整锁；不新增依赖、不改外部 checkout、不覆盖旧 digest。

新 digest：`9b0dad8e9d209839e2b2de3004f5b0c4ed496f1df4098158cba4bb350c9f6c3f`。严格 preparation 77 项及测试文件严格类型检查通过。paired CLI/macOS runtime 已由该完整源码树与原完整锁 offline/locked 独立构建并交付 main：CLI SHA-256 为 `295f2fa34432486dee40110223d16f7e226e928407ae7e39738785753d017a22`，runtime SHA-256 为 `160c218bf67e54e6402525f4942068a49eb975e2e36855d8f6a6b3856733f6ba`，路径为新 digest 下的 `tools-darwin-arm64/bin/nsh` / `tools-darwin-arm64/runtime`。构建前后完整 source/lock 不变，旧 8a261 全目录 1,760 文件逐项复验不变；证据为 `list-contract-registration-audit.json` / `diagnostic-tools-evidence.json`。

新 digest 的独立验证已完成，均使用原完整 workspace lock `--offline --locked`，没有 fetch、裁剪锁或复用候选的 aggregate/测试结果：

- 同先前 feature graph 的完整 core/base/AppKit lib：core **1,019 通过、0 失败、10 ignored**；base **930 通过、4 ignored**；AppKit **80 通过**。原两项 core 契约 guard 及私有 props 回归断言均实际通过，没有删除或跳过它们。
- 另跑 core `--all-features --lib`：**1,020 通过、0 失败、10 ignored**；与上一命令计数不同来自 feature graph，不能混写为同一次结果。
- DevFrame 原完整锁：7 unit + 9 roundtrip 通过，含大 bundle/redirect、64 MiB 边界、越界拒绝及恢复；client-only check 通过。
- List core focused 6、headless focused 2、JS declarations 17 均通过；新 paired CLI 类型生成与整包 tsc 通过，生成的 `nsh/types.d.ts` 与上一轮逐字相同（SHA-256 `b2748bbb294209a216ccd26a7b557ab31e60c0a3df437a58dee7b2c488f592b2`），保留 `getScrollSnapshot(): Promise<ScrollEvent | null>`，没有公开 `onScrollSnapshot?`。
- 每条命令前后完整 source/lock 不变，paired tools 缓存 hash 复验通过，旧 8a261 全目录再次逐项不变。完整命令、退出码和原始日志 SHA-256 见新 digest 的 `rust-validation-evidence.json`，其 `allCommandsPassed:true` 仅指本次列出的 8 条验证命令，不表示 workspace-wide 或产品全绿。

本轮只完成 preparation、同源 paired tools 与上述 core/类型/集成验证。真实 AppKit active/visible、实际 App 功能与 1068×832 PC 像素验收、Windows 物理验收仍未完成，保持 `releaseAllowed:false`。8a261 原两红仍保留为该旧 digest 的历史事实，不因新 digest 通过而改写旧证据。

## 阶段二完整基线验证（Shift→Diff，不含 List）

- digest：`7834beffee6dc6dd588bee99f717366a37dca2282ceb53544b80734e800f97e0`。完整最终树 SHA-256：`91c5b6dc3d5d0db86723517dfb2537e3ec7833fa044dd921da3cb13c274e2461`。从新基线仅去掉补回的 `image/cache/tests.rs` 即还原旧 aggregate，其它基线文件未改变。
- `nsh-compat.test.ts`：66 项通过；覆盖合法 cache 模块、已知 artifact 缓存排除、源码/缓存篡改和 symlink 拒绝；测试文件自身的严格 TypeScript 检查通过。
- 同一复制源码和原 lock，用已安装的 Cargo/Rust 1.97.1 直接编译器路径构建 CLI/macOS runtime，全程 `--offline --locked`，无需再次 fetch；构建前后及 Rust 测试后完整树/lock 均不变。两个工具已发布并重新通过缓存 hash 校验；不是历史工具改贴新 digest。
- 新 CLI 生成 `DiffViewport`、`viewport` 和 `onHunkBoundsChange` 声明，并通过整个 `packages/nsh` TypeScript check（显式使用已安装 tsc，不下载 TypeScript）。
- 同一 preparation 的完整 Rust lib 测试：core 1,013 通过 / 10 ignored，base 930 通过 / 4 ignored，AppKit 80 通过；新增 2 项 core + 6 项 Diff parent viewport 回归均通过。只有 debug 链接器的 unwind 表大小警告；不代表实际平台窗口/输入/视觉或 Windows 已签收。
- 证据位于该 digest 目录的 `baseline-audit.json`、`strict-tests.json`、`build-and-validation-evidence.json` 和 `tools-darwin-arm64/receipt.json`。旧 digest 的证据仅保留历史含义。

## 历史验证记录（最初 Shift-only preparation）

- Focused Vitest：7 文件、66 项通过，包含 preparation、严格 diff、摘要链、并发、无 hardlink、源树不变、缓存完整性和发布失败回滚；编译产物注入测试明确不属于 OS 证据。
- 三个入口脚本 `node --check` 通过；真实源码 preparation 已应用补丁并核对全部输出 hash。
- CLI/devhost 构建、同源 Rust Shift 回归、production `--check-host` 和 CLI wrapper 均在离线解析阶段失败：首个缺失 package 为 `oxc`，尚未生成可用 patched CLI/runtime。不能假设补齐它后没有其它缺失。
- 原发行版的 AppKit capture 与 Shift/Alt+Return 控制通过；不代表 patched runtime 的 Shift 正向通过。Windows、Option/标点/非 US 物理布局及完整 IME 未验收。
- 使用禁止安装的 cached knip 尝试 dead-code；现有 Web 配置加载缺 `vite-plugin-pwa`，未得到完整报告，未安装依赖。
