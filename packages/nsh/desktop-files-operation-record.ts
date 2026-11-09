import { desktopPanelFilePath, desktopPanelScopeKey, type DesktopPanelStoredScope } from './desktop-panel-model';
import { desktopFileChild, type DesktopFileCommand } from './desktop-files-operations';
import { resourceParent } from './resources-model';

export const DESKTOP_FILE_OPERATION_PREFIX = 'desktop-file-operation-v1:';
export type DesktopFileOperationRecord = { version: 1; scope: DesktopPanelStoredScope; command: Exclude<DesktopFileCommand, { kind: 'reveal' }>; phase: 'prepared' | 'confirmed' | 'rejected' };
export const desktopFileOperationRecordKey = (scope: DesktopPanelStoredScope) => DESKTOP_FILE_OPERATION_PREFIX + desktopPanelScopeKey({ ...scope, sessionID: null });
const exact = (value: unknown, keys: string[]) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.sort().join(',');
export function decodeDesktopFileOperationRecord(key: string, raw: string): DesktopFileOperationRecord {
  const v = JSON.parse(raw) as DesktopFileOperationRecord;
  if (!exact(v, ['version', 'scope', 'command', 'phase']) || v.version !== 1 || !['prepared', 'confirmed', 'rejected'].includes(v.phase) || !exact(v.scope, ['host', 'authorityKey', 'sessionID', 'directory']) || !exact(v.scope.host, ['hostID']) || typeof v.scope.host.hostID !== 'string' || typeof v.scope.authorityKey !== 'string' || typeof v.scope.directory !== 'string' || !(v.scope.sessionID === null || typeof v.scope.sessionID === 'string') || desktopFileOperationRecordKey(v.scope) !== key) throw new Error('desktop_file_operation_record_invalid');
  const c = v.command;
  if (!c || typeof c !== 'object') throw new Error('desktop_file_operation_record_invalid');
  if (c.kind === 'file' || c.kind === 'directory') {
    if (!exact(c, ['kind', 'parent', 'name']) || typeof c.parent !== 'string' || typeof c.name !== 'string') throw new Error('desktop_file_operation_record_invalid');
    desktopFileChild(v.scope.directory, c.parent, c.name);
  } else if ('path' in c && (c.kind === 'rename' || c.kind === 'delete')) {
    if (!exact(c, c.kind === 'rename' ? ['kind', 'path', 'name'] : ['kind', 'path']) || typeof c.path !== 'string' || desktopPanelFilePath(v.scope.directory, c.path) !== c.path) throw new Error('desktop_file_operation_record_invalid');
    if (c.kind === 'rename') { if (typeof c.name !== 'string') throw new Error('desktop_file_operation_record_invalid'); desktopFileChild(v.scope.directory, resourceParent(c.path, v.scope.directory)!, c.name); }
  } else throw new Error('desktop_file_operation_record_invalid');
  return v;
}
