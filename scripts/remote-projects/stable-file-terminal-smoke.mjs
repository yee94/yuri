import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const evidence = path.resolve(process.env.REMOTE_PROJECTS_CANDIDATE_EVIDENCE ?? '.scratch/remote-projects/performance/candidate-stable');
const interactive = JSON.parse(fs.readFileSync(path.join(evidence, 'electron/interactive.json')));
const remote = JSON.parse(fs.readFileSync(path.join(evidence, 'remote.json')));
const settings = JSON.parse(fs.readFileSync(path.join(interactive.root, 'yuri-data/settings.json')));
const origin = `http://127.0.0.1:${settings.desktopLocalPort}`;
const headers = { Authorization: `Bearer ${settings.desktopLocalClientToken}`, 'content-type': 'application/json' };
const prefix = '/api/hosts/candidate-remote';
const request = async (route, method = 'GET', body) => {
  const response = await fetch(origin + prefix + route, { method, headers, signal: AbortSignal.timeout(15000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, body: data };
};
const report = { classification: 'real scoped file HTTP and PTY WebSocket; not a rendered file/terminal UI verdict', startedAt: Date.now() };
let socket, terminal;
try {
  const directory = fs.realpathSync(remote.directory);
  if (!directory.startsWith(fs.realpathSync(remote.root) + path.sep)) throw new Error('Not task-owned remote project');
  const file = path.join(directory, 'diagnostic.txt');
  const content = 'REMOTE_SCOPED_FILE_MARKER\nOwned isolated fixture file.\n';
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, 'utf8') !== content) throw new Error('Unexpected existing fixture file; not overwriting');
  } else fs.writeFileSync(file, content, { flag: 'wx' });
  report.file = await request('/api/fs/read?path=' + encodeURIComponent(file) + '&directory=' + encodeURIComponent(directory));
  if (report.file.status !== 200 || !JSON.stringify(report.file.body).includes('REMOTE_SCOPED_FILE_MARKER')) throw new Error('Real scoped file read failed');
  report.create = await request('/api/terminal/create?directory=' + encodeURIComponent(directory), 'POST', { cwd: directory, cols: 80, rows: 24 });
  terminal = report.create.body.sessionId;
  if (report.create.status !== 200 || !terminal) throw new Error('Real PTY create failed');
  const require = createRequire(path.join(interactive.repo, 'packages/web/package.json'));
  const { WebSocket } = require('ws');
  const wsUrl = origin.replace('http:', 'ws:') + prefix + '/api/terminal/ws';
  report.frames = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('PTY stdout timeout')), 15000);
    socket = new WebSocket(wsUrl, { headers: { Authorization: headers.Authorization, Origin: origin } });
    socket.once('open', () => socket.send(Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify({ t: 'b', s: terminal }))])));
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.on('message', data => {
      const bytes = Buffer.from(data);
      if (bytes[0] !== 1) return;
      const frame = JSON.parse(bytes.subarray(1).toString()); report.frames.push(frame);
      if (frame.t === 'bok') {
        report.ptyBackend = frame.ptyBackend;
        socket.send("printf 'REMOTE_%s\\n' 'PTY_OK_7941'; pwd\r");
      }
      if (frame.t === 'd') {
        report.stdout = (report.stdout ?? '') + frame.d;
        if (report.stdout.includes('REMOTE_PTY_OK_7941') && report.stdout.includes(directory)) { clearTimeout(timer); resolve(); }
      }
    });
  });
  report.status = 'passed-real-file-and-pty';
} catch (error) { report.status = 'failed'; report.error = error.message; process.exitCode = 2; }
finally {
  if (socket) { socket.close(); socket.terminate(); }
  if (terminal) report.close = await request('/api/terminal/' + encodeURIComponent(terminal), 'DELETE');
  report.completedAt = Date.now();
  fs.writeFileSync(path.join(evidence, 'file-terminal.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, error: report.error, ptyBackend: report.ptyBackend, close: report.close?.status }));
}
