import React from 'react'
import { useEvent } from '@reactuses/core'
import { Icon } from '@/components/icon/Icon'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { AssistantContactScheduleCardPart } from '@/queries/assistantQueries'
import { openScheduledTask } from '@/lib/scheduledTaskNavigation'
import { CONTACT_CARD_COVER_CLASS, CONTACT_CARD_HEADER_CLASS, CONTACT_CARD_TITLE_CLASS, CONTACT_CARD_FOOTER_CLASS, activateContactCardOnKeyDown } from './contactCardChrome'
import { getScheduleCardPresentation, resolveScheduleCard } from './scheduleCardPresentation'

type AssistantScheduleCardProps = {
  card: AssistantContactScheduleCardPart
  task?: Record<string, unknown> | null
}

/**
 * Assistant-emitted card for a created scheduled task. Opens Scheduled Tasks.
 * Not a slash command.
 */
export const AssistantScheduleCard: React.FC<AssistantScheduleCardProps> = ({ card, task }) => {
  const { t } = useI18n()
  const title = card.name
  const schedule = getScheduleCardPresentation(resolveScheduleCard(card, task), t)
  const prompt = card.prompt?.trim()
  const openSchedule = useEvent(() => {
    openScheduledTask(card.projectID, card.taskID)
  })
  const onActivateKeyDown = useEvent((event: React.KeyboardEvent<HTMLElement>) => {
    activateContactCardOnKeyDown(event, openSchedule)
  })

  return (
    <article
      className={CONTACT_CARD_COVER_CLASS}
      role="button"
      tabIndex={0}
      aria-label={t('assistants.contact.card.schedule.aria', { name: title })}
      data-assistant-contact-card="schedule"
      onClick={openSchedule}
      onKeyDown={onActivateKeyDown}
    >
      <div className={CONTACT_CARD_HEADER_CLASS}>
        <span className="flex min-w-0 items-center gap-2 text-[0.8em] leading-4 text-muted-foreground">
          <Icon name="calendar" weight="medium" className="size-4 shrink-0" />
          <span className="truncate">{t('assistants.contact.card.schedule.label')}</span>
        </span>
        <Icon name="arrow-right-s" weight="medium" className="ml-auto size-4 shrink-0 text-muted-foreground" />
      </div>
      <h3 className={CONTACT_CARD_TITLE_CLASS} title={title}>{title}</h3>
      {prompt ? <p className="row-start-3 mt-1 min-w-0 truncate text-[0.8em] leading-4 text-muted-foreground" title={prompt}>{prompt}</p> : null}
      <div className={cn(CONTACT_CARD_FOOTER_CLASS, 'justify-end')}>
        <div data-contact-schedule-time="" className="flex min-w-0 flex-none items-baseline gap-1.5">
          {schedule.cadence ? <span data-contact-schedule-cadence="" className="min-w-0 max-w-[36%] flex-[0_1_auto] truncate text-[0.75em] leading-4 text-muted-foreground" title={schedule.cadence}>{schedule.cadence}</span> : null}
          <p className={`min-w-0 flex-[0_1_auto] truncate leading-[22px] text-foreground tabular-nums ${schedule.clock ? 'text-[1.25em] font-normal tracking-[-0.3px]' : 'text-[0.85em]'}`} title={schedule.value}>
            {schedule.value}
          </p>
        </div>
      </div>
    </article>
  )
}
