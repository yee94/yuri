import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useBackgroundTaskCount } from '@/sync/sync-context';
import type { TurnActivityRecord } from '../lib/turns/types';
import { collectBackgroundWorkScope } from './parts/sessionBackgroundModel';
import type { BackgroundTaskScope } from '@/sync/session-activity';

const LiveBackgroundActivityHint = ({ sessionId, scope }: { sessionId: string; scope: BackgroundTaskScope }) => {
    const { t } = useI18n();
    const count = useBackgroundTaskCount(sessionId, scope);
    if (count === 0) return null;
    return (
        <span
            className="inline-flex h-3.5 shrink-0 items-center whitespace-nowrap text-[11px] leading-none font-normal text-muted-foreground"
            data-background-activity="true">
            <span className="animate-text-shimmer">{t('chat.sessionBackground.tasksRunning', { count })}</span>
        </span>
    );
};

export const BackgroundActivityHint = React.memo(({ sessionId, activityParts }: {
    sessionId: string;
    activityParts?: readonly TurnActivityRecord[];
}) => {
    const scope = React.useMemo(() => collectBackgroundWorkScope((activityParts ?? []).map(activity => activity.part)), [activityParts]);
    if (scope.childSessionIDs.size === 0 && scope.shellIDs.size === 0) return null;
    return <LiveBackgroundActivityHint sessionId={sessionId} scope={scope} />;
});

BackgroundActivityHint.displayName = 'BackgroundActivityHint';
