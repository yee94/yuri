export type SubagentNotificationState = 'running' | 'completed' | 'error' | 'cancelled';

export type SubagentNotification = {
    sessionID: string;
    state: SubagentNotificationState;
    description?: string;
    body: string;
};

const readAttribute = (attributes: string, name: string): string | undefined => {
    const match = attributes.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'));
    return match?.[1].trim() || undefined;
};

/** A running report ends one execution period, not the child's outstanding work. */
export const parseSubagentNotification = (text: string | undefined): SubagentNotification | undefined => {
    if (typeof text !== 'string' || text.trim().length === 0) return undefined;
    const match = text.trim().match(/<subagent\s+([^>]*?)>([\s\S]*?)<\/subagent>/i);
    if (!match) return undefined;
    const sessionID = readAttribute(match[1], 'sessionID') ?? readAttribute(match[1], 'sessionId');
    const state = readAttribute(match[1], 'state');
    if (!sessionID || (state !== 'running' && state !== 'completed' && state !== 'error' && state !== 'cancelled')) return undefined;
    return { sessionID, state, description: readAttribute(match[1], 'description'), body: match[2].trim() };
};
