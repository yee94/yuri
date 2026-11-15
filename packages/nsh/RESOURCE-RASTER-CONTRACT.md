# 资源原图 raster 预览合同

面向消息/附件全屏预览的“安全原件渲染”组件。图片手势、缩放与预览 chrome 不属于本组件；本文件只约束从已认证原件到 native 视图的那一层。

## 所有权

| 模块 | 职责 |
| --- | --- |
| `resource-raster.tsx` | 公开 TSX 组件 `ResourceRasterImage`，只携带 opaque `config` 与事件类型 |
| `ios/ResourceRasterImage.swift` | 解码预算、`ResourceRasterImagePresentation` 票据、`ResourceRasterImageView`（`UIImageView`）与 ImageIO 后台解码 |
| `ios/ResourceRasterImageComponent.swift` | `yuri.resource.rasterImage` 的 NSH 注册、`config` 转发、`retry` command 与事件投影 |
| `android/.../ResourceRasterImageComponent.java` | Android 对等实现（`ImageView`、`BitmapFactory` 采样、EXIF 方向） |
| `ios/ResourceBridge.swift` / `android/.../ResourceBridge.java` | `rasterAsset` / `rasterResolver`：只读 private lease、Host fence、退休观察；`resources.read` 的 `width`/`height` metadata |
| `ios/main.swift` / `android/.../NativeHandlers.java` | 在真实 Host 上注册组件并注入 resolver |

`ResourceBridge` 仍然是唯一持有原件读取、`resources.release` 和私有目录的 owner。组件和视图都没有 transport、Host 捕获、文件路径或字节读取能力。

## API

```tsx
import { ResourceRasterImage } from './resource-raster';

<ResourceRasterImage
  config={{ lease, expectedHost, active }}
  onSize={event => {}}   // { width, height } 原件显示尺寸（EXIF 方向已应用）
  onLoad={event => {}}   // { width, height } 同一尺寸，解码已应用到视图
  onError={event => {}}  // { code: 'decode' | 'expired' }
  ref={ref => { raster = ref; }} // ref.command('retry')
/>;
```

- `lease` 必须是 `ResourceBridge.read` 返回的 UUID opaque lease，且该 lease 的 `kind === 'image'`。
- `expectedHost` 是读取时捕获的 `RuntimeScope`；不匹配即失败，不会借用当前选中的 Host。
- `active` 由页面可见性决定；隐藏、后台、离窗、lease 退休都会撤销当前解码票据。
- 事件只包含尺寸与稳定错误码。`size` 在 `load` 之前发同一次成功解码；失败/过期只发 `error`。
- `retry` 复用同一 lease/Host 票据，只重新核验并解码本地原件；不会重新读取 Host、不会 fallback 到路径。

## 安全边界

- JS 永远拿不到文件路径、原件字节或原件 base64；`resources.read` 仍只返回 1024px JPEG thumbnail（用于列表/内联预览）。
- 严格 parser 与 SVG 共用：`ResourceImageRequest`（iOS）/`ResourceSVGImageComponent.Request`（Android）拒绝多余键、非 UUID lease、非布尔 `active`、路径与 `data:` 原文字段。
- 解码只发生在 `ResourceBridge` 验过的 private lease 文件上：iOS 用 `CGImageSourceCreateWithURL`，Android 用 `BitmapFactory.decodeFile`。两者都不走网络、WKWebView、脚本或基座文档。
- `rasterAsset`/`rasterResolver` 在每次取件时核对 `kind`、`expectedHost` 与 `lease.current()`；视图每帧完成回调都重新核对 `lifetime.accepts(ticket)` 与 `current()`。
- lease 退休（`resources.close`、`release`、Host 切换、后台 `suspend`、controller teardown）通过原 `leaseObservers` 通知对应代际的视图，立即清空图像并发 `expired`。

## 解码预算

25 MiB 的字节预算不能约束解码后的像素，因此 raster 单独限制：

