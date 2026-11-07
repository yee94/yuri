import type { TurnActivityRecord } from '../../lib/turns/types';
import { isTaskToolName, readTaskToolSessionId } from './taskToolModel';
import { isSlimActivityPart } from '../../../../lib/slimActivityPart';

/** Child identity, not call count: resumed calls paint one face in first-seen order. */
export function activityTaskAvatarSeeds(parts: readonly TurnActivityRecord[]): { active: string[]; all: string[] } {
    const active = new Set<string>(), all = new Set<string>();
    for (const activity of parts) {
        if (activity.kind !== 'tool' || activity.part.type !== 'tool' || !isTaskToolName(activity.part.tool)) continue;
        const part = activity.part, id = typeof part.id === 'string' ? part.id.trim() : '';
        if (!id || !part.state || typeof part.state !== 'object') continue;
        const seed = readTaskToolSessionId(part) || id;
        all.add(seed);
        if (part.state.status === 'pending' || part.state.status === 'running') active.add(seed);
    }
    return { active: [...active], all: [...all] };
}

export function slimActivityMessageIds(parts: readonly TurnActivityRecord[]): string[] {
    return [...new Set(parts.filter(activity => isSlimActivityPart(activity.part)).map(activity => activity.messageId).filter(Boolean))];
}
