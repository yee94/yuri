import { cleanup, effect, host, Image, lifecycle, reduceMotion, safeArea, signal, Text, untracked, View, type GestureResponderEvent, type TouchPoint, type ViewRef } from 'nsh';
import { Button, Input } from 'nsh/base';
import { Icon } from './Icon';
import { t } from './i18n';
import { native } from './runtime';
import { createDesktopGestures, type DesktopTransform, type DesktopViewport } from '../ui/src/lib/remote-desktop/gestures';
import { createRemoteDesktopSession, remoteDesktopMessageKey, type RemoteDesktopFrame, type RemoteDesktopState } from './remote-desktop-core';
import { remoteDesktopLocalPoint, remoteDesktopPageSize, remoteDesktopSafeArea } from './remote-desktop-geometry';

const navigationKeys = [
  { key: 'Escape', icon: 'corner-up-left' }, { key: 'Tab', icon: 'arrow-right-to-line' },
  { key: 'Backspace', icon: 'delete-back' }, { key: 'Enter', icon: 'corner-down-left' },
  { key: 'ArrowLeft', icon: 'arrow-left' }, { key: 'ArrowUp', icon: 'arrow-up' },
  { key: 'ArrowDown', icon: 'arrow-down' }, { key: 'ArrowRight', icon: 'arrow-right' },
] as const;
const circleStyle = { width: 44, height: 44, glassEffect: 'regular' as const };

