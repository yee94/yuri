import type { Row } from './model';
import { settingsObject, settingsRows, type SettingsRequest } from './settings-protocol';

export type NativeSavedPermission = { id: string; projectID: string; action: string; resource: string };
export type NativeSavedPermissionSnapshot = { directory: string; projectID: string; items: NativeSavedPermission[] };

/** Native SDK gap for permission-saved-api: captured location -> project -> rules. */
export async function readNativeSavedPermissions(send: SettingsRequest, directory: string, current: () => boolean): Promise<NativeSavedPermissionSnapshot> {
  if (!directory.trim() || !current()) throw new Error('Saved permission scope required');
  const location = settingsObject(await send(`/api/location?location%5Bdirectory%5D=${encodeURIComponent(directory)}`));
  if (!current()) throw new Error('Runtime changed');
  const projectID = settingsObject(location.project).id;
  if (typeof projectID !== 'string' || !projectID) throw new Error('Saved permission project required');
  const payload = await send(`/api/permission/saved?projectID=${encodeURIComponent(projectID)}`);
  if (!current()) throw new Error('Runtime changed');
  const rows = settingsRows(Array.isArray(payload) ? payload : settingsObject(payload).data);
  const items = rows.map((row: Row): NativeSavedPermission => {
    if (['id', 'projectID', 'action', 'resource'].some(key => typeof row[key] !== 'string' || !row[key]) || row.projectID !== projectID) throw new Error('Invalid saved permission scope or rule');
    return { id: String(row.id), projectID, action: String(row.action), resource: String(row.resource) };
  });
  return { directory, projectID, items };
}

/** No optimistic removal; failed DELETE retains the exact visible snapshot. */
export async function deleteNativeSavedPermission(send: SettingsRequest, snapshot: NativeSavedPermissionSnapshot, id: string, current: () => boolean): Promise<NativeSavedPermissionSnapshot> {
  if (!current() || !snapshot.directory || !snapshot.projectID || !snapshot.items.some(item => item.id === id && item.projectID === snapshot.projectID)) throw new Error('Saved permission is outside the captured scope');
  const result = await send(`/api/permission/saved/${encodeURIComponent(id)}`, 'DELETE');
  if (!current()) throw new Error('Runtime changed');
  if (result != null && result !== true) settingsObject(result);
  return { ...snapshot, items: snapshot.items.filter(item => item.id !== id) };
}
