import { createHost as createBase } from './host.js';

export function createHost() {
  const base = createBase();
  return { call(name, input) {
    if (name === 'runtime.request' && input.path.startsWith('/api/fs/find?')) {
      return { status: 200, body: { location: { directory: '/workspace/project' }, data: input.path.includes('type=directory') ? [] : [{ path: 'src/native.ts', type: 'file' }] } };
    }
    if (name === 'runtime.request' && input.path.startsWith('/api/skill?')) return { status: 200, body: { data: [] } };
    if (name === 'runtime.request' && input.path.startsWith('/api/session?')) return { status: 200, body: { data: [], cursor: {} } };
    if (name === 'runtime.request' && input.path.startsWith('/api/session/ses_1/prompt')) {
      if (input.body.files?.[0]?.uri !== 'file:///workspace/project/src/native.ts' || !input.body.text.includes('@src/native.ts')) {
        return { status: 400, body: { message: 'Confirmed reference missing from production prompt' } };
      }
    }
    return base.call(name, input);
  } };
}
