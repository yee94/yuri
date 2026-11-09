import { expect, test } from 'vitest';
import { notificationIdentity, writeNotificationInstaller } from './scripts/native-notification-installer.mjs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('actual application ID deterministically owns an update-stable native toast CLSID', () => {
  const identity=notificationIdentity('com.yee94.yuri.nsh');
  expect(notificationIdentity(identity.aumid)).toEqual(identity);
  expect(identity.activatorCLSID).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  expect(notificationIdentity('example.other.app').activatorCLSID).not.toBe(identity.activatorCLSID);
  expect(()=>notificationIdentity('bad"; command')).toThrow();
});
test('packaging only writes identity and explicit installer artifacts, never executes registration', async () => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'nsh-toast-artifact-'));
  try {
    await writeNotificationInstaller(directory,'com.yee94.yuri.nsh');
    expect((await readdir(directory)).sort()).toEqual(['Install-Notifications.ps1','native-notification-identity.json']);
    expect(JSON.parse(await readFile(path.join(directory,'native-notification-identity.json'),'utf8'))).toEqual(notificationIdentity('com.yee94.yuri.nsh'));
    const script=await readFile(path.join(directory,'Install-Notifications.ps1'),'utf8');
    expect(script).toContain('--notification-activation');expect(script).toContain('new Key(26)');expect(script).toContain('new Key(5)');
  } finally {await rm(directory,{recursive:true,force:true});}
});
