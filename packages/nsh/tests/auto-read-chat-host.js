/** Silent production-Chat fixture. No network, audio or real configuration. */
import { createHost as transcriptHost } from './transcript-host.js';
export function createHost() {
  const base = transcriptHost();
  let enabled = false, future = false, played = 0;
  const reply = { id: 'future-reply', type: 'assistant', finish: 'stop', time: { created: 9000, completed: 9100 }, content: [{ type: 'text', text: 'Only this future reply is spoken' }] };
  return { call(name, input) {
    if (name === 'speech.prepare') return { provider: 'browser', mode: 'final', visible: false };
    if (name === 'speech.awake') { enabled = input.enabled; return { supported: true, enabled }; }
    if (name === 'speech.stop' || name === 'speech.release') return true;
    if (name === 'speech.segment') {
      if (input.source !== 'auto-read' || input.text !== 'Only this future reply is spoken') throw new Error('Historical or non-automatic speech was admitted');
      played++; return true;
    }
    if (name === 'runtime.request' && input.path.startsWith('/api/git/status?')) return { status: 200, body: { isClean: true, files: [], current: `Played:${played}` } };
    const value = base.call(name, input);
    if (name === 'runtime.request' && input.path.startsWith('/api/session/ses_1/message?')) {
      if (enabled) future = true;
      if (future) return { ...value, body: { ...value.body, data: [reply, ...value.body.data] } };
    }
    return value;
  } };
}
