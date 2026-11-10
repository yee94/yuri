import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const java = (name) => readFileSync(path.join(mobile, `android/app/src/main/java/com/yuri/app/${name}`), 'utf8');
const native = java('ImeSyncBridge.java');

test('IME frames only translate the main WebView; layout and JS are bookend-only', () => {
  const progress = native.slice(native.indexOf('public WindowInsetsCompat onProgress('), native.indexOf('public void onEnd('));
  expect(progress).toContain('applyTranslation()');
  expect(progress).not.toMatch(/notifyImeState|reportImeState|evaluateJavascript|triggerJSEvent|setPadding|requestOffset/);
  expect(native).not.toMatch(/setPadding\(0, 0, 0, bottom\)|ImeMotionOverlay/);
  expect(native).toContain('webView.postVisualStateCallback(token');
  expect(native).toContain('token != offsetGeneration');
  // Close follows live frames: no translation hold waiting for the page.
  expect(native).not.toContain('holdInset');
  expect(native).toContain('float next = -currentInset;');
  expect(native).toContain('requestOffset(0)');
});

test('header is a separate pinned WebView without a Capacitor bridge or screenshots', () => {
  const header = java('NativeHeaderHost.java');
  expect(header).toContain('new WebView(activity)');
  expect(header).toContain('content.addView(view');
  expect(header).not.toMatch(/Bitmap|PixelCopy|draw\(new Canvas/);
  expect(header).toContain('setFocusable(false)');
  // Mirror page must stay transparent despite mirrored app root classes.
  expect(header).toContain(':root:root:root body');
  expect(header).toContain('setBackgroundColor(Color.TRANSPARENT)');
  expect(header).toContain('postVisualStateCallback(seq');
  // Same-layer page header at rest; mirror engaged only during IME motion.
  expect(native).toMatch(/if \(imeAnimations\.isEmpty\(\)\) \{\s+engageHeader\(\);/);
  expect(native).toContain('header.setEngaged(false)');
  expect(header).toContain('view.setAlpha(engaged ? 1f - collapse : 0f)');
  expect(header).toContain('view.setTranslationY(-collapse * collapseDistance)');
  expect(header).toContain('PathInterpolator(0.22f, 1f, 0.36f, 1f)');
  expect(java('MainActivity.java')).toContain('registerPlugin(YuriNativeHeaderPlugin.class)');
});

test('activity uses adjustResize and releases its IME owner on teardown', () => {
  const manifest = readFileSync(path.join(mobile, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
  expect(manifest).toContain('adjustResize');
  expect(java('MainActivity.java')).toContain('imeSyncBridge.detach()');
});

test('iOS WebView composer path uses the same native IME owner and pinned header', () => {
  const ios = readFileSync(path.join(mobile, 'ios/App/App/YuriNativeHeaderPlugin.swift'), 'utf8');
  // Keyboard frames animate only a native transform inside the keyboard's own curve.
  expect(ios).toContain('webView?.transform = CGAffineTransform(translationX: 0, y: -value)');
  expect(ios).toContain('header?.transform = CGAffineTransform(translationX: 0, y: value - collapse * collapseDistance)');
  expect(ios).toContain('UIView.AnimationOptions(rawValue: curveRaw << 16)');
  // Separate transparent header WebView; never a bitmap.
  expect(ios).toContain('view.isOpaque = false');
  expect(ios).not.toMatch(/UIGraphicsImageRenderer|snapshotView|takeSnapshot/);
  // Native liquid-glass composer keeps ownership of its keyboard.
  expect(ios).toContain('guard imeSync');
  const registry = readFileSync(path.join(mobile, 'ios/App/App/YuriBridgeViewController.swift'), 'utf8');
  expect(registry).toContain('registerPluginInstance(YuriNativeHeaderPlugin())');
  expect(readFileSync(path.join(mobile, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8')).toContain('YuriNativeHeaderPlugin.swift in Sources');
});
