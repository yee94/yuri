import { acquireMobileHtmlNetwork } from '../../ui/src/lib/preview/mobile-html-network';
import { resolveMobileHtmlUrl } from '../../ui/src/lib/preview/mobile-html-source';
import { prepareMobileGuiNetwork } from '../../ui/src/lib/gui-plugins/mobile-network-bridge';

const report = (value: string) => { (window as unknown as { guiProbeLog: string[] }).guiProbeLog.push(value); };
(window as unknown as { guiProbeLog: string[] }).guiProbeLog = [];
const check = (value: unknown, name: string) => { if (!value) throw new Error(name); report(name); };
async function run() {
  const controller = new AbortController();
  let failed = false;
  const target = window.guiProbe.target;
  await prepareMobileGuiNetwork();
  if (window.guiProbe.prewarm) await fetch(`${target}/prewarm`);
  const lease = await acquireMobileHtmlNetwork(controller.signal, () => { failed = true; report('relay_failed'); });
  const guiOwner = await acquireMobileHtmlNetwork(controller.signal, () => {});
  await guiOwner.release();
  const base = window.guiProbe.preview ? (await resolveMobileHtmlUrl(`${target}/`, lease.hostOrigin, controller.signal)).src : `${target}/`;
  const route = (path: string) => {
    const url = new URL(base); url.pathname += path; return url.href;
  };
  report('proxy_ready');
  const response = await fetch(route('upload'), { method: 'POST', body: 'relay-upload-'.repeat(40000) });
  check(await response.text() === String('relay-upload-'.repeat(40000).length), 'upload_passed');
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(route('echo').replace('http:', 'ws:'));
    ws.onopen = () => ws.send('socket-payload');
    ws.onmessage = event => { check(event.data === 'socket-payload', 'ws_passed'); ws.close(); resolve(); };
    ws.onerror = () => reject(new Error('websocket failed'));
  });
  await new Promise<void>((resolve, reject) => {
    const frame = document.createElement('iframe');
    const timer = setTimeout(() => reject(new Error('iframe timeout')), 15000);
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== new URL(base).origin || event.data !== 'nested-pass') return;
      clearTimeout(timer); window.removeEventListener('message', receive); frame.remove(); resolve();
    };
    window.addEventListener('message', receive);
    frame.src = route('frame'); document.body.append(frame);
  });
  report('nested_iframe_passed');
  const secure = await fetch('https://example.com/', { mode: 'no-cors' });
  check(secure.type === 'opaque', 'https_passed');
  await fetch(route('disconnect'));
  await new Promise(resolve => setTimeout(resolve, 500));
  check(failed, 'relay_failure_observed');
  let blocked = false;
  try { await fetch(route('after-disconnect'), { signal: AbortSignal.timeout(3000) }); } catch { blocked = true; }
  check(blocked, 'disconnect_fail_closed');
  await lease.release();
  check(await (await fetch(`${target}/after-release`)).text() === 'nested-pass', 'application_network_restored');
  report('PASSED');
}
void run().catch(error => report(`FAILED ${error instanceof Error ? error.message : String(error)}`));
