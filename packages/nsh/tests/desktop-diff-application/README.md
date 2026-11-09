# Diff：实际 App 设置、工作台与关窗

`Root.tsx` 直接挂生产 `YuriNativeApp`；只在公开 NSH Storage 边界增加可控的丢 ACK/只读 reconcile 与计数，不注入 preference owner、Diff、Settings 或 close callback。合成原生参数显式声明协调策略。

## 场景

- 恢复真实工作台 Diff，打开 Settings 搜索 Diff Layout；local-only 保存驱动同一个 retained Diff 的 inline/split，不发 Host settings PUT。
- 原 composer 草稿保留。wrap 只写设备偏好，不重新 GET patch；显式全文调用正式 `/api/git/file-diff`，不是 fs 正文替代 Git 基线。
- 模拟保存已写但 ACK 丢失、核验不可知：Settings 保 prior/草稿，原生 close ticket 得到 veto；显式只读核验 exact candidate 后才解除，没有第二次写入。
- 原生 primary 的 `multi-engine` 或缺失 coordination 走 unsupported，Diff 偏好零 Storage 读写。稳定 key/primary 不是 single-engine grant。

`Host.js` 仅允许固定 unstaged fixture 的正式 patch、前后 light status 和 full-file DTO，检查目录与原 native lease；其余沿严格 Header/Navigation Host 拒绝。这里没有使用真实 Git 命令、文件、模型或 Host 写入。

```sh
NSH_BIN=/path/to/nsh/bin/nsh bunx --no-install vitest run \
  --config packages/nsh/vitest.config.ts \
  packages/nsh/desktop-diff-application-native.test.ts
```

## 不可扩大解释

Headless Mac/Windows 模型不等于 AppKit/Win32 截图或实机。Storage API ACK/flush 不是 fsync/崩溃耐久性或 native CAS。正式全文 mixed index、rename、staged deletion、历史、binary/图片等分类的协议/组件证据见 `desktop-diff-DOCUMENTATION.md`；本 actual-root 的简单 unstaged 场景不覆盖全部类别。stacked/scope/完整写操作与 selection comments 仍未完成。
