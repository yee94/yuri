import * as React from 'react';

import { ProceduralAssistantAvatar } from '@/components/assistants/ProceduralAssistantAvatar';
import { partitionAssistantContacts } from '@/components/assistants/sortAssistantContacts';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useAssistantSnapshotQuery, type AssistantSnapshot } from '@/queries/assistantQueries';

import { useMobileNavigationStore } from '../useMobileNavigationStore';

const selectScheduleAssistant = (snapshot: AssistantSnapshot) => {
  if (!snapshot.enabled) return null;
  const assistant = partitionAssistantContacts(snapshot.assistants).pinned[0] ?? snapshot.assistants[0];
  return assistant ? { id: assistant.id, name: assistant.name, seed: assistant.avatarSeed ?? assistant.id } : null;
};

function ScheduleAssistantButton({ assistant }: { assistant: NonNullable<ReturnType<typeof selectScheduleAssistant>> }) {
  const { t } = useI18n();
  const [visiting, setVisiting] = React.useState(true);

  return (
    <span className="yuri-mobile-schedule-assistant-anchor">
      <Button
        type="button"
        variant="ghost"
        size="mobileIcon"
        className="yuri-mobile-schedule-assistant"
        data-visiting={visiting ? 'true' : 'false'}
        aria-label={t('sessions.scheduledTasks.assistant.openAria', { name: assistant.name })}
        onClick={() => useMobileNavigationStore.getState().openAssistant(assistant.id)}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget && event.animationName === 'yuri-schedule-assistant-clip') {
            setVisiting(false);
          }
        }}
      >
        <span className="yuri-mobile-schedule-assistant-face" aria-hidden="true">
          <ProceduralAssistantAvatar
            seed={assistant.seed}
            size={40}
            motion="idle"
            followPointer={false}
            animationKey={assistant.id}
            blinkOnMount={2}
          />
        </span>
        <span className="yuri-mobile-schedule-assistant-label" aria-hidden="true">
          {t('sessions.scheduledTasks.assistant.offer')}
        </span>
      </Button>
    </span>
  );
}

function ScheduleAssistantContact() {
  const { data: assistant } = useAssistantSnapshotQuery(selectScheduleAssistant);
  return assistant ? <ScheduleAssistantButton key={assistant.id} assistant={assistant} /> : null;
}

export const MobileScheduleAssistantHint = React.memo(function MobileScheduleAssistantHint({ active }: { active: boolean }) {
  const pageActive = useMobileNavigationStore((state) => state.activeTab === 'scheduled' && state.secondary === null);
  return active && pageActive ? <ScheduleAssistantContact /> : null;
});
