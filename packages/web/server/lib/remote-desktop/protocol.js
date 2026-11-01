const KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Home', 'End', 'PageUp', 'PageDown']);
const unit = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

export function parseDesktopMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_message');
  const { type } = value;
  if (type === 'ack' || type === 'fallback' || type === 'ping' || type === 'release') return { type };
  if (type === 'answer' && typeof value.sdp === 'string' && value.sdp.length <= 65536) return { type, sdp: value.sdp };
  if (type === 'ice' && (value.candidate === null || (typeof value.candidate === 'object'
    && typeof value.candidate.candidate === 'string' && value.candidate.candidate.length <= 2048))) {
    return { type, candidate: value.candidate === null ? null : {
      candidate: value.candidate.candidate,
      sdpMid: typeof value.candidate.sdpMid === 'string' ? value.candidate.sdpMid.slice(0, 128) : null,
      sdpMLineIndex: Number.isInteger(value.candidate.sdpMLineIndex) ? value.candidate.sdpMLineIndex : null,
    } };
  }
  if (type === 'pointer' && ['move', 'down', 'up', 'click', 'right'].includes(value.action) && unit(value.x) && unit(value.y)) {
    return { type, action: value.action, x: value.x, y: value.y };
  }
  if (type === 'scroll' && Number.isFinite(value.dx) && Number.isFinite(value.dy)) {
    return { type, dx: Math.max(-1000, Math.min(1000, value.dx)), dy: Math.max(-1000, Math.min(1000, value.dy)) };
  }
  if (type === 'text' && typeof value.text === 'string' && value.text.length > 0 && value.text.length <= 1024) return { type, text: value.text };
  if (type === 'key' && KEYS.has(value.key)) return { type, key: value.key };
  throw new Error('invalid_message');
}
