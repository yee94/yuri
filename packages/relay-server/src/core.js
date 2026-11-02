import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

const CLOSE = { replaced: 4001, duplicate: 4002, stuck: 4003, unavailable: 4008, auth: 4010, limit: 4029, away: 1012, malformed: 1008 };
const B64 = /^[A-Za-z0-9_-]+$/;
const SERVER_ID_BYTES = 32;
export const DEFAULT_RELAY_LIMITS = {
  maxUrlBytes: 4096, maxFieldBytes: 512, maxHosts: 256, maxSockets: 2048, maxConnections: 1000,
  maxClientsPerHost: 100, maxClientsPerIp: 30, maxPendingClients: 30, pendingMs: 15_000,
  maxRawSockets: 4096, maxRawSocketsPerIp: 128,
  graceMs: 30_000, timestampSkewMs: 60_000, replayMs: 120_000, maxReplayEntries: 10_000,
  maxFrameBytes: 128 * 1024, maxQueuedBytesPerConnection: 2 * 1024 * 1024,
  maxGlobalQueuedBytes: 32 * 1024 * 1024, maxBufferedAmount: 2 * 1024 * 1024,
  maxControlQueueEntries: 256, maxControlQueuedBytes: 2 * 1024 * 1024,
  pumpRetryMs: 25, heartbeatMs: 30_000, handshakeMs: 10_000, closeDeadlineMs: 5_000,
  admissionWindowMs: 60_000, maxAdmissionsPerIp: 120,
  maxHostControlAdmissionsPerIp: 30, maxHostControlAdmissionsPerServer: 12, maxAdmissionEntries: 10_000,
  idAttempts: 4,
};
const fields = {
  client: new Set(['v', 'role', 'serverId', 'grant']),
  'host-control': new Set(['v', 'role', 'serverId', 'ts', 'sig', 'pk']),
  'host-data': new Set(['v', 'role', 'serverId', 'connectionId', 'ts', 'sig', 'pk']),
};
const bytes = (value) => Buffer.byteLength(value, 'utf8');
const canonical = (jwk) => JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
const b64 = (value, length) => {
  if (typeof value !== 'string' || !B64.test(value)) return null;
  try { const decoded = Buffer.from(value, 'base64url'); return decoded.length === length && decoded.toString('base64url') === value ? decoded : null; } catch { return null; }
};

/** @param {string} encoded */
const decodeJwk = (encoded) => {
  const raw = b64(encoded, Buffer.byteLength(encoded, 'base64url'));
  if (!raw) return null;
  try {
    const text = raw.toString('utf8'); const jwk = JSON.parse(text);
    if (text !== canonical(jwk) || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !b64(jwk.x, 32) || !b64(jwk.y, 32)) return null;
    return { jwk };
  } catch { return null; }
};

/**
 * Shared Layer 1 routing engine. Runtimes own HTTP upgrades, TCP and socket I/O.
 * Workers supplies a ws-shaped adapter and enables nodejs_compat for crypto/Buffer.
 */
