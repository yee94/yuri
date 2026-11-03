import React from 'react';
import { useEvent, useResizeObserver } from '@reactuses/core';
import { ContextPanel } from './ContextPanel';

const PRIMARY_CHAT_MIN_WIDTH = 350;

export const ChatWorkspace: React.FC<React.PropsWithChildren<{ header?: React.ReactNode; footer?: React.ReactNode }>> = ({ children, header, footer }) => {
    const workspaceRef = React.useRef<HTMLDivElement>(null);
    const availableWidthRef = React.useRef(0);
    const reservedWidthRef = React.useRef(0);
    const hiddenRef = React.useRef(false);
    const [hidden, setHidden] = React.useState(false);

    const updateVisibility = useEvent(() => {
        if (availableWidthRef.current <= 0) return;
        const next = reservedWidthRef.current > 0
            && availableWidthRef.current - reservedWidthRef.current < PRIMARY_CHAT_MIN_WIDTH;
        if (next === hiddenRef.current) return;
        hiddenRef.current = next;
        setHidden(next);
    });
    const handleReservedWidthChange = useEvent((width: number) => {
        reservedWidthRef.current = width;
        updateVisibility();
    });
    const getMaxSplitWidth = useEvent(() => availableWidthRef.current - PRIMARY_CHAT_MIN_WIDTH);

    React.useLayoutEffect(() => {
        availableWidthRef.current = workspaceRef.current?.clientWidth ?? 0;
        updateVisibility();
    }, [updateVisibility]);
    useResizeObserver(workspaceRef, ([entry]) => {
        if (!entry) return;
        availableWidthRef.current = entry.contentRect.width;
        updateVisibility();
    });

    return (
        <div ref={workspaceRef} className="relative flex flex-1 min-h-0 min-w-0 overflow-hidden" data-page-scroll-lock="true" data-chat-area>
            <main
                className="flex flex-1 min-w-0 flex-col overflow-hidden bg-background relative"
                style={hidden ? { display: 'none' } : { minWidth: `min(${PRIMARY_CHAT_MIN_WIDTH}px, 100%)` }}
                inert={hidden || undefined}
                data-page-scroll-lock="true"
                data-primary-chat
            >
                {header}
                <div className="relative min-h-0 flex-1 overflow-hidden yuri-layout-divider-t" data-primary-chat-content>
                    {children}
                </div>
                {footer}
            </main>
            <ContextPanel onReservedWidthChange={handleReservedWidthChange} fillAvailableSpace={hidden} getMaxSplitWidth={getMaxSplitWidth} />
        </div>
    );
};
