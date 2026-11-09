import type { DesktopJournalStorage } from './desktop-files-journal';
import type { DesktopPanelScope } from './desktop-panel-model';
import type { DesktopFileCommand } from './desktop-files-operations';
import { decodeDesktopFileOperationRecord, desktopFileOperationRecordKey, DESKTOP_FILE_OPERATION_PREFIX, type DesktopFileOperationRecord } from './desktop-files-operation-record';

/** Same private native snapshot as document buffers; distinct exact-schema keys.
 * A prepared intent is treated as unknown on cold start, never automatically sent.
 */
export function createDesktopFileOperationJournal(storage: DesktopJournalStorage, notify: () => void) {
  const records = new Map<string, DesktopFileOperationRecord>();
  let hydrated = false, error = '';
  const fail = (cause: unknown) => { error = cause instanceof Error ? cause.message : String(cause); notify(); return false; };
  async function restore() {
    if (hydrated) return true;
    try {
      const keys = (await storage.keys()).filter(key => key.startsWith(DESKTOP_FILE_OPERATION_PREFIX));
      if (keys.length > 20) throw new Error('desktop_file_operations_capacity');
      const restored = new Map<string, DesktopFileOperationRecord>();
      for (const key of keys) { const raw = await storage.getItem(key); if (raw === null) throw new Error('desktop_file_operation_restore_changed'); restored.set(key, decodeDesktopFileOperationRecord(key, raw)); }
      for (const [key, record] of restored) records.set(key, record);
      hydrated = true; error = ''; notify(); return true;
    } catch (cause) { return fail(cause); }
  }
  const ready = restore();
  return { ready, restore, records: () => [...records.values()], state: () => ({ hydrated, error }),
    bind(scope: DesktopPanelScope) {
      const key = desktopFileOperationRecordKey(scope);
      async function persist(record: DesktopFileOperationRecord) {
        records.set(key, record);
        try {
          if (!hydrated || !storage.sync) throw new Error('desktop_journal_durable_checkpoint_unavailable');
          const raw = JSON.stringify(record); decodeDesktopFileOperationRecord(key, raw);
          await storage.setItem(key, raw); await storage.sync(); error = ''; notify(); return true;
        } catch (cause) { return fail(cause); }
      }
      return {
        async start(command: DesktopFileCommand) {
          if (command.kind === 'reveal') return true;
          return persist({ version: 1, scope: { host: { hostID: scope.host.hostID }, authorityKey: scope.authorityKey, sessionID: scope.sessionID, directory: scope.directory }, command, phase: 'prepared' });
        },
        async settle(phase: 'confirmed' | 'rejected') { const record = records.get(key); return record ? persist({ ...record, phase }) : false; },
        async clear() {
          try {
            if (!storage.sync) throw new Error('desktop_journal_durable_checkpoint_unavailable');
            await storage.recover?.(); await storage.removeItem(key); await storage.sync();
            records.delete(key); error = ''; notify(); return true;
          } catch (cause) { return fail(cause); }
        },
        async recover() { try { await storage.recover?.(); return true; } catch (cause) { return fail(cause); } },
      };
    },
  };
}
