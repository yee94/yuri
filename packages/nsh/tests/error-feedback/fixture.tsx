import { host, mount, safeArea, Scroll, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { TabBar } from 'nsh/mobile';
import { app, epoch, loadConnections, rootErrorFeedback, run } from '../../state';
import { NativeFeedbackLayer } from '../../error-notice';
import { NativeRootErrorFeedback, rootErrorVisible } from '../../root-error-feedback';
import { language } from '../../i18n';
import { NativeAppearanceFeedback } from '../../appearance-feedback';
import { nativeAppearance } from '../../appearance';
import { appearanceFromSettings } from '../../appearance-core';

language.set('zh-CN');
const phase = signal('before'), back = signal(0), touch = signal(0), tabHeight = signal(0);
async function audit(label: string) { phase.set(label); await host.call('feedback.fixture.capture', { phase: label, failureVisible: rootErrorFeedback()?.visible ?? false, failureRetained: !!rootErrorFeedback(), back: back(), touch: touch() }); }
const readOwner = async () => { await host.call('feedback.fixture.read', { expectedHost: app.runtimeScope() }); };
function Fixture() {
  void loadConnections();
  return <View class="flex-1 bg-background">
    <View class="flex-1" style={{ paddingTop: safeArea().top, paddingBottom: Math.max(safeArea().bottom, tabHeight()) }}>
      <Scroll testID="feedback-body" class="flex-1" contentClass="px-4 gap-3">
        <Text testID="feedback-body-first" class="text-xl text-foreground">项目正文首帧</Text>
        <Button testID="feedback-inject" class="min-h-11 bg-secondary" onPress={() => { void run(readOwner, { retry: readOwner }).then(() => audit('failure')); }}><Text>注入同长度原始权限错误</Text></Button>
        <Button testID="feedback-recover" class="min-h-11 bg-secondary" onPress={() => { void host.call('feedback.fixture.recover').then(() => audit('recovery-enabled')); }}><Text>允许原读取恢复</Text></Button>
        <Button testID="feedback-capture" class="min-h-11 bg-secondary" onPress={() => { void audit('manual'); }}><Text>记录实际 UIKit frame</Text></Button>
        <Button testID="feedback-warning" class="min-h-11 bg-secondary" onPress={() => { void appearanceFromSettings({}, async () => []).then(appearance => {
          const connection = app.connection();
          if (!connection) return;
          nativeAppearance.current.set({ ...appearance, uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'system-ui', dark: 'system-ui' }, unsupportedFonts: ['Synthetic font'], fontStatus: 'unsupported', fontRevision: 1, fontTicket: 1, sourceHost: { hostID: connection.id, url: connection.url, generation: epoch() } });
          return audit('appearance-warning');
        }); }}><Text>显示原 appearance warning</Text></Button>
        <Button testID="feedback-denied" class="min-h-11 bg-secondary" onPress={() => { void run(async () => { await host.call('connection.unknown'); }).then(() => audit('negative-denial')); }}><Text>验证未授权能力仍拒绝</Text></Button>
        <Button testID="feedback-touch" class="min-h-11 bg-secondary" onPress={() => { touch.set(touch() + 1); void audit('body-touch'); }}><Text>正文触摸 · {touch}</Text></Button>
        <Each of={Array.from({ length: 40 }, (_, index) => index)}>{index => <Text class="text-foreground">滚动正文 {index()} · 通知浮层不占正文高度。</Text>}</Each>
      </Scroll>
    </View>
    <TabBar testID="feedback-bottom-tab" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'transparent' }} onLayout={event => tabHeight.set(event.bounds.size.height)} selectedIndex={0} onChange={() => { void audit('tab-touch'); }} items={[{ title: '项目', icon: 'folder' }, { title: '助理', icon: 'sparkles' }, { title: '计划', icon: 'calendar' }, { title: '设置', icon: 'gearshape' }]} />
    <NativeFeedbackLayer layoutKey={phase()}><NativeRootErrorFeedback /><NativeAppearanceFeedback suppressed={rootErrorVisible()} /></NativeFeedbackLayer>
  </View>;
}
mount(Fixture);
