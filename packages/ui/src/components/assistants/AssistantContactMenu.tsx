import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Icon } from '@/components/icon/Icon';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { useI18n } from '@/lib/i18n';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { updateAssistant, type AssistantDTO } from '@/queries/assistantQueries';
import { canOpenAssistantMiniChat, openAssistantMiniChat } from '@/lib/assistant-mini-chat';

type AssistantContactMenuProps = {
  assistant: AssistantDTO;
  trigger: React.ReactElement;
  onEdit: () => void;
  onDelete: () => void;
  doubleClickMiniChat?: boolean;
};

export function AssistantContactMenu({ assistant, trigger, onEdit, onDelete, doubleClickMiniChat = false }: AssistantContactMenuProps) {
  const { t } = useI18n();
  const pin = useMutation({
    mutationKey: [getRuntimeTransportIdentity(), 'assistants', assistant.id, 'pin'],
    mutationFn: () => updateAssistant(assistant, { pinned: assistant.pinnedAt == null }),
    onError: () => toast.error(t('assistants.menu.pinError')),
  });
  const openMiniChat = () => { void openAssistantMiniChat(assistant.id).catch(() => toast.error(t('miniChat.actions.failed'))); };
  const contactTrigger = trigger as React.ReactElement<{ onDoubleClick?: React.MouseEventHandler }>;

  return (
    <ContextMenu>
      <ContextMenuTrigger render={doubleClickMiniChat ? React.cloneElement(contactTrigger, {
        onDoubleClick: (event) => {
          contactTrigger.props.onDoubleClick?.(event);
          if (!event.defaultPrevented && canOpenAssistantMiniChat()) openMiniChat();
        },
      }) : trigger} />
      <ContextMenuContent className="min-w-[10rem]">
        {assistant.pinnedAt !== undefined ? (
          <ContextMenuItem disabled={pin.isPending} onClick={() => pin.mutate()}>
            <Icon name={assistant.pinnedAt == null ? 'pushpin-2' : 'unpin'} className="size-4" />
            {t(assistant.pinnedAt == null ? 'assistants.menu.pin' : 'assistants.menu.unpin')}
          </ContextMenuItem>
        ) : null}
        {canOpenAssistantMiniChat() ? (
          <ContextMenuItem onClick={openMiniChat}>
            <Icon name="external-link" className="size-4" />
            {t('sessions.sidebar.session.menu.openMiniChatWindow')}
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem onClick={onEdit}>
          <Icon name="edit" className="size-4" />
          {t('assistants.menu.edit')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onDelete} className="text-[var(--status-error)] focus:text-[var(--status-error)] data-[highlighted]:text-[var(--status-error)]">
          <Icon name="delete-bin" className="size-4 text-inherit" />
          {t('assistants.settings.delete')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
