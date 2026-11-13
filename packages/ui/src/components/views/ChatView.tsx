import React from 'react';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatErrorBoundary } from '@/components/chat/ChatErrorBoundary';
import { WorkStatusPanel } from '@/components/chat/work-status/WorkStatusPanel';
import { useWorkStatusVisibility, WORK_STATUS_PANEL_WIDTH, WORK_STATUS_SCROLLBAR_LANE } from '@/components/chat/work-status/useWorkStatusVisibility';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { cn } from '@/lib/utils';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useHostRuntime } from '@/contexts/HostRuntimeProvider';
import { useSessionNavigationStore } from '@/stores/useSessionNavigationStore';
import type { HostLocation } from '@/lib/remote-projects/location';
import { locationKey } from '@/lib/remote-projects/location';

const WorkStatusHost: React.FC<{
    sessionId: string | null;
    directory: string | null;
    visible: boolean;
    overlay?: boolean;
    publishVisible?: boolean;
}> = ({ sessionId, directory, visible, overlay = false, publishVisible = false }) => {
    const setWorkStatusPanelVisible = useUIStore((state) => state.setWorkStatusPanelVisible);
    React.useEffect(() => {
        if (!publishVisible) return undefined;
        setWorkStatusPanelVisible(visible);
        return () => setWorkStatusPanelVisible(false);
    }, [publishVisible, setWorkStatusPanelVisible, visible]);
    return (
        <WorkStatusPanel
            overlay={overlay}
            visible={visible}
            sessionId={sessionId}
            directory={directory}
        />
    );
};

type ChatViewProps = {
    readOnly?: boolean;
    active?: boolean;
    selectionOverride?: {
        sessionId: string | null;
        directory: string | null;
        viewKey: string;
        location?: HostLocation;
    };
};

export const ChatView: React.FC<ChatViewProps> = ({ readOnly = false, active = true, selectionOverride }) => {
    const host = useHostRuntime();
    const remoteSelection = useSessionNavigationStore((state) => state.remoteSession);
    const remoteLocation = selectionOverride?.location ?? (host?.entry.location.hostId ? host.entry.location : undefined);
    const explicitSession = selectionOverride ? {
        ...selectionOverride, active,
        ...(remoteLocation ? { location: remoteLocation,
            directory: selectionOverride.directory ?? remoteLocation.directory,
            sessionId: selectionOverride.sessionId || (remoteSelection && locationKey(remoteSelection.location) === locationKey(remoteLocation)
                ? remoteSelection.sessionId : null),
        } : {}),
    } : undefined;
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
    const isDraftOpen = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));
    const isDraftConversation = useSessionUIStore((state) => Boolean(
        state.newSessionDraft?.open && state.newSessionDraft.pendingUserMessage
        && (state.newSessionDraft.draftEstablishing || state.newSessionDraft.draftSubmitting)
    ));
    const effectiveDirectory = useEffectiveDirectory();
    const isMobile = useUIStore((state) => state.isMobile);
    const isExpandedInput = useUIStore((state) => state.isExpandedInput);
    const isVSCode = isVSCodeRuntime();
    const workStatusEnabled = useUIStore((state) => state.workStatusPanelEnabled);
    const workStatusOverlayOpen = useUIStore((state) => state.workStatusOverlayOpen);
    const setWorkStatusPanelFits = useUIStore((state) => state.setWorkStatusPanelFits);
    const matchingRemote = remoteLocation && remoteSelection
        && locationKey(remoteSelection.location) === locationKey(remoteLocation) ? remoteSelection : null;
    const sessionId = remoteLocation ? (explicitSession?.sessionId ?? matchingRemote?.sessionId ?? null)
        : selectionOverride?.sessionId ?? currentSessionId;
    const errorSessionId = sessionId;
    const directory = remoteLocation ? remoteLocation.directory
        : selectionOverride?.directory ?? currentSessionDirectory ?? effectiveDirectory ?? null;
    const stateKey = remoteLocation ? locationKey(remoteLocation) : directory;
    const { visible, fits, layoutAllows } = useWorkStatusVisibility({ isMobile, isVSCode, directory: stateKey });
    const hasConversation = remoteLocation ? Boolean(sessionId) : selectionOverride ? Boolean(selectionOverride.sessionId)
        : isDraftOpen ? isDraftConversation : Boolean(sessionId);
    const mountable = active && !isMobile && !isVSCode && !isExpandedInput && hasConversation;
    const showInline = mountable && visible;
    const showOverlay = mountable && workStatusEnabled && !fits && workStatusOverlayOpen;

    React.useEffect(() => {
        setWorkStatusPanelFits(mountable && fits);
        return () => setWorkStatusPanelFits(false);
    }, [fits, mountable, setWorkStatusPanelFits]);

    return (
        <div
            className={cn('relative h-full min-h-0 min-w-0', showInline && 'yuri-chat-work-status-inline')}
            style={showInline ? { ['--yuri-work-status-reserve' as string]: `${WORK_STATUS_PANEL_WIDTH + WORK_STATUS_SCROLLBAR_LANE}px` } : undefined}
        >
            <div className="absolute inset-0 min-h-0 min-w-0">
                <ChatErrorBoundary sessionId={errorSessionId || undefined}>
                    <ChatContainer readOnly={readOnly} active={active} explicitSession={explicitSession} />
                </ChatErrorBoundary>
            </div>
            {mountable && layoutAllows ? (
                <WorkStatusHost
                    publishVisible
                    visible={showInline}
                    sessionId={sessionId}
                    directory={directory}
                />
            ) : null}
            {mountable && workStatusEnabled && !fits ? (
                <WorkStatusHost
                    overlay
                    visible={showOverlay}
                    sessionId={sessionId}
                    directory={directory}
                />
            ) : null}
        </div>
    );
};
