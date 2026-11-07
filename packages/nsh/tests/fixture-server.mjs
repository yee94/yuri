import http from 'node:http';
import { createHost } from './host.js';

// Simulator integration fixture. No product server, disk writes, or user credentials.
const fixture = createHost();
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/yuri/events') || req.url.startsWith('/api/event?')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    res.write(': fixture ready\n\n');
    const timer = setInterval(() => res.write(': keepalive\n\n'), 10_000);
    req.on('close', () => clearInterval(timer));
    return;
  }
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const result = fixture.call('runtime.request', { path: req.url, method: req.method, body: raw ? JSON.parse(raw) : undefined });
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.body));
  } catch (error) {
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
});
server.listen(Number(process.env.NSH_FIXTURE_PORT || 42817), '127.0.0.1', () => console.log(`Native integration fixture: http://127.0.0.1:${server.address().port}`));
for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
