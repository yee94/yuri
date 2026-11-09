# Contact message projection and desktop rows

`model.ts` owns `contactMessageFrom` and the `messagesFrom(payload, true)` adapter.
`Message.role` retains its existing Session-compatible meaning (`peer` remains
`user` there). Contact presentation must read the optional `Message.contact`:

```ts
{
  kind: 'user' | 'assistant' | 'peer';
  assistantID?: string;
  turnID?: string;
  bubbleIndex?: number;
  createdAt?: number;
  status?: string;
  fromAssistantID?: string | null;
  fromAssistantName?: string | null;
}
```

Only contact parsing sets this whitelist. A finite wire `createdAt` also becomes
`time.created`; neither ID nor read time supplies a missing clock. `contextRaw`
retains the original input object, `content` retains original contact parts, and
top-level text is authoritative, including an explicit empty string. With only
text parts, concatenation matches the Host/Web DTO (`join('')`). Files and cards
are not converted to prose. Error strings/objects remain available independently.
Contact history generation/revision are the actual page values, not inferred
from message status. No Session status is used as contact activity authority.

Finite ordinals order complete contact pages. Equal ordinals retain wire order;
if any row lacks a valid ordinal, preserve the whole page's supplied order rather
than ranking unpositioned records by ID or time. Opaque pagination and overlap
reconciliation remain in the existing history owner. Older overlap does not
overwrite newer message content or metadata. Stream updates spread the existing
message, so its contact identity and original projection remain intact. The
existing history merger already preserves the complete contact message; no
additional merge path or history-owner behavior is introduced.

## Existing List consumer

```ts
desktopContactMessageRows(messages, { locale, todayLabel, now })
```

The pure helper returns rows in input order with `message`, `kind`,
`alignment: 'left' | 'right'`, `showAvatar`, `sameAssistantRun`, `startsTurn`,
optional `separatorTimestamp`/`separatorLabel`, `errorRow`, and `visible`.
Non-contact messages produce no contact rows. The consumer must omit entire
`visible: false` rows; it must retain the original List, keys, source and scroll
owner. No new fetch, store, List, action or Session avatar is introduced here.

User bubbles align right; assistant and peer align left. Peers show their own
sender identity. Only the first assistant bubble in a contiguous same-turn run
shows an avatar, and a time separator starts a new run. Missing turn identity
does not prove a shared run. Internal settle-only/admitted previews and
superseded error rows follow `AssistantConversationSurface` filtering. Parts
remain the original message's body: this helper never rewrites Markdown, cards,
files, errors or peer names.

Separators and labels directly reuse Web `contactMessageTime.ts`:
`getContactTimeSeparators` and `createContactTimeFormatter`. They use the loaded
visible sequence, local calendar day, a strictly-greater-than-five-minute gap,
the caller's locale/Today label and the runtime's local timezone. Missing or
invalid contact timestamps produce no separator. The helper has linear work
in loaded messages/parts and no subscription or persistent cache.

## Validation boundary

Focused Vitest coverage includes real contact DTO fields, text/content/parts,
cards/files/errors, ordinary Session compatibility, order/ties, paging/overlap,
incremental content and status, run/avatar placement, hidden/error rows, and
locale/date/year/time-separator parity with the Web pure helper. This is data-only
evidence, not Mac/Windows native visual, timezone-engine, scrolling or real Host
acceptance. Main owns the production List/render integration.
