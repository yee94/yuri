import { createNativeComposerCommandRouter, type NativeCommandActions, type NativeCommandSnapshot } from './composer-command-router';
import { acceptBtwIntent, type BtwOwner } from './chat-btw-model';
import type { ScopedReferenceDocument } from './composer-references';

/** Actual Chat candidate/send boundary; the main-send owner runs only on `pass`. */
export function createChatComposerCommands(options: {
  read: () => NativeCommandSnapshot | null;
  write: (document: ScopedReferenceDocument, expected: NativeCommandSnapshot) => boolean;
  btw: () => BtwOwner | null;
  openNewDraft: () => void;
  openModel: () => void;
  openTimeline: () => void;
  actions?: NativeCommandActions;
  notify: (key: 'chat.btw.plainTextRequired' | 'chat.btw.sessionRequired' | 'common.unavailable') => void;
}) {
  return createNativeComposerCommandRouter({ read: options.read, write: options.write,
    actions: {
      ...options.actions,
      new: options.openNewDraft,
      model: options.openModel,
      timeline: options.openTimeline,
      btw: intent => {
        const owner = options.btw();
        if (!owner || !intent.current()) return false;
        const result = acceptBtwIntent(owner, { question: intent.argument }, intent.snapshot.document.references.length > 0);
        if (result === 'plainTextRequired') options.notify('chat.btw.plainTextRequired');
        return result === 'accepted';
      },
    },
    notify: notice => options.notify(notice === 'plain-text-required' ? 'chat.btw.plainTextRequired' : notice === 'session-required' ? 'chat.btw.sessionRequired' : 'common.unavailable'),
  });
}
