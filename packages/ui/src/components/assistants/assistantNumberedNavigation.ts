import { readAssistantSnapshot } from '@/queries/assistantQueries';
import { openAssistant } from '@/stores/useAssistantUIStore';
import { partitionAssistantContacts } from './sortAssistantContacts';

/** Number of `switch_assistant_N` shortcut actions. */
export const NUMBERED_ASSISTANT_SLOTS = 4;

/**
 * Open the Assistant contact in the given 1-based slot of the contact list as
 * rendered: the pinned contact first, then the rest by latest message.
 * Returns false when Assistants are unavailable or the slot is empty.
 */
export const activateNumberedAssistant = (slotNumber: number): boolean => {
  const snapshot = readAssistantSnapshot();
  if (!snapshot?.enabled) return false;
  const { pinned, unpinned } = partitionAssistantContacts(snapshot.assistants);
  const target = [...pinned, ...unpinned][slotNumber - 1];
  if (!target) return false;
  openAssistant(target.id);
  return true;
};