/** Mount in a full-screen native route, above the retained source tab/chat. No WebView. */
export function NativeRemoteDesktopPage(props: { scopeKey: string; active?: boolean; onClose: () => void }) {
  const state = signal<RemoteDesktopState>({ phase: 'connecting' });
  const mode = signal<'drag' | 'cursor'>('drag'), keyboard = signal(false), text = signal(''), sending = signal(false);
  const rotation = signal(0), size = signal({ width: 1, height: 1 }), region = signal({ width: 1, height: 1 });
  const transform = signal<DesktopTransform>({ scale: 1, x: 0, y: 0 });
  const settling = signal(false);
  const measurementFailed = signal(false);
  let root: ViewRef | null = null, measured = false, pageOrigin = { x: 0, y: 0 }, measurement = 0;
  let initialPortrait: boolean | undefined, disposed = false, zoomed = false, lastPhase: RemoteDesktopState['phase'] = 'connecting';
  let viewport: DesktopViewport = { width: 1, height: 1, remoteWidth: 1920, remoteHeight: 1080 };
  const pointers = new Set<number>();
  const session = createRemoteDesktopSession({
    scopeKey: props.scopeKey,
    call: native,
    subscribe: listener => host.on('remoteDesktop.event', listener),
    changed: value => {
      if (value.phase !== lastPhase && value.phase !== 'live') { pointers.clear(); gestures.cancel(); }
      lastPhase = value.phase;
      if (value.frame) {
        const sameAspect = Math.abs(viewport.remoteWidth / viewport.remoteHeight - value.frame.width / value.frame.height) < .01;
        viewport = { ...viewport, remoteWidth: value.frame.width, remoteHeight: value.frame.height };
        if (!sameAspect && !pointers.size) gestures.reset();
      }
      state.set(value);
    },
  });
  const gestures = createDesktopGestures({
    viewport: () => viewport,
    mode,
    send: input => { void session.send(input); },
    apply: (value, settle = false) => {
      settling.set(settle);
      transform.set(value);
      const next = value.scale > (zoomed ? 1.01 : 1.05);
      if (next !== zoomed) { zoomed = next; session.setZoomed(next); }
    },
  });
  effect(() => {
    const active = props.active !== false && lifecycle() === 'active', scope = props.scopeKey;
    untracked(() => {
      session.setActive(active, scope);
      if (!active) { pointers.clear(); gestures.cancel(); keyboard.set(false); }
    });
  });
  cleanup(() => { disposed = true; measurement++; pointers.clear(); gestures.cancel(); session.dispose(); });
  const live = () => state().phase === 'live' && !measurementFailed();
  const logical = () => remoteDesktopPageSize(size().width, size().height, rotation());
  const inset = () => remoteDesktopSafeArea(safeArea(), rotation());
  const buttonClass = (selected = false) => `rounded-full items-center justify-center active:bg-accent ${selected ? 'bg-primary text-primary-foreground' : 'bg-secondary text-foreground'}`;
  const point = (touch: TouchPoint) => remoteDesktopLocalPoint({ x: touch.pageX, y: touch.pageY }, { ...pageOrigin, ...size() }, rotation());
  function measurePage() {
    const revision = ++measurement; measured = false; measurementFailed.set(false);
    void root?.measure().then(value => {
      if (disposed || revision !== measurement) return;
      if (!value) { measurementFailed.set(true); return; }
      pageOrigin = value.pagePosition; measured = true;
    }).catch(() => { if (!disposed && revision === measurement) measurementFailed.set(true); });
  }
  function touchStart(event: GestureResponderEvent) {
    if (!live() || !measured) return;
    for (const touch of event.changedTouches) { pointers.add(touch.identifier); gestures.down(touch.identifier, point(touch)); }
  }
  function touchMove(event: GestureResponderEvent) {
    if (!live() || !measured) return;
    // NSH coalesces move events per engine turn. Update both fingers before one pinch calculation.
    gestures.moveMany(new Map(event.touches.filter(touch => pointers.has(touch.identifier)).map(touch => [touch.identifier, point(touch)])));
  }
  function touchEnd(event: GestureResponderEvent, cancelled = false) {
    for (const touch of event.changedTouches) { gestures.up(touch.identifier, point(touch), cancelled); pointers.delete(touch.identifier); }
  }
  function selectMode(value: 'drag' | 'cursor') { pointers.clear(); gestures.cancel(); mode.set(value); }
  function close() { pointers.clear(); gestures.cancel(); session.dispose(); props.onClose(); }
  async function sendText() {
    if (!live() || sending() || !text()) return;
    const draft = text(); sending.set(true);
    try { if (await session.send({ type: 'text', text: draft }) && text() === draft) text.set(''); }
    finally { if (!disposed) sending.set(false); }
  }
  function frameLoaded(frame: RemoteDesktopFrame) { void session.decoded(frame); }
  return <View testID="remote-desktop-page" class="flex-1 bg-background overflow-hidden" ref={value => { root = value; }}
    onLayout={event => {
      const bounds = event.bounds.size;
      if (bounds.width <= 0 || bounds.height <= 0) return;
      size.set({ width: bounds.width, height: bounds.height });
      initialPortrait ??= bounds.height >= bounds.width;
      measurePage();
    }}>
    <View class="absolute top-0 left-0 bg-background overflow-hidden"
      style={{ width: logical().width, height: logical().height, transformOrigin: 'top left', transform: rotation() === 90 ? [{ translateX: size().width }, { rotate: '90deg' }] : rotation() === -90 ? [{ translateY: size().height }, { rotate: '-90deg' }] : [] }}>
      <View testID="remote-desktop-region" class="flex-1 overflow-hidden" onLayout={event => {
        const { width, height } = event.bounds.size;
        if (width <= 0 || height <= 0) return;
        const changed = Math.abs(width - viewport.width) >= 1 || Math.abs(height - viewport.height) >= 1;
        viewport = { ...viewport, width, height }; region.set({ width, height });
        if (changed && !pointers.size) gestures.refit();
      }}>
        <View testID="remote-desktop-screen" class="absolute inset-0 overflow-hidden" accessibilityLabel={t('remoteDesktop.screen')} accessibilityHint={t('remoteDesktop.hint')} style={{ pointerEvents: 'box-only' }}
          onStartShouldSetResponder={() => live()} onResponderGrant={() => true} onResponderTerminationRequest={() => false}
          onTouchStart={touchStart} onTouchMove={touchMove} onTouchEnd={event => touchEnd(event)} onTouchCancel={event => touchEnd(event, true)}
          onResponderTerminate={() => { pointers.clear(); gestures.cancel(); }}>
          <View style={{ pointerEvents: 'none', position: 'absolute', width: region().width, height: region().height, transformOrigin: 'top left', transitionProperty: 'transform', transitionDuration: settling() && !reduceMotion() ? 180 : 0, transitionTimingFunction: 'ease-out', transform: [{ translateX: transform().x }, { translateY: transform().y }, { scale: transform().scale }] }}>
            <Each of={state().frame ? [state().frame!] : []} key={frame => `${frame.owner}:${frame.id}`}>{frame =>
              <Image testID="remote-desktop-frame" src={frame().source} accessibilityLabel={t('remoteDesktop.screen')} style={{ width: region().width, height: region().height, objectFit: 'contain' }}
                onLoad={() => frameLoaded(frame())} onError={() => session.decodeFailed(frame())} />
            }</Each>
          </View>
        </View>
        <If when={!live()}><View testID="remote-desktop-status" class="absolute inset-0 p-6 gap-4 items-center justify-center bg-background" style={{ pointerEvents: 'box-none' }}>
          <Text class="text-sm text-muted-foreground text-center">{t(remoteDesktopMessageKey(state().code ?? (measurementFailed() ? 'geometry_failed' : undefined)))}</Text>
          <If when={measurementFailed() || !!state().code && !['unsupported', 'runtime_changed'].includes(state().code!)}><Button testID="remote-desktop-retry" class="rounded-xl bg-secondary px-4 py-3" onPress={() => { measurePage(); if (state().phase !== 'live') session.retry(); }}><Text class="text-foreground">{t('remoteDesktop.retry')}</Text></Button></If>
        </View></If>
        <View class="absolute left-0 right-0 flex-row justify-between" style={{ pointerEvents: 'box-none', top: Math.max(12, inset().top), paddingLeft: Math.max(12, inset().left), paddingRight: Math.max(12, inset().right) }}>
          <Button testID="remote-desktop-back" class={buttonClass()} style={circleStyle} accessibilityLabel={t('header.actions.backAria')} onPress={close}><Icon name="arrow-left" /></Button>
          <Button testID="remote-desktop-rotate" class={buttonClass()} style={circleStyle} accessibilityLabel={t('remoteDesktop.rotate')} onPress={() => { pointers.clear(); gestures.reset(); keyboard.set(false); rotation.set(rotation() ? 0 : initialPortrait === false ? -90 : 90); }}><Icon name="smartphone" /></Button>
        </View>
        <View testID={live() ? 'remote-desktop-controls-live' : 'remote-desktop-controls-pending'} class="absolute left-0 right-0 flex-row items-end justify-between" style={{ pointerEvents: 'box-none', bottom: Math.max(12, inset().bottom), paddingLeft: Math.max(12, inset().left), paddingRight: Math.max(12, inset().right) }}>
          <View class="flex-row gap-3">
            <Button testID="remote-desktop-drag" class={buttonClass(mode() === 'drag')} style={circleStyle} selected={mode() === 'drag'} disabled={!live()} accessibilityLabel={t('remoteDesktop.drag')} onPress={() => selectMode('drag')}><Icon name="hand" tone={mode() === 'drag' ? 'background' : 'foreground'} /></Button>
            <Button testID="remote-desktop-cursor" class={buttonClass(mode() === 'cursor')} style={circleStyle} selected={mode() === 'cursor'} disabled={!live()} accessibilityLabel={t('remoteDesktop.cursor')} onPress={() => selectMode('cursor')}><Icon name="cursor" tone={mode() === 'cursor' ? 'background' : 'foreground'} /></Button>
          </View>
          <Button testID="remote-desktop-keyboard" class={buttonClass(keyboard())} style={circleStyle} selected={keyboard()} disabled={!live()} accessibilityLabel={t('remoteDesktop.text')} onPress={() => keyboard.set(!keyboard())}><Icon name="keyboard" tone={keyboard() ? 'background' : 'foreground'} /></Button>
        </View>
      </View>
      <If when={keyboard()}><View testID="remote-desktop-keyboard-footer" class="shrink-0 bg-card gap-2 pt-3" style={{ paddingLeft: Math.max(12, inset().left), paddingRight: Math.max(12, inset().right), paddingBottom: Math.max(12, inset().bottom) }}>
        <View class="flex-row gap-2 items-center">
          <Input testID="remote-desktop-text" class="flex-1 rounded-xl bg-secondary px-3" value={text()} maxLength={1024} disabled={!live() || sending()} autoCorrect={false} autoComplete="off" placeholder={t('remoteDesktop.text')} accessibilityLabel={t('remoteDesktop.text')} onChange={event => text.set(event.value)} onSubmit={() => { void sendText(); }} />
          <Button testID="remote-desktop-send" class="rounded-xl bg-secondary items-center justify-center" style={{ width: 44, height: 44 }} disabled={!live() || sending() || !text()} accessibilityLabel={t('remoteDesktop.send')} onPress={() => { void sendText(); }}><Icon name="send-plane-2" /></Button>
        </View>
        <View class="flex-row flex-wrap gap-1"><Each of={navigationKeys}>{entry => <Button testID={`remote-desktop-key-${entry().key}`} class="rounded-xl items-center justify-center active:bg-accent" style={{ width: Math.max(36, (logical().width - Math.max(12, inset().left) - Math.max(12, inset().right) - 28) / (logical().width >= 360 ? 8 : 4)), height: 44 }} disabled={!live()} accessibilityLabel={t('remoteDesktop.pressKey', { key: entry().key })} onPress={() => { void session.send({ type: 'key', key: entry().key }); }}><Icon name={entry().icon} /></Button>}</Each></View>
      </View></If>
    </View>
  </View>;
}
