import { createHost as transcriptHost } from './transcript-host.js';

/** Production Chat wiring fixture. No real speech, provider credentials or requests. */
export function createHost() {
  const base = transcriptHost();
  return { call(name, input) {
    if (name === 'speech.prepare') return { visible: true, provider: 'openai-compatible', mode: 'sanitized' };
    if (name === 'speech.segment') throw new Error('Synthetic playback failure');
    if (name === 'speech.stop' || name === 'speech.release') return null;
    if (name === 'runtime.request' && input.path.startsWith('/api/session/child-session/message?')) return { status: 200, body: { data: [{ id: 'child-answer', type: 'assistant', finish: 'stop', time: { created: 1000, completed: 2000 }, content: [{ type: 'text', text: 'Authoritative child content' }] }] } };
    return base.call(name, input);
  } };
}
