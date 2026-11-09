import { cleanup, effect, Overlay, safeArea, Scroll, signal, Text, View, windowSize, type JSX } from 'nsh';
import { Button } from 'nsh/base';
import { feedbackGeometry } from './error-feedback';
import { t } from './i18n';
import { native } from './runtime';

/** One root overlay: UIKit safeArea is measured, never guessed from CSS env classes. */
export function NativeFeedbackLayer(props: { children?: JSX.Element; layoutKey?: unknown }) {
  const top = signal<number | null>(null);
  let generation = 0;
  effect(() => {
    props.layoutKey; windowSize();
    const area = safeArea(), captured = ++generation;
    top.set(null);
    void native<{ top: number }>('feedback.layout').then(value => {
      if (captured === generation) top.set(typeof value?.top === 'number' && Number.isFinite(value.top) ? Math.max(area.top, value.top) : area.top);
    }).catch(() => {
      // Non-iOS/headless hosts have no UIKit navigation bars. Their actual root
      // safe area remains the presentation boundary; no Host call is replayed.
      if (captured === generation) top.set(area.top);
    });
  });
  cleanup(() => { generation++; });
  const geometry = () => feedbackGeometry(windowSize(), { ...safeArea(), top: top() ?? safeArea().top });
  return <Overlay testID="native-feedback-layer" style={{ ...geometry(), opacity: top() === null ? 0 : 1, pointerEvents: top() === null ? 'none' : 'box-none' }}>
    <Scroll contentClass="gap-2" style={{ maxHeight: geometry().maxHeight }}>{props.children}</Scroll>
  </Overlay>;
}

/** Safe, localized copy only. A notice has no access to exceptions, URLs or credentials. */
export function NativeErrorNotice(props: { testID: string; message: string; severity?: 'error' | 'warning'; busy?: boolean; onRetry?: () => void; onClose: () => void }) {
  return <View testID={props.testID} class="rounded-2xl bg-card px-4 py-3 gap-2">
    <Text testID={props.testID + '-message'} role={props.severity === 'warning' ? 'summary' : 'alert'} class={props.severity === 'warning' ? 'text-base text-foreground' : 'text-base text-destructive'} allowFontScaling maxFontSizeMultiplier={0}>{props.message}</Text>
    <View class="flex-row flex-wrap justify-end gap-2">
      <Button testID={props.testID + '-close'} class="min-h-11 px-3 py-2 rounded-xl bg-secondary active:bg-accent items-center justify-center" onPress={props.onClose}><Text class="text-foreground" allowFontScaling maxFontSizeMultiplier={0}>{t('mobile.surface.closeAria')}</Text></Button>
      <If when={!!props.onRetry}><Button testID={props.testID + '-retry'} class="min-h-11 px-3 py-2 rounded-xl bg-secondary active:bg-accent items-center justify-center disabled:opacity-40" disabled={props.busy} onPress={props.onRetry}><Text class="text-foreground" allowFontScaling maxFontSizeMultiplier={0}>{t('chat.questionDelegate.retry')}</Text></Button></If>
    </View>
  </View>;
}
