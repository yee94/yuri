/** Synthetic Host only. No network, credentials, model calls or audio output. */
export function createHost() {
  let pending;
  let segments = 0;
  return { call(name) {
    if (name === 'speech.prepare') return { visible: true, provider: 'openai-compatible', mode: 'sanitized' };
    if (name === 'speech.segment') {
      if (++segments === 2) throw new Error('Neutral audio fixture failure');
      return new Promise(resolve => { pending = resolve; });
    }
    if (name === 'speech.stop' || name === 'speech.release') { pending?.(); pending = undefined; return null; }
    throw new Error('Unexpected speech fixture call');
  } };
}
