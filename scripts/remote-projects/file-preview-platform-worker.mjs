import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createPlatformFileFixture } from './file-preview-platform-fixture.mjs';

const config = JSON.parse(fs.readFileSync(process.env.REMOTE_PROJECTS_PLATFORM_CONFIG));
const snapshot = JSON.parse(fs.readFileSync(config.manifest));
const fixture = await createPlatformFileFixture({ snapshot, evidence: config.evidence, root: config.root });
const requestFile = path.join(config.evidence, 'platform-fixture-requests.jsonl');
for (const [hostId, remote] of [['a', fixture.first], ['b', fixture.second]]) {
  remote.server.prependListener('request', (req, res) => {
    const route = new URL(req.url, 'http://fixture.invalid').pathname.replace(/(\/_file\/)[^/]+\/[^/]+/, '$1[preview]/[url-auth]');
    const row = { epochMs: Date.now(), hostId, method: req.method, route };
    const hash = crypto.createHash('sha256'); let bytes = 0;
    if (route.startsWith('/api/fs/prompt-attachments/')) {
      req.on('data', chunk => { hash.update(chunk); bytes += chunk.length; });
      req.on('end', () => { row.bodyBytes = bytes; row.bodySha256 = hash.digest('hex'); });
      row.metadata = Object.fromEntries(['x-yuri-content-length', 'x-yuri-sha256', 'x-yuri-mime', 'x-yuri-filename'].filter(key => req.headers[key]).map(key => [key, req.headers[key]]));
    }
    res.once('finish', () => fs.appendFileSync(requestFile, JSON.stringify({ ...row, status: res.statusCode }) + '\n'));
  });
}
const attachment = path.join(config.root, 'fixture-attachment.png');
fs.writeFileSync(attachment, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvHkAAAAASUVORK5CYII=', 'base64'));
fs.writeFileSync(path.join(config.evidence, 'platform-fixture.json'), JSON.stringify({ sourceHash: snapshot.sourceHash, pid: process.pid, root: config.root,
  privateFile: fixture.privateFile, localDirectory: fs.realpathSync(fixture.hub.root),
  hosts: [{ id: 'a', label: 'Preview A Relay-only', source: 'relay', directory: fs.realpathSync(fixture.first.root), expectedHeading: 'remote-a' },
    { id: 'b', label: 'Preview B Direct', source: 'direct', directory: fs.realpathSync(fixture.second.root), expectedHeading: 'remote-b' }],
  baselinePreviewRequests: fixture.requests.length, transports: fixture.transports, attachment: { file: attachment, bytes: fs.statSync(attachment).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(attachment)).digest('hex') }, fixtureManifest: fixture.manifest }, null, 2));
const timer = setInterval(() => fs.writeFileSync(path.join(config.evidence, 'preview-handoff-requests.json'), JSON.stringify(fixture.requests, null, 2)), 1000);
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; clearInterval(timer); fs.writeFileSync(path.join(config.evidence, 'preview-handoff-requests.json'), JSON.stringify(fixture.requests, null, 2)); await fixture.stop(); process.exit(0); };
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, () => { void stop(); });
setTimeout(() => { void stop(); }, 90 * 60 * 1000).unref();
console.log('[platform-file-fixture] Original handed-off graph + production FS/terminal routes ready; private descriptors omitted');
