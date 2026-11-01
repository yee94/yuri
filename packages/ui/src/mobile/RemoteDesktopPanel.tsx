import * as React from 'react';
import { useEvent, useEventListener, useResizeObserver } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useI18n } from '@/lib/i18n';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { connectRemoteDesktop, type DesktopInput } from '@/lib/remote-desktop/connection';
import { createDesktopGestures, type DesktopViewport } from '@/lib/remote-desktop/gestures';
import { useRemoteDesktopCapability } from '@/queries/remoteDesktopQueries';

function RemoteDesktopPanelImpl({ onClose, instanceName }: { onClose: () => void; instanceName?: string }) {
  const { t } = useI18n();
  const [scope] = React.useState(() => ({ transport: getRuntimeTransportIdentity(), generation: getRuntimeGeneration() }));
  const capability = useRemoteDesktopCapability(scope.transport, scope.generation);
  const [attempt, setAttempt] = React.useState(0);
  const [state, setState] = React.useState<'connecting' | 'webrtc' | 'tunnel' | 'closed'>('connecting');
  const [error, setError] = React.useState<string>();
  const [scrollMode, setScrollMode] = React.useState(false);
  const [keyboardOpen, setKeyboardOpen] = React.useState(false);
  const [text, setText] = React.useState('');
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const stageRef = React.useRef<HTMLDivElement>(null);
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const imageRef = React.useRef<HTMLImageElement>(null);
  const geometry = React.useRef<DesktopViewport>({ width: 1, height: 1, remoteWidth: 1920, remoteHeight: 1080 });
  const connection = React.useRef<ReturnType<typeof connectRemoteDesktop> | null>(null);
  const frameRef = React.useRef<number | null>(null);
  const moves = React.useRef(new Map<number, { x: number; y: number }>());
  const send = useEvent((input: DesktopInput) => { connection.current?.send(input); });
  const getScrollMode = useEvent(() => scrollMode);
  const [gestures] = React.useState(() => createDesktopGestures({
    viewport: () => geometry.current,
    send,
    scrollMode: getScrollMode,
    apply: value => {
      if (stageRef.current) stageRef.current.style.transform = `translate(${value.x}px, ${value.y}px) scale(${value.scale})`;
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
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
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
  return (
    <MobileOverlayPanel open title={instanceName ? `${t('remoteDesktop.title')} · ${instanceName}` : t('remoteDesktop.title')}
      onClose={() => { stop(); onClose(); }} containedBody className="h-[calc(100dvh-0.75rem)] max-w-none" contentMaxHeightClassName="max-h-none">
      <div ref={viewportRef} className="relative min-h-0 flex-1 touch-none overflow-hidden bg-background"
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
      <div className="flex shrink-0 flex-col gap-2 border-t border-border/40 p-3">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="chip" className="min-w-0 max-w-[40%]" title={t('remoteDesktop.scroll')} aria-pressed={scrollMode} disabled={!live} onClick={() => { gestures.reset(); setScrollMode(value => !value); }}><span className="truncate">{t('remoteDesktop.scroll')}</span></Button>
          <Button size="sm" variant="ghost" className="min-w-0" onClick={() => gestures.reset()}><span className="truncate">{t('remoteDesktop.fit')}</span></Button>
          <span className="ml-auto hidden text-xs text-muted-foreground min-[480px]:inline">{live ? (state === 'webrtc' ? 'WebRTC' : t('remoteDesktop.tunnel')) : ''}</span>
          <Button size="icon" variant="ghost" className="ml-auto" disabled={!live} aria-label={t('remoteDesktop.text')} aria-pressed={keyboardOpen} onClick={() => setKeyboardOpen(value => !value)}><Icon name="keyboard" className="size-4" /></Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('remoteDesktop.hint')}</p>
        {keyboardOpen && <form className="flex gap-2" onSubmit={event => {
          event.preventDefault(); if (text && live) { send({ type: 'text', text }); setText(''); }
        }}>
          <Input value={text} maxLength={1024} onChange={event => setText(event.target.value)} placeholder={t('remoteDesktop.text')} aria-label={t('remoteDesktop.text')} disabled={!live} autoComplete="off" />
          <Button type="submit" size="icon" disabled={!live || !text} aria-label={t('remoteDesktop.send')}><Icon name="send-plane-2" className="size-4" /></Button>
        </form>}
        {keyboardOpen && <div className="flex flex-wrap gap-1">
          {['Escape', 'Tab', 'Backspace', 'Enter', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight'].map(key => (
            <Button key={key} size="xs" variant="ghost" disabled={!live} onClick={() => send({ type: 'key', key })} aria-label={t('remoteDesktop.pressKey', { key })}>
              {{ Escape: 'Esc', Backspace: '⌫', Enter: '↵', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓', ArrowRight: '→' }[key] ?? key}
            </Button>
          ))}
        </div>}
      </div>
    </MobileOverlayPanel>
  );
}

export const RemoteDesktopPanel = React.memo(RemoteDesktopPanelImpl);
