/** Exact in-memory wire for production-root fixtures, NOT native disk evidence. */
export const desktopJournalMethods = ['desktop.files.journal.snapshot', 'desktop.files.journal.commit', 'desktop.files.journal.sync'];
export function createDesktopJournalHost() {
  let version = 0, requestID = null, records = {};
  const calls = [];
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const exact = (value, keys) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
  const snapshot = () => ({ status: 'ready', version, requestID, records: { ...records } });
  const denied = code => ({ status: 'denied', code });
  const handlers = {
    'desktop.files.journal.snapshot': input => {
      if (!exact(input, [])) throw new Error('Unexpected synthetic journal snapshot payload');
      calls.push({ method: 'snapshot', input }); return snapshot();
    },
    'desktop.files.journal.commit': input => {
      if (!exact(input, ['expectedVersion', 'requestID', 'records']) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
        || typeof input.requestID !== 'string' || !/^[\w-]{1,128}$/.test(input.requestID) || !object(input.records)
        || Object.entries(input.records).some(([key, value]) => !/^desktop-file-(?:journal|operation)-v1:/.test(key) || typeof value !== 'string')) throw new Error('Unexpected synthetic journal commit payload');
      calls.push({ method: 'commit', input });
      if (input.expectedVersion !== version || Object.keys(input.records).length > 20) return denied('file_journal_owner_conflict');
      version++; requestID = input.requestID; records = { ...input.records }; return snapshot();
    },
    'desktop.files.journal.sync': input => {
      if (!exact(input, ['version', 'requestID']) || !Number.isSafeInteger(input.version) || input.version < 0
        || !(input.requestID === null || typeof input.requestID === 'string' && /^[\w-]{1,128}$/.test(input.requestID))) throw new Error('Unexpected synthetic journal sync payload');
      calls.push({ method: 'sync', input });
      return input.version === version && input.requestID === requestID ? snapshot() : denied('file_journal_not_committed');
    },
  };
  return { handlers, calls, snapshot };
}
