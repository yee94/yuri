import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useEvent, useEventListener, useLocalStorage } from '@reactuses/core';
import { toast } from 'sonner';
import { useMessageTTS } from '@/hooks/useMessageTTS';
import { useSessionMessages, useSessionMessagesResolved } from '@/sync/sync-context';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { acquireScreenAwake } from '@/lib/voice/screen-awake';
import { useI18n } from '@/lib/i18n';
import { AutoReadContext, AutoReadPlaybackContext, type RenderedReply } from './auto-read-context';
import { useRemoteChat } from '@/sync/remote-chat-context';
import type { Message } from '@/lib/opencode/v2-types';

type ProviderProps = {
    sessionId: string; directory?: string; active: boolean; children: ReactNode;
    remoteState?: NonNullable<ReturnType<typeof useRemoteChat>>;
    remote?: boolean;
};

export function MobileAutoReadProvider(props: ProviderProps) {
    const context = useRemoteChat();
    const remote = props.remoteState ?? context;
    return <AutoReadProvider {...props} remoteState={remote ?? undefined} />;
}

type MessageSource = { identity: string; resolved: boolean; getMessages(): Iterable<Message> };
type SourceProps = ProviderProps & { identity: string; onSource: (source: MessageSource) => void };

function LocalAutoReadSource(props: SourceProps) {
    const { identity, onSource } = props;
    const messages = useSessionMessages(props.sessionId, props.directory);
    const resolved = useSessionMessagesResolved(props.sessionId, props.directory);
    useLayoutEffect(() => onSource({ identity, resolved, getMessages: () => messages }), [identity, onSource, messages, resolved]);
    return null;
}

function RemoteAutoReadSource(props: SourceProps & { remoteState: NonNullable<ProviderProps['remoteState']> }) {
    const { identity, onSource } = props;
    const remote = props.remoteState;
    const scope = useMemo(() => remote.scope(props.sessionId), [remote, props.sessionId]);
    const subscribe = useMemo(() => (notify: () => void) => remote.repository.subscribe(scope, notify), [remote, scope]);
    const read = useMemo(() => () => remote.repository.hasSession?.(scope)
        || remote.repository.getRequestState?.(scope)?.status === 'ready'
        || remote.repository.getTranscript(scope).messageOrder.length > 0, [remote, scope]);
    const resolved = useSyncExternalStore(subscribe, read, read);
    const getMessages = useEvent(function* () {
        const transcript = remote.repository.getTranscript(scope);
        for (const id of transcript.messageOrder) yield transcript.messagesByID[id];
    });
    useLayoutEffect(() => onSource({ identity, resolved, getMessages }), [identity, onSource, resolved, getMessages]);
    return null;
}

