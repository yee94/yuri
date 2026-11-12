import React from 'react';
import { cn } from '@/lib/utils';

export function DraftComposerFoot({ isMobile, expanded, compact, children }: {
    isMobile: boolean;
    expanded: boolean;
    compact: boolean;
    children: React.ReactNode;
}) {
    return <div className={cn('relative z-10 flex min-h-0',
        isMobile && 'yuri-mobile-composer-foot',
        expanded ? 'flex-1 bg-background' : compact ? 'bg-background px-0'
            : 'flex-1 items-center justify-center bg-background px-0 pb-[6vh]',
    )}>{children}</div>;
}

export const DesktopComposerEdgeFade: React.FC = () => (
    <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-full z-0 h-11 bg-gradient-to-t from-[var(--surface-background)] to-transparent"
    />
);

export function ComposerFoot({ isMobile, expanded, overlay = true, children }: {
    isMobile: boolean;
    expanded: boolean;
    overlay?: boolean;
    children: React.ReactNode;
}) {
    return <div className={cn('relative z-10',
        isMobile && 'yuri-mobile-composer-foot',
        isMobile && overlay && 'yuri-mobile-composer-foot--overlay',
        expanded ? 'flex-1 min-h-0 bg-background' : 'bg-background',
    )}>
        {!isMobile && !expanded && overlay ? <DesktopComposerEdgeFade /> : null}
        {React.Children.toArray(children)}
    </div>;
}
