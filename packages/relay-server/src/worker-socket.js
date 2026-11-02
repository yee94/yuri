import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';

// Adapt Workers' event-target sockets to the shared engine's ws-shaped boundary.
// send() completion means runtime acceptance, not TCP drain. Workers exposes
// neither pause/resume nor bufferedAmount; do not pretend those guarantees exist.
export class WorkerRelaySocket extends EventEmitter {
  OPEN = 1;
  CLOSED = 3;
  closed = false;

  constructor(socket) {
    super();
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', ({ data }) => {
      if (this.closed) return;
      const binary = typeof data !== 'string';
      this.emit('message', Buffer.from(data), binary);
    });
    socket.addEventListener('close', ({ code, reason }) => this.finish(code, reason));
    socket.addEventListener('error', () => this.terminate());
  }

  get readyState() { return this.closed ? this.CLOSED : this.socket.readyState; }
  get bufferedAmount() { return this.socket.bufferedAmount; }

  send(data, { binary }, callback) {
    let failure;
    try {
      if (this.readyState !== this.OPEN) throw new Error('Relay socket closed');
      this.socket.send(binary ? data : data.toString('utf8'));
    } catch (error) { failure = error; }
    callback(failure);
  }

  close(code, reason) {
    if (!this.closed) this.socket.close(code, reason);
  }

  terminate() {
    try { this.close(1012, 'relay socket ended'); } catch { /* The runtime may already have closed the socket. */ }
    this.finish(1012, 'relay socket ended');
  }

  finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code, reason);
    this.removeAllListeners();
  }
}