function AutoReadProvider(props: ProviderProps) {
    const { sessionId, directory, active, children, remoteState } = props;
    const { t } = useI18n();
    const identity = JSON.stringify([remoteState?.entry.key ?? (props.remote ? 'remote-pending' : 'local'), remoteState?.entry.connectionGeneration, sessionId, directory]);
    const source = useRef<MessageSource | null>(null);
    const [sourceStatus, setSourceStatus] = useState<{ identity: string; resolved: boolean } | null>(null);
    const onSource = useEvent((next: MessageSource) => {
        source.current = next;
        setSourceStatus((previous) => previous?.identity === next.identity && previous.resolved === next.resolved ? previous : { identity: next.identity, resolved: next.resolved });
    });
    const [preference, setPreference] = useLocalStorage('yuri.auto-read', false);
    const preferred = preference === true;
    const [runtimeEpoch, setRuntimeEpoch] = useState(0);
    const [enabled, setEnabled] = useState(false);
    const [playingReply, setPlayingReply] = useState<RenderedReply | null>(null);
    const [visible, setVisible] = useState(document.visibilityState === 'visible');
    const speech = useMessageTTS({ enabled });
    const state = useRef({ enabled: false, generation: 0, floor: 0, seen: new Set<string>(), observed: new Set<string>(), pending: [] as RenderedReply[], playing: false });
    const audioUnlocked = useRef(false);
    const available = active && Boolean(sessionId) && sourceStatus?.identity === identity && sourceStatus.resolved;
    const stop = useEvent(() => {
        const current = state.current;
        current.enabled = false;
        current.generation += 1;
        current.pending = [];
        current.playing = false;
        current.seen.clear();
        current.observed.clear();
        audioUnlocked.current = false;
        speech.stop();
        setPlayingReply(null);
        setEnabled(false);
    });
    const drain = useEvent(() => {
        const current = state.current;
        if (!current.enabled || current.playing || !active || document.visibilityState !== 'visible') return;
        const next = current.pending.shift();
        if (!next) return;
        current.playing = true;
        setPlayingReply(next);
        const generation = current.generation;
        void speech.play(next.text, (error) => {
            if (generation !== current.generation) return;
            current.playing = false;
            setPlayingReply(null);
            if (error) { stop(); toast.error(t('mobile.menu.autoReadFailed')); return; }
            drain();
        }, { target: next.target });
    });
    const rendered = useEvent((reply: RenderedReply) => {
        const current = state.current;
        if (!current.enabled || !available || reply.sessionId !== sessionId || !reply.text.trim()
            || (reply.created < current.floor && !current.observed.has(reply.messageId)) || current.seen.has(reply.messageId)) return;
        current.seen.add(reply.messageId);
        current.pending.push(reply);
        drain();
    });
    const streaming = useEvent((sourceSessionId: string, messageId: string) => {
        if (state.current.enabled && available && sourceSessionId === sessionId) state.current.observed.add(messageId);
    });
    const toggle = useEvent(() => {
        if (preferred) { setPreference(false); stop(); return; }
        if (!available) return;
        setPreference(true);
        void speech.unlock().catch(() => {
            toast.error(t('mobile.menu.autoReadFailed'));
        });
    });
    const start = useEvent(() => {
        const current = state.current;
        current.floor = 0;
        current.seen = new Set();
        for (const message of source.current?.getMessages() ?? []) {
            current.floor = Math.max(current.floor, message.time.created);
            if (message.time.completed != null || message.role !== 'assistant') current.seen.add(message.id);
        }
        current.enabled = true;
        setEnabled(true);
    });
    useEffect(() => {
        stop();
        if (preferred && available) start();
        return stop;
    }, [sessionId, directory, identity, preferred, available, runtimeEpoch, start, stop]);
    useEffect(() => subscribeRuntimeEndpointChanged(() => {
        stop();
        setRuntimeEpoch((epoch) => epoch + 1);
    }), [stop]);
    const disable = useEvent(() => { setPreference(false); stop(); });
    useEventListener('pointerdown', () => {
        if (!state.current.enabled || audioUnlocked.current) return;
        audioUnlocked.current = true;
        const generation = state.current.generation;
        void speech.unlock().catch(() => {
            if (generation === state.current.generation) audioUnlocked.current = false;
        });
    }, document);
    useEventListener('visibilitychange', () => {
        setVisible(document.visibilityState === 'visible');
        if (document.visibilityState === 'visible') drain();
        else {
            state.current.generation += 1;
            state.current.playing = false;
            state.current.pending = [];
            speech.stop();
            setPlayingReply(null);
        }
    }, document);
    useEffect(() => {
        if (!enabled || !available || !visible) return;
        let disposed = false;
        let release: (() => Promise<void>) | undefined;
        void acquireScreenAwake().then((cleanup) => {
            if (disposed) void cleanup().catch(() => undefined);
            else release = cleanup;
        }).catch(() => {
            if (!disposed) toast.warning(t('mobile.menu.autoReadAwakeFailed'));
        });
        return () => { disposed = true; void release?.().catch(() => undefined); };
    }, [enabled, available, visible, sessionId, directory, identity, runtimeEpoch, t]);
    const context = useMemo(() => ({ enabled: preferred, available, toggle, rendered, streaming }), [preferred, available, toggle, rendered, streaming]);
    const playback = useMemo(() => enabled && active && visible && speech.isPlaying && playingReply?.sessionId === sessionId
        ? { sessionId, messageId: playingReply.messageId, stop: disable } : null,
    [enabled, active, visible, speech.isPlaying, playingReply, sessionId, disable]);
    return <AutoReadContext.Provider value={context}><AutoReadPlaybackContext.Provider value={playback}>
        {remoteState ? <RemoteAutoReadSource {...props} identity={identity} onSource={onSource} remoteState={remoteState} />
            : props.remote ? null : <LocalAutoReadSource {...props} identity={identity} onSource={onSource} />}
        {children}
    </AutoReadPlaybackContext.Provider></AutoReadContext.Provider>;
}

export function MobileAutoReadMenuItem({ children }: {
    children: (state: { enabled: boolean; available: boolean; toggle: () => void }) => ReactNode;
}) {
    const context = useContext(AutoReadContext);
    if (!context) return null;
    return children(context);
}
