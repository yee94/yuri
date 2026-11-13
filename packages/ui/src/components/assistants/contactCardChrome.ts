import type { KeyboardEvent } from 'react'

/** Shared contact-card geometry. Whole card is the hit target. */
const CONTACT_CARD_CHROME_CLASS = [
  'grid h-[calc(148px*var(--padding-scale,1))] w-[19rem] min-w-0 max-w-full shrink-0 grid-rows-[calc(40px*var(--padding-scale,1))_calc(20px*var(--padding-scale,1))_calc(20px*var(--padding-scale,1))_calc(48px*var(--padding-scale,1))] content-start cursor-pointer rounded-[var(--contact-bubble-radius,1.125rem)] bg-[var(--assistant-panel-background,var(--surface-muted))]',
  'px-4 py-2.5 text-left typography-ui-label transition-colors duration-150 motion-reduce:transition-none',
  'hover:bg-[color-mix(in_srgb,var(--assistant-panel-background,var(--surface-muted))_94%,black)]',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
].join(' ')

/** All three types share the same frame, including short and incomplete records. */
export const CONTACT_CARD_COVER_CLASS = CONTACT_CARD_CHROME_CLASS

/** Retain the session entry point while sharing the contact-card size contract. */
export const CONTACT_SESSION_CARD_COVER_CLASS = CONTACT_CARD_CHROME_CLASS

export const CONTACT_CARD_HEADER_CLASS = 'row-start-1 mb-2 flex h-8 min-w-0 items-center gap-2'
export const CONTACT_CARD_TITLE_CLASS = 'row-start-2 min-w-0 self-start truncate font-medium leading-5 text-foreground'
export const CONTACT_CARD_FOOTER_CLASS = 'row-start-4 flex h-12 min-w-0 flex-col justify-center'

export function activateContactCardOnKeyDown(
  event: KeyboardEvent<HTMLElement>,
  activate: () => void,
): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  activate()
}
