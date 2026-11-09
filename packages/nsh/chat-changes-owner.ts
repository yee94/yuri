import { computed, effect, signal, untracked } from 'nsh';
import { captureHostRequest } from './state';
import { createPageOperations } from './page-operations';
import { createChangesReader, type ChangesSource } from './chat-changes-model';
import { createChangesDraft } from './chat-changes-generation';

/** One reader per admitted page operation; display continuity is not read authority. */
export function createChangesOwner(source: ChangesSource, current: () => boolean) {
  const operations = createPageOperations(current);
  const draft = createChangesDraft();
  const revision = signal(0);
  let reader = createChangesReader(source, captureHostRequest(), () => false);
  const selectedReader = signal(reader);
  let retained: ReturnType<typeof reader.state>['snapshot'] = null;
  effect(() => {
    const lane = operations.operation();
    untracked(() => {
      retained = reader.state().gitRepository === false ? null : reader.state().snapshot ?? retained; reader.cancel();
      reader = createChangesReader(source, lane?.request ?? (() => Promise.reject(new Error('page_operation_stale'))), () => lane?.current() === true && current(), () => revision.set(revision() + 1));
      selectedReader.set(reader);
      revision.set(revision() + 1);
      if (lane?.current()) {
        void reader.refresh();
        if (source.path) void reader.select(source.path, source.kind === 'workspace' && source.staged === true);
      }
    });
  });
  const state = () => { operations.operation(); revision(); const next = reader.state(); return { ...next, snapshot: next.gitRepository === false ? null : next.snapshot ?? retained }; };
  const snapshot = computed(() => state().snapshot);
  return { get reader() { return selectedReader(); }, state, snapshot, draft };
}