- 单边最大 `4096px`；
- 总像素约 `8,000,000`（RGBA≈32 MiB）作为第二上限，用 `sqrt(budget / (w*h))` 等比收缩最长边；
- 不放大（源尺寸已小于预算时保持原尺寸）；
- iOS 用 `kCGImageSourceCreateThumbnailFromImageAlways` + `kCGImageSourceThumbnailMaxPixelSize` + `kCGImageSourceCreateThumbnailWithTransform` + `kCGImageSourceShouldCacheImmediately`，在 detached 后台任务解码；
- Android 用 `inJustDecodeBounds` 读头部、按 2 的幂计算 `inSampleSize`、`inPreferredConfig = ARGB_8888`，再按 EXIF orientation 旋转；
- 解码超过 15s 视为失败，不无限等待；
- iOS 解码在 detached 后台任务中无法被中途中断，退休/替换只会丢弃迟到结果（fence 拒绝），不宣称已物理取消解码。

EXIF orientation 5–8 会把显示宽高交换；`size`/`load` 与 `resources.read` 的 `width`/`height` 都报告方向应用后的显示尺寸，供全屏 fit 使用。Android 旋转会产生一次临时第二份 bitmap，因此像素上限同时作为旋转峰值预算。

## 生命周期

`ResourceRasterImagePresentation` 只有 `stopped/loading/ready/failed/expired`：

- 新 config 或 retry 递增 generation，旧解码结果因票据不匹配被丢弃；
- 解码成功只允许当前票据从 `loading → ready` 一次；
- 失败/过期后 `retry` 需要重新核验 lease 仍 current；
- 后台、离窗、`stop()` 清票据与图像；`expired` 保留明确失败状态，不回退空白；
- 每次成功替换图像或 retire 时释放上一张 bitmap（Android `recycle`，iOS ARC）。

## 证据

| 命令 | 覆盖 |
| --- | --- |
| `bunx vitest run --config packages/nsh/vitest.config.ts resource-raster-swift.test.ts` | Foundation-only 的 lease parser/lifetime/budget/EXIF/票据合同；源码边界（无 path/base64/WKWebView，事件仅尺寸与错误码，两个 Host 均已注册） |
| `bunx vitest run --config packages/nsh/vitest.config.ts resource-svg-swift.test.ts -t typechecks` | 真实 SDK 下 `ResourceBridge` + `ResourceWebPreviewBridge` + 新增 raster 视图/组件的 UIKit typecheck（NativeShell 以合同 stub 提供） |
| `bunx vitest run --config packages/nsh/vitest.config.ts resource-contact-generation.test.ts` | `ResourceBridge` 的 lease/close/release 语义仍可在 Foundation-only 边界编译；退休观察重命名后合同保持 |
| `sh packages/nsh/android/tests/resources-preview/run.sh` | Android `Resource*` 与 android.jar/stub 联编；采样预算、EXIF 尺寸与既有 preview 合同 |
| `javac --release 17 -cp android.jar:<staged classes.jar>:android/libs/zxing-core-3.5.3.jar $(find android/src -name '*.java')` | 全量 Android 源码编译（本机未提供 `nsh.aar` 时使用已 staging 的 `classes.jar`） |

## 未验边界

- 未在真机/真实 Host 上验证 huge HEIC/WebP 的实际解码峰值、相册原图色彩空间与滚动中连续替换 bitmap 的帧表现。
- 父级整合已使用本机 NSH distribution 顺序完成最终 `android:build` 与 `ios:build`；iOS 为 arm64 simulator app，最终日志无 Swift warning。构建不替代真实 Host 原图/设备内存验收。
- Android 未有真机验证 EXIF 旋转后的触摸坐标；手势由独立预览 owner 负责。
- `resources.read` 的 `width`/`height` 是可选 metadata，宿主未提供属性时省略，不是失败。