export const createRelayCore = (options = {}) => {
  const limits = { ...DEFAULT_RELAY_LIMITS, ...options.limits };
  if (limits.replayMs < limits.timestampSkewMs * 2 || limits.maxReplayEntries < 1) throw new RangeError('invalid replay limits');
  const clock = { now: Date.now, setTimeout, clearTimeout, setImmediate: (callback) => setTimeout(callback, 0), ...options.clock };
  const randomBytes = options.randomBytes ?? crypto.randomBytes;
  const hosts = new Map(); const replay = new Map(); const admissions = new Map(); const clientIpCounts = new Map();
  const accepted = new Set();
  const counts = { hosts: 0, sockets: 0, controls: 0, clients: 0, pairs: 0, pending: 0, queuedBytes: 0 };
  const reasons = { authRejected: 0, policyRejected: 0, limited: 0, heartbeatReaped: 0, replayRejected: 0 };
  const addReason = (key) => { reasons[key] += 1; };
  const snapshot = () => ({ ...counts, reasons: { ...reasons } });
  const relayPath = options.path ?? '/ws';
  const decrement = (map, key) => { const value = map.get(key) ?? 0; if (value <= 1) map.delete(key); else map.set(key, value - 1); };
  const safeClose = (socket, code, reason = '') => {
    if (socket.readyState === socket.CLOSED) return;
    try {
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close(code, reason);
      if (socket.readyState === socket.CLOSED) return;
      if (socket.readyState !== socket.OPEN && socket.readyState !== socket.CONNECTING && socket.readyState !== socket.CLOSING) return;
      if (!socket._relayCloseDeadline) socket._relayCloseDeadline = clock.setTimeout(() => {
        socket._relayCloseDeadline = null;
        if (socket.readyState !== socket.CLOSED) socket.terminate();
      }, limits.closeDeadlineMs);
    } catch { socket.terminate(); }
  };
  const purge = () => {
    const now = clock.now();
    for (const [key, expiry] of replay) if (expiry <= now) replay.delete(key);
    for (const [key, record] of admissions) if (record.until <= now) admissions.delete(key);
  };
  const admit = (key, cap) => {
    purge(); let record = admissions.get(key);
    if (!record) {
      if (admissions.size >= limits.maxAdmissionEntries) { addReason('limited'); return false; }
      record = { count: 0, until: clock.now() + limits.admissionWindowMs }; admissions.set(key, record);
    }
    record.count += 1;
    if (record.count > cap) { addReason('limited'); return false; }
    return true;
  };
  const admitUpgrade = (ip, parsed) => {
    if (parsed.role === 'host-control') {
      return admit(`host-control:${ip}`, limits.maxHostControlAdmissionsPerIp)
        && admit(`host-control-server:${parsed.serverId}`, limits.maxHostControlAdmissionsPerServer);
    }
    return admit(`${parsed.role}:${ip}`, limits.maxAdmissionsPerIp);
  };
  const removeSocket = (socket) => {
    if (!accepted.delete(socket)) return;
    counts.sockets -= 1;
    if (socket._relayHandshake) clock.clearTimeout(socket._relayHandshake);
    if (socket._relayCloseDeadline) clock.clearTimeout(socket._relayCloseDeadline);
  };
  const detachControl = (host, control, { code = CLOSE.away, reason = 'control closed', grace = true } = {}) => {
    if (!control || hosts.get(host.serverId) !== host || host.control !== control || control.epoch !== host.epoch) return;
    host.control = null;
    counts.controls -= 1;
    const queued = control.queuedBytes;
    control.queue = []; control.queuedBytes = 0; control.busy = false;
    counts.queuedBytes = Math.max(0, counts.queuedBytes - queued);
    safeClose(control.socket, code, reason);
    if (grace) beginGrace(host, control.epoch);
  };
  const controlPump = (host, message) => {
    if (!host.control || host.control.epoch !== host.epoch) return;
    const control = host.control; const payload = Buffer.from(JSON.stringify(message));
    if (control.queue.length >= limits.maxControlQueueEntries || control.queuedBytes + payload.length > limits.maxControlQueuedBytes || counts.queuedBytes + payload.length > limits.maxGlobalQueuedBytes) {
      addReason('limited'); detachControl(host, control, { code: CLOSE.limit, reason: 'control queue limit' }); return;
    }
    control.queue.push(payload); control.queuedBytes += payload.length; counts.queuedBytes += payload.length;
    const pump = () => {
      const control = host.control;
      if (!control || control.epoch !== host.epoch || control.busy || !control.queue.length) return;
      if (control.socket.readyState !== control.socket.OPEN) return detachControl(host, control, { code: CLOSE.away, reason: 'control unavailable' });
      control.busy = true; const item = control.queue[0];
      control.socket.send(item, { binary: false }, (error) => {
        if (!host.control || host.control !== control || control.epoch !== host.epoch) return;
        control.busy = false;
        if (error) { detachControl(host, control, { code: CLOSE.away, reason: 'control send failure' }); return; }
        control.queue.shift(); control.queuedBytes -= item.length; counts.queuedBytes = Math.max(0, counts.queuedBytes - item.length); pump();
      });
    };
    pump();
  };
  const releasePump = (entry, pump) => {
    if (pump.retry) clock.clearTimeout(pump.retry);
    const total = pump.bytes; pump.queue = []; pump.bytes = 0; pump.busy = false; pump.retry = null;
    entry.queuedBytes = Math.max(0, entry.queuedBytes - total);
    counts.queuedBytes = Math.max(0, counts.queuedBytes - total);
  };
  const removeClient = (host, entry, code, reason, notify = true) => {
    if (host.clients.get(entry.id) !== entry) return;
    host.clients.delete(entry.id); counts.clients -= 1; decrement(clientIpCounts, entry.ip); if (entry.data) counts.pairs -= 1; else counts.pending -= 1;
    if (entry.pendingTimer) clock.clearTimeout(entry.pendingTimer);
    releasePump(entry, entry.toData); releasePump(entry, entry.toClient);
    setRelayPaused(entry.client, false); setRelayPaused(entry.data, false);
    if (entry.client) safeClose(entry.client, code, reason); if (entry.data) safeClose(entry.data, code, reason);
    if (notify) controlPump(host, { type: 'disconnected', connectionId: entry.id });
    if (!host.control && host.clients.size === 0 && !host.graceTimer && hosts.delete(host.serverId)) counts.hosts -= 1;
  };
  const expireHost = (host, epoch) => {
    if (hosts.get(host.serverId) !== host || host.epoch !== epoch || host.control) return;
    host.graceTimer = null;
    for (const entry of [...host.clients.values()]) removeClient(host, entry, CLOSE.away, 'host went away', false);
    if (hosts.get(host.serverId) === host && hosts.delete(host.serverId)) counts.hosts -= 1;
  };
  const beginGrace = (host, epoch) => {
    if (hosts.get(host.serverId) !== host || host.epoch !== epoch || host.graceTimer) return;
    host.graceTimer = clock.setTimeout(() => expireHost(host, epoch), limits.graceMs);
  };
  const pauseHigh = Math.max(1, Math.min(limits.maxQueuedBytesPerConnection - 1, Math.floor(limits.maxQueuedBytesPerConnection / 2)));
  const pauseLow = Math.min(pauseHigh, Math.floor(limits.maxQueuedBytesPerConnection / 4));
  const sourceOf = (entry, direction) => (direction === 'toData' ? entry.client : entry.data);
  // Pause the fast sender when this direction's queue is above the high watermark.
  const setRelayPaused = (socket, paused) => {
    if (!socket || Boolean(socket._relayPaused) === paused) return;
    if (paused && socket.readyState !== socket.OPEN) return;
    try {
      if (typeof socket.pause === 'function' && typeof socket.resume === 'function') {
        if (paused) socket.pause();
        else socket.resume();
      } else {
        const stream = socket._socket;
        if (stream && typeof stream.pause === 'function') {
          if (paused) stream.pause();
          else stream.resume();
        }
      }
    } catch { /* pause/resume only apply while OPEN */ }
    socket._relayPaused = paused;
  };
  const applyBackpressure = (entry, direction) => {
    const source = sourceOf(entry, direction);
    if (!source) return;
    const queued = entry[direction].bytes;
    if (queued >= pauseHigh) setRelayPaused(source, true);
    else if (queued <= pauseLow) setRelayPaused(source, false);
  };
  const fairReady = [];
  let fairScheduled = false;
  const requestPump = (host, entry, direction) => {
    const channel = entry[direction];
    if (channel.scheduled) return;
    channel.scheduled = true;
    fairReady.push({ host, entry, direction });
    if (fairScheduled) return;
    fairScheduled = true;
    clock.setImmediate(runFairPump);
  };
  // One frame per ready pair per tick so a single tunnel cannot monopolize the event loop.
  const runFairPump = () => {
    fairScheduled = false;
    const pending = fairReady.length;
    for (let index = 0; index < pending; index += 1) {
      const job = fairReady.shift();
      if (!job) break;
      job.entry[job.direction].scheduled = false;
      sendOne(job.host, job.entry, job.direction);
    }
  };
  const sendOne = (host, entry, direction) => {
    const channel = entry[direction]; const target = direction === 'toData' ? entry.data : entry.client;
    if (host.clients.get(entry.id) !== entry || channel.busy || !channel.queue.length) return;
    if (!target || target.readyState !== target.OPEN || target.bufferedAmount > limits.maxBufferedAmount) {
      if (!channel.retry) channel.retry = clock.setTimeout(() => { channel.retry = null; requestPump(host, entry, direction); }, limits.pumpRetryMs);
      return;
    }
    channel.busy = true; const item = channel.queue[0];
    target.send(item.data, { binary: item.binary }, (error) => {
      if (host.clients.get(entry.id) !== entry || entry[direction] !== channel) return;
      channel.busy = false;
      if (error) { removeClient(host, entry, CLOSE.limit, 'send failure'); return; }
      channel.queue.shift(); channel.bytes = Math.max(0, channel.bytes - item.data.length); entry.queuedBytes = Math.max(0, entry.queuedBytes - item.data.length); counts.queuedBytes = Math.max(0, counts.queuedBytes - item.data.length);
      applyBackpressure(entry, direction);
      if (channel.queue.length) requestPump(host, entry, direction);
    });
  };
  const enqueue = (host, entry, direction, data, binary) => {
    if (hosts.get(host.serverId) !== host || host.clients.get(entry.id) !== entry) return;
    const payload = Buffer.from(data); const channel = entry[direction];
    if (payload.length > limits.maxFrameBytes || entry.queuedBytes + payload.length > limits.maxQueuedBytesPerConnection || counts.queuedBytes + payload.length > limits.maxGlobalQueuedBytes) { addReason('limited'); removeClient(host, entry, CLOSE.limit, 'queue limit'); return; }
    channel.queue.push({ data: payload, binary }); channel.bytes += payload.length; entry.queuedBytes += payload.length; counts.queuedBytes += payload.length;
    applyBackpressure(entry, direction);
    requestPump(host, entry, direction);
  };
  const bindClient = (host, entry, socket) => {
    entry.client = socket;
    socket.on('message', (data, binary) => enqueue(host, entry, 'toData', data, binary));
    socket.on('close', () => removeClient(host, entry, 1000, '', true)); socket.on('error', () => {});
  };
  const bindData = (host, entry, socket) => {
    entry.data = socket; counts.pending -= 1; counts.pairs += 1; if (entry.pendingTimer) clock.clearTimeout(entry.pendingTimer);
    socket.on('message', (data, binary) => enqueue(host, entry, 'toClient', data, binary));
    socket.on('close', () => { if (host.clients.get(entry.id) === entry && entry.data === socket) removeClient(host, entry, CLOSE.away, 'host data closed'); }); socket.on('error', () => {});
    requestPump(host, entry, 'toData');
  };
  const parse = (requestUrl) => {
    if (!requestUrl || bytes(requestUrl) > limits.maxUrlBytes) return null;
    let url; try { url = new URL(requestUrl, 'http://relay'); } catch { return null; }
    if (url.pathname !== relayPath) return null;
    const role = url.searchParams.get('role'); const allowed = Object.hasOwn(fields, role) ? fields[role] : null;
    if (!allowed || url.searchParams.get('v') !== '1') return null;
    for (const [key, value] of url.searchParams) if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1 || bytes(value) > limits.maxFieldBytes) return null;
    for (const key of allowed) if (key !== 'grant' && !url.searchParams.has(key)) return null;
    const serverId = url.searchParams.get('serverId');
    if (!b64(serverId, SERVER_ID_BYTES)) return null;
    const connectionId = url.searchParams.get('connectionId');
    if (connectionId && !b64(connectionId, 16)) return null;
    return { role, serverId, connectionId, params: url.searchParams };
  };
  const authenticate = (parsed) => {
    if (parsed.role === 'client') return true;
    const ts = parsed.params.get('ts'); const sig = parsed.params.get('sig'); const pk = parsed.params.get('pk');
    if (!/^(0|[1-9][0-9]{0,15})$/.test(ts ?? '')) return false;
    const timestamp = Number(ts); if (!Number.isSafeInteger(timestamp) || Math.abs(clock.now() - timestamp) > limits.timestampSkewMs) return false;
    const signature = b64(sig, 64); const publicKey = decodeJwk(pk);
    if (!signature || !publicKey) return false;
    const id = crypto.createHash('sha256').update(canonical(publicKey.jwk)).digest('base64url'); if (id !== parsed.serverId) return false;
    const key = `${parsed.serverId}.${parsed.role}.${parsed.connectionId ?? ''}.${ts}`;
    purge(); if (replay.has(key) || replay.size >= limits.maxReplayEntries) { addReason('replayRejected'); return false; }
    const message = `${ts}.${parsed.serverId}.${parsed.role}.${parsed.connectionId ?? ''}`;
    try {
      if (!crypto.verify('SHA256', Buffer.from(message), { key: publicKey.jwk, format: 'jwk', dsaEncoding: 'ieee-p1363' }, signature)) return false;
    } catch { return false; }
    replay.set(key, clock.now() + limits.replayMs); return true;
  };
  const idFor = (host) => {
    for (let attempt = 0; attempt < limits.idAttempts; attempt += 1) { const id = Buffer.from(randomBytes(16)).toString('base64url'); if (id.length === 22 && !host.clients.has(id)) return id; }
    return null;
  };
  const attach = (socket, parsed, ip) => {
    socket._relayRole = parsed.role; socket._relayAlive = true;
    socket.on('pong', () => { socket._relayAlive = true; });
    if (parsed.role === 'host-control') {
      let host = hosts.get(parsed.serverId);
      if (!host && counts.hosts >= limits.maxHosts) { addReason('limited'); return safeClose(socket, CLOSE.limit, 'host limit'); }
      if (!host) { host = { serverId: parsed.serverId, clients: new Map(), control: null, epoch: 0, graceTimer: null }; hosts.set(parsed.serverId, host); counts.hosts += 1; }
      if (host.control) { const previous = host.control; host.epoch += 1; for (const entry of [...host.clients.values()]) removeClient(host, entry, CLOSE.replaced, 'control replaced', false); host.epoch -= 1; detachControl(host, previous, { code: CLOSE.replaced, reason: 'control replaced', grace: false }); }
      if (host.graceTimer) { clock.clearTimeout(host.graceTimer); host.graceTimer = null; }
      host.epoch += 1; const epoch = host.epoch; host.control = { socket, epoch, queue: [], queuedBytes: 0, busy: false }; counts.controls += 1;
      socket.on('close', () => detachControl(host, host.control?.socket === socket ? host.control : null, { code: CLOSE.away, reason: 'control closed' })); socket.on('error', () => {});
      controlPump(host, { type: 'sync', connectionIds: [...host.clients.keys()] }); return;
    }
    if (parsed.role === 'client') {
      const host = hosts.get(parsed.serverId);
      if (!host) return safeClose(socket, CLOSE.unavailable, 'host unavailable');
      if (counts.clients >= limits.maxConnections || host.clients.size >= limits.maxClientsPerHost || counts.pending >= limits.maxPendingClients || (clientIpCounts.get(ip) ?? 0) >= limits.maxClientsPerIp) { addReason('limited'); return safeClose(socket, CLOSE.limit, 'client limit'); }
      const id = idFor(host); if (!id) { addReason('limited'); return safeClose(socket, CLOSE.limit, 'id collision'); }
      const entry = { id, ip, client: null, data: null, queuedBytes: 0, toData: { queue: [], bytes: 0, busy: false, retry: null, scheduled: false }, toClient: { queue: [], bytes: 0, busy: false, retry: null, scheduled: false }, pendingTimer: null };
      host.clients.set(id, entry); counts.clients += 1; counts.pending += 1; clientIpCounts.set(ip, (clientIpCounts.get(ip) ?? 0) + 1); bindClient(host, entry, socket);
      entry.pendingTimer = clock.setTimeout(() => { if (host.clients.get(id) === entry && !entry.data) removeClient(host, entry, CLOSE.limit, 'pending timeout'); }, limits.pendingMs);
      controlPump(host, { type: 'connected', connectionId: id }); return;
    }
    const host = hosts.get(parsed.serverId); const entry = host?.clients.get(parsed.connectionId);
    if (!host || !entry || entry.data) return safeClose(socket, CLOSE.duplicate, 'data attach');
    bindData(host, entry, socket);
  };
  const admitConnection = (requestUrl, ip) => {
    const parsed = parse(requestUrl);
    if (!parsed) {
      if (!admit(`malformed:${ip}`, limits.maxAdmissionsPerIp)) return { code: CLOSE.limit };
      addReason('policyRejected'); return { code: CLOSE.malformed };
    }
    if (!admitUpgrade(ip, parsed)) return { code: CLOSE.limit };
    if (!authenticate(parsed)) { addReason('authRejected'); return { code: CLOSE.auth }; }
    if (counts.sockets >= limits.maxSockets) { addReason('limited'); return { code: CLOSE.limit }; }
    return { parsed };
  };
  const accept = (socket, parsed, ip) => {
    accepted.add(socket); counts.sockets += 1;
    socket.on('close', () => removeSocket(socket));
    options.onSocketAccepted?.({ socket, role: parsed.role });
    attach(socket, parsed, ip);
  };
  const heartbeat = () => {
    purge();
    for (const socket of accepted) {
      if (socket.readyState !== socket.OPEN) continue;
      if (socket._relayPaused) socket._relayAlive = true;
      if (!socket._relayAlive) { addReason('heartbeatReaped'); safeClose(socket, socket._relayRole === 'host-control' ? CLOSE.stuck : CLOSE.away, 'heartbeat'); continue; }
      socket._relayAlive = false;
      try { socket.ping(); } catch { safeClose(socket, CLOSE.away, 'heartbeat'); }
    }
  };
  const dispose = () => {
    for (const host of hosts.values()) { if (host.graceTimer) clock.clearTimeout(host.graceTimer); if (host.control) detachControl(host, host.control, { code: CLOSE.away, reason: 'server stopping', grace: false }); for (const entry of [...host.clients.values()]) removeClient(host, entry, CLOSE.away, 'server stopping', false); }
    hosts.clear(); replay.clear(); admissions.clear(); clientIpCounts.clear(); counts.hosts = 0; counts.controls = 0; counts.clients = 0; counts.pairs = 0; counts.pending = 0; counts.queuedBytes = 0;
    for (const socket of accepted) { if (socket._relayCloseDeadline) clock.clearTimeout(socket._relayCloseDeadline); socket.terminate(); }
    accepted.clear(); counts.sockets = 0; fairReady.length = 0;
  };
  return { limits, admitConnection, accept, reject: (socket, code) => safeClose(socket, code, 'rejected'), heartbeat, dispose, getSnapshot: snapshot, recordLimit: () => addReason('limited') };
};
