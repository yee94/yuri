import React from 'react'
import { useEvent } from '@reactuses/core'
import { Icon } from '@/components/icon/Icon'
import { useI18n } from '@/lib/i18n'
import { isIPadApp } from '@/lib/platform'
import { useMobileAppActions } from '@/apps/mobileAppContext'
import { useMobileNavigationStore } from '@/mobile/useMobileNavigationStore'
import type { AssistantContactAssistantCardPart, AssistantDTO } from '@/queries/assistantQueries'
import { AssistantWorkingAvatar } from './AssistantWorkingAvatar'
import { ContactCardModelLine } from './ContactCardModelLine'
import { cn } from '@/lib/utils'
import { openAssistant } from '@/stores/useAssistantUIStore'
import { CONTACT_CARD_COVER_CLASS, CONTACT_CARD_HEADER_CLASS, CONTACT_CARD_TITLE_CLASS, CONTACT_CARD_FOOTER_CLASS, activateContactCardOnKeyDown } from './contactCardChrome'

type AssistantAssistantCardProps = {
  card: AssistantContactAssistantCardPart
  assistant?: Pick<AssistantDTO, 'avatarSeed' | 'working' | 'activeContactTurn'>
  active?: boolean
}

/**
 * Assistant-emitted card for a newly created contact. Opens that assistant.
 * Not a slash command.
 */
export const AssistantAssistantCard: React.FC<AssistantAssistantCardProps> = ({ card, assistant, active = true }) => {
  const { t } = useI18n()
  const mobileActions = useMobileAppActions()
  const isPhoneShell = Boolean(mobileActions && !isIPadApp())
  const title = card.name
  const metadata = `${card.providerID}/${card.modelID}`
  const openContact = useEvent(() => {
    if (isPhoneShell) {
      useMobileNavigationStore.getState().openAssistant(card.assistantID)
      return
    }
    openAssistant(card.assistantID)
  })
  const onActivateKeyDown = useEvent((event: React.KeyboardEvent<HTMLElement>) => {
    activateContactCardOnKeyDown(event, openContact)
  })

  return (
    <article
      className={CONTACT_CARD_COVER_CLASS}
      role="button"
      tabIndex={0}
      aria-label={t('assistants.contact.card.assistant.aria', { name: title })}
      data-assistant-contact-card="assistant"
      onClick={openContact}
      onKeyDown={onActivateKeyDown}
    >
      <div className={CONTACT_CARD_HEADER_CLASS}>
        <span className="relative inline-block shrink-0 leading-none" aria-hidden>
          <AssistantWorkingAvatar name={card.assistantID} avatarSeed={assistant?.avatarSeed} size={32} working={active ? Boolean(assistant?.working || assistant?.activeContactTurn) : undefined} showWorkingDot={false} followPointer={false} />
        </span>
        <span className="min-w-0 truncate text-[0.8em] leading-4 text-muted-foreground">{t('assistants.contact.card.assistant.label')}</span>
        <Icon name="arrow-right-s" weight="medium" className="ml-auto size-4 shrink-0 text-muted-foreground" />
      </div>
      <h3 className={cn(CONTACT_CARD_TITLE_CLASS, 'row-span-2 self-center')} title={title}>{title}</h3>
      <div className={cn(CONTACT_CARD_FOOTER_CLASS, 'justify-end pb-1')}>
        <div className="flex h-4 min-w-0 items-center"><ContactCardModelLine value={metadata} /></div>
      </div>
    </article>
  )
}
