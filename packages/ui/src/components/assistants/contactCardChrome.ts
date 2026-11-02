import type { KeyboardEvent } from 'react'

/** Shared contact-card geometry. Whole card is the hit target. */
const CONTACT_CARD_CHROME_CLASS = [
  'flex h-40 w-[19rem] min-w-0 max-w-full shrink-0 flex-col cursor-pointer rounded-[1.35rem] bg-[var(--surface-muted)]',
  'px-4 py-2.5 text-left typography-ui-label transition-colors duration-150 motion-reduce:transition-none',
  'hover:bg-interactive-hover/45',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
].join(' ')

/** All three types share the same frame, including short and incomplete records. */
export const CONTACT_CARD_COVER_CLASS = CONTACT_CARD_CHROME_CLASS

/** Retain the session entry point while sharing the contact-card size contract. */
export const CONTACT_SESSION_CARD_COVER_CLASS = CONTACT_CARD_CHROME_CLASS

export const CONTACT_CARD_HEADER_CLASS = 'mb-2 flex h-8 shrink-0 items-center gap-2'
export const CONTACT_CARD_TITLE_CLASS = 'min-w-0 truncate font-medium leading-5 text-foreground'
export const CONTACT_CARD_FOOTER_CLASS = 'mt-auto flex h-10 min-w-0 shrink-0 flex-col justify-center'

export function activateContactCardOnKeyDown(
  event: KeyboardEvent<HTMLElement>,
  activate: () => void,
): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  activate()
}
