import { host, mount, Storage } from 'nsh';
import { YuriNativeApp } from '../../application';
import { createHost, previewSession } from './host.js';

// UI-only development entry: no product Host, credentials, or real server writes.
const fixture = createHost();
host.available = () => true;
host.call = async function<T>(name: string, input: Record<string, unknown> = {}): Promise<T> {
  return await fixture.call(name, input) as T;
};
async function boot() {
  await Storage.setItem('desktop.navigation.v1', JSON.stringify({ version: 1, entries: [{
    partition: { connectionID: 'desktop-fixture', origin: 'https://host.example', authorizationID: 'synthetic-desktop-authorization' },
    target: { kind: 'new-session', projectID: 'desktop-project', directory: previewSession.directory },
  }] }));
  mount(YuriNativeApp);
}
void boot();
