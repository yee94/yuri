import net from 'node:net';

const CHUNK = 16 * 1024;
const WINDOW = 128 * 1024;
const MAX_STREAMS = 32;
const reply = (code) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);

/** Local SOCKS5 CONNECT front end for the existing /api/gui-network/ws protocol.
 * It never dials destinations itself. DNS, TCP and authorization belong to Host.
 */
export function createBrowserSocksGateway({ send }) {
  const streams = new Map();
  let nextId = 0;
  let closed = false;
  let starting;
  const emit = (value) => {
    if (closed || send(value) === false) throw new Error('Browser Relay disconnected');
  };
  const remove = (stream, notify = true) => {
    if (!streams.delete(stream.id)) return;
    clearTimeout(stream.connectTimer);
    stream.socket.destroy();
    if (notify && stream.requested && !closed) {
      try { emit({ type: 'close', id: stream.id }); } catch { /* channel already gone */ }
    }
  };
  const pump = (stream) => {
    while (stream.stage === 'connected' && stream.credit > 0 && stream.socket.readableLength) {
      const bytes = stream.socket.read(Math.min(CHUNK, stream.credit, stream.socket.readableLength));
      if (!bytes) break;
      stream.credit -= bytes.length;
      const packet = Buffer.allocUnsafe(4 + bytes.length);
      packet.writeUInt32BE(stream.id); bytes.copy(packet, 4);
      emit(packet);
    }
  };
  const negotiate = (stream) => {
    const socket = stream.socket;
    while (!socket.destroyed) {
      if (stream.stage === 'greeting') {
        const head = socket.read(2);
        if (!head) return;
        if (head[0] !== 5 || !head[1]) { remove(stream); return; }
        stream.methods = head[1]; stream.stage = 'methods';
      } else if (stream.stage === 'methods') {
        const methods = socket.read(stream.methods);
        if (!methods) return;
        if (!methods.includes(0)) { socket.end(Buffer.from([5, 255])); return; }
        socket.write(Buffer.from([5, 0])); stream.stage = 'request';
      } else if (stream.stage === 'request') {
        const head = socket.read(4);
        if (!head) return;
        if (head[0] !== 5 || head[1] !== 1 || head[2] !== 0 || ![1, 3, 4].includes(head[3])) {
          socket.end(reply(7)); return;
        }
        stream.addressType = head[3];
        stream.addressLength = head[3] === 1 ? 4 : head[3] === 4 ? 16 : 0;
        stream.stage = head[3] === 3 ? 'domain' : 'address';
      } else if (stream.stage === 'domain') {
        const size = socket.read(1);
        if (!size) return;
        if (!size[0]) { remove(stream); return; }
        stream.addressLength = size[0]; stream.stage = 'address';
      } else if (stream.stage === 'address') {
        const address = socket.read(stream.addressLength + 2);
        if (!address) return;
        const raw = address.subarray(0, -2);
        const hostname = stream.addressType === 1 ? [...raw].join('.')
          : stream.addressType === 4 ? Array.from({ length: 8 }, (_, i) => raw.readUInt16BE(i * 2).toString(16)).join(':')
          : raw.toString('utf8');
        const port = address.readUInt16BE(address.length - 2);
        if (!port || !hostname || /[\s/\\@\0]/.test(hostname)) { remove(stream); return; }
        stream.requested = true; stream.stage = 'opening';
        emit({ type: 'open', id: stream.id, hostname, port });
      } else { pump(stream); return; }
    }
  };
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    if (closed || streams.size >= MAX_STREAMS || nextId >= 0xffffffff) { socket.destroy(); return; }
    socket.setNoDelay(true);
    const stream = { id: ++nextId, socket, stage: 'greeting', credit: WINDOW, receiveCredit: WINDOW, requested: false, remoteFin: false };
    streams.set(stream.id, stream);
    stream.connectTimer = setTimeout(() => remove(stream), 15_000);
    socket.setTimeout(120_000, () => remove(stream));
    socket.on('readable', () => {
      try { negotiate(stream); } catch { remove(stream); }
    });
    socket.on('end', () => {
      if (stream.stage !== 'connected') { remove(stream); return; }
      try { emit({ type: 'fin', id: stream.id }); } catch { remove(stream); }
    });
    socket.on('error', () => remove(stream));
    socket.on('close', () => remove(stream));
  });
  server.on('error', () => {});
  return {
    start() {
      if (closed) return Promise.reject(new Error('Browser Relay ended'));
      return starting ??= new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          if (closed) { server.close(); reject(new Error('Browser Relay ended')); return; }
          resolve({ port: server.address().port });
        });
      });
    },
    receive(value) {
      if (closed) throw new Error('Browser Relay ended');
      if (typeof value !== 'string') {
        if (!(value instanceof Uint8Array) || value.byteLength <= 4 || value.byteLength > CHUNK + 4) throw new Error('Invalid TCP frame');
        const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        const stream = streams.get(bytes.readUInt32BE(0));
        if (!stream) return;
        const data = bytes.subarray(4);
        if (stream.stage !== 'connected' || stream.remoteFin || data.length > stream.receiveCredit) throw new Error('Invalid TCP credit');
        stream.receiveCredit -= data.length;
        stream.socket.write(data, () => {
          if (!streams.has(stream.id) || closed) return;
          stream.receiveCredit += data.length;
          try { emit({ type: 'credit', id: stream.id, bytes: data.length }); } catch { remove(stream); }
        });
        return;
      }
      const message = JSON.parse(value);
      if (message?.type === 'pong') return;
      if (!message || !Number.isInteger(message.id) || message.id <= 0 || message.id > 0xffffffff) throw new Error('Invalid TCP control');
      const stream = streams.get(message.id);
      if (!stream) return;
      if (message.type === 'opened' && stream.stage === 'opening') {
        stream.stage = 'connected';
        clearTimeout(stream.connectTimer);
        stream.socket.write(reply(0)); pump(stream);
      } else if (message.type === 'credit') {
        if (!Number.isInteger(message.bytes) || message.bytes <= 0 || stream.credit + message.bytes > WINDOW) throw new Error('Invalid TCP credit');
        stream.credit += message.bytes; pump(stream);
      } else if (message.type === 'fin' && stream.stage === 'connected') {
        stream.remoteFin = true; stream.socket.end();
      } else if (message.type === 'close') {
        if (stream.stage === 'opening') stream.socket.end(reply(5), () => remove(stream, false));
        else if (stream.remoteFin) stream.socket.end(() => remove(stream, false));
        else remove(stream, false);
      } else throw new Error('Invalid TCP control');
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const stream of [...streams.values()]) remove(stream, false);
      await new Promise(resolve => server.close(() => resolve()));
    },
  };
}
