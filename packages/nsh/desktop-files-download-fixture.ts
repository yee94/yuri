import { host } from 'nsh';
import { createDesktopFileDownload } from './desktop-files-download';

async function run() {
  const scenario = await host.call<string>('test.scenario', {});
  const scope = { host: { hostID: 'synthetic', lease: '00000000-0000-4000-8000-000000000001' }, authorityKey: 'synthetic-authority', sessionID: 'session', directory: '/workspace' };
  let leaked = false, resumed = false, forgedRejected = 0, inspectedUnknown = false;
  const intent = { ownerID: 'forged_owner', requestID: 'forged_request', windowID: 'window', expectedHost: scope.host, directory: '/workspace', path: '/workspace/binary.bin' };
  for (const patch of [{ windowID: 'other_window' }, { path: '/private/outside' }, { token: 'forbidden' }, { url: 'https://outside.invalid/file' }, { destination: '/local/forbidden' }]) {
    try { await host.call('desktop.files.download.save', { ...intent, ...patch }); }
    catch { forgedRejected++; }
  }
  const download = createDesktopFileDownload(scope, async <T>(name: string, input: Record<string, unknown>) => {
    const response = await host.call<T>(name, input);
    if (JSON.stringify(response).match(/synthetic-token|chosen\.bin|partial-|"bytes"|"localPath"/)) leaked = true;
    return response;
  }, () => true, () => {}, { after: () => () => {} });
  await download.probe();
  if (!download.state().available) throw new Error('download_capability_missing');
  await download.save('binary.bin');
  for (let count = 0; count < 500; count++) {
    await new Promise<void>(resolve => setTimeout(resolve, 5));
    await download.inspect();
    const state = download.state();
    if (state.phase === 'unknown' || state.phase === 'checking') {
      inspectedUnknown = true;
      if (await download.resume() || await download.save('other.bin')) throw new Error('unknown_was_replayed');
      if (scenario === 'cancel-unknown' && state.phase === 'checking') {
        await download.cancel(); const cancelled = download.state(); download.dispose();
        host.post('test.result', { phase: cancelled.phase, received: cancelled.received, resumed, leaked, forgedRejected, inspectedUnknown }); return;
      }
    }
    if (state.phase === 'error' && state.resumable && !resumed) { resumed = true; await download.resume(); }
    if (state.phase === 'saved') { download.dispose(); host.post('test.result', { phase: state.phase, received: state.received, resumed, leaked, forgedRejected, inspectedUnknown }); return; }
  }
  throw new Error('download_driver_timeout');
}
void run().catch(error => host.post('test.result', { error: String(error) }));
