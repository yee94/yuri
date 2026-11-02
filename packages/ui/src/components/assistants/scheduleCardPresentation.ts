import type { useI18n } from '@/lib/i18n'
import type { ScheduledTask } from '@/lib/scheduledTasksApi'
import type { AssistantContactScheduleCardPart } from '@/queries/assistantDTO'

type Translate = ReturnType<typeof useI18n>['t']
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const isTime = (value: unknown): value is string => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
const isWeekday = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6

/** Only legacy snapshots require the existing assistant-scoped task lookup. */
export const needsScheduleCardDetails = (card: AssistantContactScheduleCardPart): boolean => {
  if (card.kind === 'cron') return card.cron === undefined
  if (card.kind === 'once') return card.date === undefined
  if (card.kind === 'weekly') return card.times === undefined || card.weekdays === undefined
  return card.kind === 'daily' && card.times === undefined
}

const isSchedule = (value: unknown): value is ScheduledTask['schedule'] => {
  if (!isRecord(value) || (value.timezone !== undefined && typeof value.timezone !== 'string')) return false
  if (value.kind === 'cron') return typeof value.cron === 'string' && Boolean(value.cron.trim())
  if (value.kind === 'once') return typeof value.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.date) && isTime(value.time)
  const hasTimes = Array.isArray(value.times) && value.times.length > 0 && value.times.every(isTime)
  if (value.kind === 'daily') return hasTimes || isTime(value.time)
  return value.kind === 'weekly' && (hasTimes || isTime(value.time))
    && Array.isArray(value.weekdays) && value.weekdays.length > 0 && value.weekdays.every(isWeekday)
}

/** Failed/deleted task lookups leave the stored card intact; nothing is persisted. */
export const resolveScheduleCard = (card: AssistantContactScheduleCardPart, task?: Record<string, unknown> | null): AssistantContactScheduleCardPart => {
  if (!needsScheduleCardDetails(card) || !isSchedule(task?.schedule)) return card
  const schedule = task.schedule
  return {
    ...card, kind: schedule.kind, time: schedule.time ?? schedule.times?.[0] ?? null,
    timezone: schedule.timezone ?? card.timezone,
    cron: schedule.cron ?? null, date: schedule.date ?? null,
    times: schedule.times ?? null, weekdays: schedule.weekdays ?? null,
  }
}

export const getScheduleCardPresentation = (card: AssistantContactScheduleCardPart, t: Translate) => {
  const kind = card.kind === 'daily' || card.kind === 'weekly' || card.kind === 'once' || card.kind === 'cron'
    ? t(`sessions.scheduledTasks.editor.scheduleType.${card.kind}`) : card.kind || ''
  const times = [...new Set((card.times?.length ? card.times : card.time ? [card.time] : []).filter(isTime))].sort()
  let value = times.join(', ')
  let cadence = kind
  let clock = times.length === 1
  if (card.kind === 'cron') {
    value = card.cron?.trim() || kind
    cadence = card.cron?.trim() ? kind : ''
    clock = false
  } else if (card.kind === 'once') {
    value = [card.date?.trim(), value].filter(Boolean).join(' ')
    clock = false
  } else if (card.kind === 'weekly' && card.weekdays?.length) {
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
    cadence = [...new Set(card.weekdays.filter(isWeekday))].sort((a, b) => a - b)
      .map((day) => t(`sessions.scheduledTasks.dialog.schedule.weekdayShort.${days[day]}`)).join(', ')
  }
  return { value: value || t('assistants.contact.card.schedule.timeUnavailable'), cadence, clock, timezone: card.timezone }
}
