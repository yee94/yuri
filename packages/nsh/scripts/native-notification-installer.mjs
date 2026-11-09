// Build artifacts only. Never invokes PowerShell, COM or registry APIs on the build machine.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export function notificationIdentity(appID) {
  if (typeof appID !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{1,127}$/.test(appID)) throw new Error('Invalid native application identity');
  // RFC 9562 UUIDv5, DNS namespace + actual product bundle ID; stable across versions/install paths.
  const namespace = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');
  const bytes = createHash('sha1').update(namespace).update(`${appID}.native-toast`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50; bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex');
  return { v: 1, aumid: appID, activatorCLSID: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` };
}
export async function writeNotificationInstaller(directory, appID) {
  const identity = notificationIdentity(appID);
  const script = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'install-native-notifications.ps1'), 'utf8');
  await writeFile(path.join(directory, 'native-notification-identity.json'), JSON.stringify(identity, null, 2));
  await writeFile(path.join(directory, 'Install-Notifications.ps1'), script);
}
