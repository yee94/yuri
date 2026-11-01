import * as React from 'react';
import { createPortal } from 'react-dom';
import { useEvent, useEventListener, useResizeObserver } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { holdNativeComposerCover } from '@/lib/nativeComposerCover';
import { mobileBackNavigationCoordinator, useMobileBackRoute } from './mobileBackNavigation';
import { useI18n } from '@/lib/i18n';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { connectRemoteDesktop, type DesktopInput } from '@/lib/remote-desktop/connection';
import { createDesktopGestures, type DesktopInteractionMode, type DesktopViewport } from '@/lib/remote-desktop/gestures';
import { desktopLocalPoint, requestDesktopOrientationPermission } from '@/lib/remote-desktop/orientation';
import { useDesktopOrientation } from '@/lib/remote-desktop/useDesktopOrientation';
import { useRemoteDesktopCapability } from '@/queries/remoteDesktopQueries';

function RemoteDesktopPanelImpl({ onClose, instanceName }: { onClose: () => void; instanceName?: string }) {
  const { t } = useI18n();
  const [scope] = React.useState(() => ({ transport: getRuntimeTransportIdentity(), generation: getRuntimeGeneration() }));
  const capability = useRemoteDesktopCapability(scope.transport, scope.generation);
  const [attempt, setAttempt] = React.useState(0);
  const [state, setState] = React.useState<'connecting' | 'webrtc' | 'tunnel' | 'closed'>('connecting');
  const [error, setError] = React.useState<string>();
  const [mode, setMode] = React.useState<DesktopInteractionMode>('drag');
  const [keyboardOpen, setKeyboardOpen] = React.useState(false);
  const [text, setText] = React.useState('');
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const pageRef = React.useRef<HTMLDivElement>(null);
  const orientation = useDesktopOrientation(pageRef, keyboardOpen);
  const stageRef = React.useRef<HTMLDivElement>(null);
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const imageRef = React.useRef<HTMLImageElement>(null);
  const geometry = React.useRef<DesktopViewport>({ width: 1, height: 1, remoteWidth: 1920, remoteHeight: 1080 });
  const connection = React.useRef<ReturnType<typeof connectRemoteDesktop> | null>(null);
  const frameRef = React.useRef<number | null>(null);
  const moves = React.useRef(new Map<number, { x: number; y: number }>());
  const send = useEvent((input: DesktopInput) => { connection.current?.send(input); });
  const getMode = useEvent(() => mode);
  const [gestures] = React.useState(() => createDesktopGestures({
    viewport: () => geometry.current,
    send,
    mode: getMode,
    apply: (value, settle) => {
      if (!stageRef.current) return;
      stageRef.current.style.transition = settle && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ? 'transform 180ms ease-out' : 'none';
      stageRef.current.style.transform = `translate(${value.x}px, ${value.y}px) scale(${value.scale})`;
    },
  }));
  const flushMoves = useEvent(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    for (const [id, point] of moves.current) gestures.move(id, point);
    moves.current.clear();
  });
  const stop = useEvent(() => {
    flushMoves(); gestures.reset();
    connection.current?.close(); connection.current = null;
  });
  const closePage = useEvent(() => { stop(); onClose(); });
  useMobileBackRoute({ id: 'remote-desktop-page', active: true, layer: 'root', onBack: closePage, surfaceRef: pageRef });
  React.useEffect(() => holdNativeComposerCover('remote-desktop-page'), []);
  React.useLayoutEffect(() => {
    const previous = document.activeElement;
    pageRef.current?.focus({ preventScroll: true });
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); mobileBackNavigationCoordinator.requestBrowserBack(); }
  }, () => document);
  const handleState = useEvent((next: typeof state, code?: string) => { setState(next); setError(code); });
  const handleSize = useEvent((width: number, height: number) => {
    if (width <= 0 || height <= 0 || (geometry.current.remoteWidth === width && geometry.current.remoteHeight === height)) return;
    geometry.current = { ...geometry.current, remoteWidth: width, remoteHeight: height };
    gestures.reset();
  });
  useResizeObserver(viewportRef, ([entry]) => {
    if (!entry) return;
    geometry.current = { ...geometry.current, width: entry.contentRect.width, height: entry.contentRect.height };
    gestures.reset();
  });
  useEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') stop(); }, () => document);
  React.useEffect(() => {
    if (!capability.data?.supported || !capability.data.enabled || !videoRef.current || !imageRef.current) return;
    const active = connectRemoteDesktop({ ...scope, video: videoRef.current, image: imageRef.current, onSize: handleSize, onState: handleState });
    connection.current = active;
    return () => { active.close(); connection.current = null; };
  }, [capability.data?.supported, capability.data?.enabled, scope, attempt, handleSize, handleState]);
  React.useEffect(() => () => { flushMoves(); gestures.reset(); }, [flushMoves, gestures]);

  const point = (event: React.PointerEvent) => {
    const rect = viewportRef.current!.getBoundingClientRect();
    return desktopLocalPoint({ x: event.clientX, y: event.clientY }, rect, orientation.rotation);
  };
  const live = state === 'webrtc' || state === 'tunnel';
  const unsupported = capability.data?.supported === false || capability.error?.message === 'unsupported';
  const disabled = capability.data?.supported === true && capability.data.enabled !== true;
  const permission = error === 'permission_required';
  const message = unsupported || error === 'helper_unavailable' ? t('remoteDesktop.unsupported')
    : disabled || error === 'disabled' ? t('settings.remoteDesktop.disabled')
    : permission ? t('remoteDesktop.permissions')
    : error === 'permission_denied' ? t('remoteDesktop.denied')
    : error === 'runtime_changed' || capability.error?.message === 'runtime_changed' ? t('remoteDesktop.runtimeChanged')
    : error || capability.error || state === 'closed' ? t('remoteDesktop.failed')
    : t('remoteDesktop.connecting');
  return createPortal(
    <div ref={pageRef} tabIndex={-1} data-remote-desktop-page className="yuri-keyboard-inset-surface yuri-keyboard-inset-snap fixed inset-0 z-[150] overflow-hidden bg-background text-foreground outline-none">
      <main aria-label={instanceName ? `${t('remoteDesktop.title')} · ${instanceName}` : t('remoteDesktop.title')}
        className="absolute left-0 top-0 overflow-hidden bg-background"
        style={{ width: orientation.width, height: orientation.height, transformOrigin: 'top left',
          ...{
            '--desktop-safe-top': `env(safe-area-inset-${orientation.rotation === 90 ? 'right' : orientation.rotation === -90 ? 'left' : 'top'}, 0px)`,
            '--desktop-safe-right': `env(safe-area-inset-${orientation.rotation === 90 ? 'bottom' : orientation.rotation === -90 ? 'top' : 'right'}, 0px)`,
            '--desktop-safe-bottom': `env(safe-area-inset-${orientation.rotation === 90 ? 'left' : orientation.rotation === -90 ? 'right' : 'bottom'}, 0px)`,
            '--desktop-safe-left': `env(safe-area-inset-${orientation.rotation === 90 ? 'top' : orientation.rotation === -90 ? 'bottom' : 'left'}, 0px)`,
          },
          transform: orientation.rotation === 90 ? `translateX(${orientation.height}px) rotate(90deg)`
            : orientation.rotation === -90 ? `translateY(${orientation.width}px) rotate(-90deg)` : undefined }}>
      <div ref={viewportRef} className="absolute inset-0 touch-none overflow-hidden bg-background"
        aria-label={t('remoteDesktop.screen')}
        onPointerDown={event => {
          if (!live) return;
          event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
          flushMoves(); gestures.down(event.pointerId, point(event));
        }}
        onPointerMove={event => {
          if (!live || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          moves.current.set(event.pointerId, point(event));
          if (frameRef.current === null) frameRef.current = requestAnimationFrame(flushMoves);
        }}
        onPointerUp={event => {
          flushMoves(); gestures.up(event.pointerId, point(event));
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={event => { flushMoves(); gestures.up(event.pointerId, point(event), true); }}
        onLostPointerCapture={event => gestures.up(event.pointerId, point(event), true)}
        onContextMenu={event => event.preventDefault()}>
        <div ref={stageRef} className="absolute inset-0 origin-top-left will-change-transform">
          <video ref={videoRef} autoPlay muted playsInline className="pointer-events-none absolute inset-0 size-full object-contain" style={{ visibility: state === 'webrtc' ? 'visible' : 'hidden' }} />
          <img ref={imageRef} alt={t('remoteDesktop.screen')} draggable={false} className="pointer-events-none absolute inset-0 size-full object-contain" style={{ visibility: state === 'tunnel' ? 'visible' : 'hidden' }} />
        </div>
        {!live && <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center text-sm text-muted-foreground" role="status">
          {state === 'connecting' && !error && !capability.error && !unsupported && !disabled && <Icon name="loader-4" className="size-5 animate-spin" />}
          <p>{message}</p>
          {(state === 'closed' || capability.error || disabled) && !unsupported && error !== 'runtime_changed' && capability.error?.message !== 'runtime_changed' && <Button onClick={() => {
            stop(); setError(undefined); setState('connecting');
            if (capability.error || disabled) void capability.refetch(); else setAttempt(value => value + 1);
          }}>{t('remoteDesktop.retry')}</Button>}
        </div>}
      </div>
      <div className="pointer-events-none absolute left-[max(0.75rem,var(--desktop-safe-left))] right-[max(0.75rem,var(--desktop-safe-right))] top-[max(0.75rem,var(--desktop-safe-top))] flex items-start justify-between gap-3">
        <Button size="mobileIcon" variant="mobileGlass" className="pointer-events-auto opacity-60 hover:opacity-100 focus-visible:opacity-100"
          aria-label={t('header.actions.backAria')} onClick={() => mobileBackNavigationCoordinator.requestBrowserBack()}><Icon name="arrow-left" className="size-5" /></Button>
        <Button size="mobileIcon" variant="mobileGlass" className="pointer-events-auto opacity-60 hover:opacity-100 focus-visible:opacity-100"
          aria-label={t('remoteDesktop.rotate')} title={t('remoteDesktop.rotate')}
          onClick={() => { flushMoves(); gestures.reset(); setKeyboardOpen(false); orientation.toggle(); void requestDesktopOrientationPermission(); }}><Icon name="smartphone" className="size-5 rotate-45" /></Button>
      </div>
      <p className="sr-only">{t('remoteDesktop.hint')}</p>
      <div className="pointer-events-none absolute left-[max(0.75rem,var(--desktop-safe-left))] right-[max(0.75rem,var(--desktop-safe-right))] bottom-[max(0.75rem,var(--desktop-safe-bottom))] top-[calc(4rem+var(--desktop-safe-top))] flex flex-col items-end justify-end gap-3">
        {keyboardOpen && <div className="pointer-events-auto min-h-0 w-80 max-w-full overflow-y-auto overscroll-contain rounded-2xl border border-border/40 bg-[var(--surface-elevated)]/90 p-3 shadow-lg backdrop-blur-md">
        <form className="flex gap-2" onSubmit={event => {
          event.preventDefault(); if (text && live) { send({ type: 'text', text }); setText(''); }
        }}>
          <Input className="min-w-0" value={text} maxLength={1024} onChange={event => setText(event.target.value)} placeholder={t('remoteDesktop.text')} aria-label={t('remoteDesktop.text')} disabled={!live} autoComplete="off" />
          <Button type="submit" size="icon" disabled={!live || !text} aria-label={t('remoteDesktop.send')}><Icon name="send-plane-2" className="size-4" /></Button>
        </form>
        <div className="mt-2 flex flex-wrap gap-1">
          {['Escape', 'Tab', 'Backspace', 'Enter', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight'].map(key => (
            <Button key={key} size="xs" variant="ghost" disabled={!live} onClick={() => send({ type: 'key', key })} aria-label={t('remoteDesktop.pressKey', { key })}>
              {{ Escape: 'Esc', Backspace: '⌫', Enter: '↵', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓', ArrowRight: '→' }[key] ?? key}
            </Button>
          ))}
        </div>
        </div>}
        <div className="flex w-full shrink-0 items-end justify-between gap-3">
          <div className="pointer-events-auto flex gap-3">
            <Button size="mobileIcon" variant="mobileGlass" className="opacity-60 hover:opacity-100 focus-visible:opacity-100 aria-pressed:opacity-100 aria-pressed:ring-2 aria-pressed:ring-foreground/30"
              aria-label={t('remoteDesktop.drag')} title={t('remoteDesktop.drag')} aria-pressed={mode === 'drag'} disabled={!live}
              onClick={() => { flushMoves(); gestures.cancel(); setMode('drag'); }}><Icon name="hand" className="size-5" /></Button>
            <Button size="mobileIcon" variant="mobileGlass" className="opacity-60 hover:opacity-100 focus-visible:opacity-100 aria-pressed:opacity-100 aria-pressed:ring-2 aria-pressed:ring-foreground/30"
              aria-label={t('remoteDesktop.cursor')} title={t('remoteDesktop.cursor')} aria-pressed={mode === 'cursor'} disabled={!live}
              onClick={() => { flushMoves(); gestures.cancel(); setMode('cursor'); }}><Icon name="cursor" className="size-5" /></Button>
          </div>
          <Button size="mobileIcon" variant="mobileGlass" className="pointer-events-auto opacity-60 hover:opacity-100 focus-visible:opacity-100 aria-pressed:opacity-100 aria-pressed:ring-2 aria-pressed:ring-foreground/30"
            disabled={!live} aria-label={t('remoteDesktop.text')} title={t('remoteDesktop.text')} aria-pressed={keyboardOpen} aria-expanded={keyboardOpen}
            onClick={() => setKeyboardOpen(value => !value)}><Icon name="keyboard" className="size-5" /></Button>
        </div>
      </div>
      </main>
    </div>, document.body,
  );
}

export const RemoteDesktopPanel = React.memo(RemoteDesktopPanelImpl);
