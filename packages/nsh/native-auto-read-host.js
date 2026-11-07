/** Inert fixture Host: no network, credentials, model calls or audio output. */
export function createHost() {
  const owners = new Set();
  let prepared = 0, segments = 0, pending, fail = false;
  return { call(name, data) {
    const action = name === 'runtime.request' ? data.path : name;
    if (name.startsWith('speech.')) owners.add(data.owner);
    if (name === 'speech.prepare') { prepared++; return { visible: true, provider: 'browser', mode: 'final' }; }
    if (name === 'speech.awake') return { supported: false, enabled: false };
    if (name === 'speech.segment') {
      segments++;
      if (fail) throw new Error('Private fixture audio failure');
      return new Promise(resolve => { pending = resolve; });
    }
    if (['speech.stop', 'speech.release', '/fixture/finish'].includes(action)) { pending?.(); pending = undefined; return null; }
    if (action === '/fixture/fail') { fail = true; return null; }
    if (action === '/fixture/metrics') return `segments:${segments} owners:${owners.size} prepares:${prepared}`;
    throw new Error('Unexpected auto-read fixture call');
  } };
}
