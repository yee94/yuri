import * as React from 'react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { AssistantDTO } from '@/queries/assistantQueries';
import { AssistantContactMenu } from './AssistantContactMenu';
import { AssistantUnreadBadge } from './AssistantUnreadBadge';
import { AssistantWorkingAvatar } from './AssistantWorkingAvatar';
import { getAssistantPresentation } from './assistantPresentation';
import { useAssistantWorking } from './assistantWorking';

type AssistantPinnedContactsProps = {
  contacts: readonly AssistantDTO[];
  selectedAssistantID?: string | null;
  onSelect: (assistantID: string) => void;
  onEdit: (assistantID: string) => void;
  onDelete: (assistant: AssistantDTO) => void;
};

function PinnedContact({ assistant, selected, onSelect, onEdit, onDelete }: {
  assistant: AssistantDTO;
  selected: boolean;
} & Pick<AssistantPinnedContactsProps, 'onSelect' | 'onEdit' | 'onDelete'>) {
  const hoverTarget = React.useRef<HTMLButtonElement>(null);
  const working = useAssistantWorking(assistant.id, assistant.working);
  const displayName = getAssistantPresentation(assistant.name).displayName || assistant.name;
  return (
    <AssistantContactMenu
      assistant={assistant}
      doubleClickMiniChat
      onEdit={() => onEdit(assistant.id)}
      onDelete={() => onDelete(assistant)}
      trigger={(
        <button
          ref={hoverTarget}
          type="button"
          role="option"
          aria-selected={selected}
          title={displayName}
          data-assistant-pinned={assistant.id}
          data-mobile-press-feedback="soft"
          onClick={() => onSelect(assistant.id)}
          className={cn(
            'flex w-full min-w-0 max-w-28 flex-col items-center gap-2 rounded-2xl px-2 py-3 text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] active:bg-interactive-active motion-reduce:transition-none',
            selected ? 'bg-[var(--surface-muted)]' : 'hover:bg-interactive-hover',
          )}
        >
          <span className="relative">
            <AssistantWorkingAvatar name={assistant.id} avatarSeed={assistant.avatarSeed} size={64} label={displayName} working={working} hoverTarget={hoverTarget} />
            <AssistantUnreadBadge count={assistant.unreadCount ?? 0} className="absolute -right-1 -top-1" />
          </span>
          <span className="w-full truncate typography-ui-label font-medium leading-5">{displayName}</span>
        </button>
      )}
    />
  );
}

export function AssistantPinnedContacts({ contacts, selectedAssistantID, onSelect, onEdit, onDelete }: AssistantPinnedContactsProps) {
  const { t } = useI18n();
  if (contacts.length === 0) return null;
  return (
    <div role="group" aria-label={t('assistants.list.pinned')} className="yuri-assistant-pinned-contacts grid grid-cols-1 justify-items-center gap-2 pb-3 pt-2">
      {contacts.map((assistant) => (
        <PinnedContact key={assistant.id} assistant={assistant} selected={assistant.id === selectedAssistantID} onSelect={onSelect} onEdit={onEdit} onDelete={onDelete} />
      ))}
    </div>
  );
}
