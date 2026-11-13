import type { ReactNode } from 'react';

export function UserMessageBubble({ isShellResult = false, children }: {
    isShellResult?: boolean;
    children: ReactNode;
}) {
    return (
        <div
            style={isShellResult ? undefined : {
                backgroundColor: 'var(--chat-user-message-bg)',
                borderRadius: 'var(--radius-xl)',
                borderBottomRightRadius: 'var(--radius-sm)',
            }}
            className={isShellResult ? 'min-w-0 text-left' : 'px-3 py-1.5 shadow-none'}
            data-user-message-bubble={isShellResult ? undefined : 'true'}
            data-shell-result={isShellResult ? 'true' : undefined}
        >
            {children}
        </div>
    );
}
