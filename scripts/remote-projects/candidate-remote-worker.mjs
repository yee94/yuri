import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { startSeededOpenCode } from './seeded-opencode.mjs';

const c = JSON.parse(fs.readFileSync(process.env.REMOTE_PROJECTS_REMOTE_CONFIG, 'utf8'));
const metrics = { requests: 0, streaming: 0, routes: {}, models: [] };
const provider = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 2000000) { res.writeHead(413).end(); return; } }
  let body; try { body = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
  metrics.requests++; metrics.models.push(body.model); metrics.routes[req.url] = (metrics.routes[req.url] ?? 0) + 1;
  fs.writeFileSync(path.join(c.evidence, 'remote-provider-metrics.json'), JSON.stringify(metrics));
  if (req.headers.authorization !== 'Bearer fixture') { res.writeHead(401).end(); return; }
  const text = 'Remote fixture streamed reply. End-to-end real OpenCode generation complete.';
  const id = `resp_diagnostic_${metrics.requests}`;
  const message = { id: 'msg_' + id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const response = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: body.model, output: [message],
    usage: { input_tokens: 10, output_tokens: 15, total_tokens: 25, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  if (!['/v1/responses', '/v1/chat/completions'].includes(req.url)) { res.writeHead(404).end(JSON.stringify({ error: 'provider_fixture_route_missing' })); return; }
  if (!body.stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url.endsWith('/responses') ? response : { id, object: 'chat.completion', created: response.created_at, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 } })); return;
  }
  metrics.streaming++; fs.writeFileSync(path.join(c.evidence, 'remote-provider-metrics.json'), JSON.stringify(metrics));
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const event = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  if (req.url.endsWith('/responses')) {
    event('response.created', { response: { ...response, status: 'in_progress', output: [] } });
    event('response.output_item.added', { output_index: 0, item: { ...message, content: [], status: 'in_progress' } });
    event('response.content_part.added', { item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    for (const delta of text.match(/.{1,8}/g)) { event('response.output_text.delta', { item_id: message.id, output_index: 0, content_index: 0, delta }); await new Promise(r => setTimeout(r, 80)); }
    event('response.output_text.done', { item_id: message.id, output_index: 0, content_index: 0, text });
    event('response.content_part.done', { item_id: message.id, output_index: 0, content_index: 0, part: message.content[0] });
    event('response.output_item.done', { output_index: 0, item: message });
    event('response.completed', { response });
  } else {
    for (const content of text.match(/.{1,8}/g)) { res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: response.created_at, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`); await new Promise(r => setTimeout(r, 80)); }
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 } })}\n\ndata: [DONE]\n\n`);
  }
  res.end();
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const port = await freePort(), opencodePort = await freePort();
const origin = `http://127.0.0.1:${port}`;
let service, hub, stopping = false;
const stop = async () => {
  if (stopping) return; stopping = true;
  try { await hub?.stop({ exitProcess: false, forceCloseConnections: true }); }
  finally { await service?.close(); provider.closeAllConnections(); provider.close(); process.exit(0); }
};
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, () => { void stop(); });
try {
  const configContent = JSON.stringify({ enabled_providers: ['openai'], model: 'openai/gpt-4.1', small_model: 'openai/gpt-4.1', provider: { openai: { models: { 'gpt-4.1': { name: 'Diagnostic Loopback Only' } }, options: { apiKey: 'fixture', baseURL: `http://127.0.0.1:${provider.address().port}/v1` } } } });
  service = await startSeededOpenCode({ binary: c.binary, root: c.root, port: opencodePort, env: { ...process.env, OPENCODE_CONFIG_CONTENT: configContent }, logFile: path.join(c.evidence, 'remote-opencode.log'), onStart: value => { service = value; } });
  Object.assign(process.env, service.env, { YURI_DATA_DIR: path.join(c.root, 'yuri-data'), YURI_DIST_DIR: path.join(c.repo, 'packages/web/dist'), YURI_RUNTIME: 'desktop' });
  fs.mkdirSync(process.env.YURI_DATA_DIR);
  fs.writeFileSync(path.join(process.env.YURI_DATA_DIR, 'settings.json'), JSON.stringify({ projects: [{ id: 'remote-fixture-project', path: service.directory, label: 'project', addedAt: Date.now(), lastOpenedAt: Date.now() }] }));
  const { startWebUiServer } = await import(pathToFileURL(path.join(c.repo, 'packages/web/server/index.js')).href);
  hub = await startWebUiServer({ host: '127.0.0.1', port, attachSignals: false, exitOnShutdown: false, remoteHostsAdapter: { listHosts: async () => [] } });
  const created = await fetch(origin + '/api/client-auth/clients', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Isolated candidate Hub', clientKind: 'desktop' }) });
  if (!created.ok) throw new Error(`Client credential issuance HTTP ${created.status}`);
  const credential = await created.json();
  if (!credential.token) throw new Error('No real server-issued client credential');
  const unauth = await fetch(origin + '/api/hosts/capabilities');
  const authorized = await fetch(origin + '/api/hosts/capabilities', { headers: { Authorization: `Bearer ${credential.token}` } });
  const capabilities = await authorized.json();
  if (unauth.status !== 401 || !authorized.ok || capabilities.protocol !== 1 || !capabilities.remoteProjects) throw new Error('Real auth/capability admission check failed');
  const descriptor = { host: { id: 'candidate-remote', label: 'Diagnostic Remote', url: origin, apiUrl: origin, clientToken: credential.token }, directory: service.directory, sessionId: service.sessionId };
  const privateFile = path.join(c.root, 'desktop-remote.json'); fs.writeFileSync(privateFile, JSON.stringify(descriptor), { mode: 0o600 });
  fs.writeFileSync(path.join(c.evidence, 'remote.json'), JSON.stringify({ pid: process.pid, root: c.root, origin, opencodePort, privateFile, directory: service.directory, sessionId: service.sessionId, modulesAbi: process.versions.modules, capabilities, unauthenticatedStatus: unauth.status, authenticatedStatus: authorized.status }, null, 2));
  console.log('[candidate-remote] real authenticated protocol1 Yuri/OpenCode ready; credential omitted');
  setTimeout(() => { void stop(); }, 90 * 60 * 1000).unref();
} catch (error) { console.error('[candidate-remote] blocked:', error.message); await stop(); }
