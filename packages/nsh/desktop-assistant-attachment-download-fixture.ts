import { host } from 'nsh';
import { createDesktopAssistantAttachmentDownload } from './desktop-files-download';

// Driven only by an isolated native harness. test.write supplies a private
// native-selected destination, never a JS filename/path grant or content bytes.
async function run() {
  const scenario = await host.call<string>('test.scenario', {});
  if (scenario !== 'saved' && scenario !== 'corrupt') throw new Error('unsupported_fixture_scenario');
  let leaked = false;
  const calls: string[] = [];
  const download = createDesktopAssistantAttachmentDownload(
    { hostID: 'synthetic', lease: '00000000-0000-4000-8000-000000000001' },
    { type: 'file', assistantID: 'bot.A-1', attachmentID: 'att_1', sha256: 'c1eafe9ccc8aa11567ed663d830cb685dd1a216e687d85cab426c1f609ce5826', size: 6, mime: 'application/octet-stream', filename: '附件.bin' },
    async <T>(name: string, input: Record<string, unknown>) => {
      calls.push(name);
      const response = await host.call<T>(name, input);
      if (/synthetic-token|chosen\.bin|partial-|"bytes"|"localPath"|"directory"|"path"/.test(JSON.stringify(response))) leaked = true;
      return response;
    },
    () => true, () => {}, { after: () => () => {} },
  );
  if (calls.length) throw new Error('eager_native_io');
  await download.probe();
  if (!download.state().available) throw new Error('assistant_download_capability_missing');
  await download.save();
  if (download.state().phase !== 'choosing') throw new Error('chooser_slot_unconfirmed');
  await host.call('test.write', {});
  await download.inspect();
  const state = download.state();
  if (state.phase !== (scenario === 'corrupt' ? 'error' : 'saved')) throw new Error('unexpected_native_receipt');
  if (scenario === 'corrupt' && (state.resumable || await download.resume() || await download.save())) throw new Error('integrity_failure_replayed');
  download.dispose();
  host.post('test.result', { phase: state.phase, received: state.received, total: state.total, leaked, saves: calls.filter(name => name.endsWith('.save')).length });
}
void run().catch(error => host.post('test.result', { error: String(error) }));
