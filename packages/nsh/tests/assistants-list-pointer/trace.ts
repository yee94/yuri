import { signal, untracked } from 'nsh';
import { pointerEvents, type PointerEvent } from '../assistants-pointer/trace';

export const pageEvents = ['load-start', 'snapshot-read', 'snapshot-apply', 'load-end', 'load-failed', 'page-reveal', 'viewability', 'card-created', 'pull-refresh', 'list-mode', 'row-mode', 'boot-ready', 'boot-failed', 'create', 'settings'] as const;
export type PageEvent = typeof pageEvents[number];
const events = signal<string[]>([]);
function append(event: string) { events.set([...events(), event].slice(-64)); }
export function recordPage(event: PageEvent) {
  untracked(() => {
    if (!pageEvents.includes(event)) throw Error('Unknown List pointer event');
    append('page/' + event);
  });
}
export function recordRow(event: PointerEvent, pinned: () => boolean) {
  untracked(() => {
    if (!pointerEvents.includes(event)) throw Error('Unknown row pointer event');
    append((pinned() ? 'pinned/' : 'normal/') + event);
  });
}
export const readListTrace = () => events();
export function resetListTrace() { untracked(() => events.set([])); }
