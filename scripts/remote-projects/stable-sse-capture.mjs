import fs from 'node:fs';
import path from 'node:path';

const evidence = path.resolve(process.env.REMOTE_PROJECTS_CANDIDATE_EVIDENCE ?? '.scratch/remote-projects/performance/candidate-stable');
const remote = JSON.parse(fs.readFileSync(path.join(evidence, 'remote.json')));
const descriptor = JSON.parse(fs.readFileSync(remote.privateFile));
const ui = JSON.parse(fs.readFileSync(path.join(evidence, 'electron/interactive.json')));
const settings = JSON.parse(fs.readFileSync(path.join(ui.root, 'yuri-data/settings.json')));
const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), 45000);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
await Promise.all([
  ['remote-content', remote.origin, '/api/event?directory=' + encodeURIComponent(fs.realpathSync(remote.directory)), descriptor.host.clientToken],
  ['hub-content', `http://127.0.0.1:${settings.desktopLocalPort}`, '/api/global/event', settings.desktopLocalClientToken],
].map(async ([label, origin, route, token]) => {
  let bytes = 0;
  try {
    const response = await fetch(origin + route, { headers: { Authorization: `Bearer ${token}` }, signal: abort.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    console.log(JSON.stringify({ label, status: response.status, ready: true }));
    for await (const chunk of response.body) {
      bytes += chunk.length;
      fs.appendFileSync(path.join(evidence, `${label}-sse.txt`), Buffer.from(chunk));
    }
  } catch (error) { if (!abort.signal.aborted) console.log(JSON.stringify({ label, error: error.message })); }
  finally { console.log(JSON.stringify({ label, bytes, closed: true })); }
}));
clearTimeout(timer);
