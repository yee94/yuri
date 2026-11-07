/** Isolated native engine settings fixture; never used by the production Host. */
export function createHost() {
  let attempts = 0;
  let firstBody;
  let savedTemplate = 'Original review template';
  let magicAttempts = 0;
  let magicResets = 0;
  let magicOverrides = { 'git.commit.generate.visible': 'Fixture visible override', 'git.commit.generate.instructions': 'Fixture instructions' };
  return { call(name, input) {
    if (name !== 'runtime.request') throw new Error('Unexpected settings native call');
    if (input.path === '/api/magic-prompts') {
      if (input.method === 'DELETE') magicOverrides = {};
      return { status: 200, body: { version: 1, overrides: { ...magicOverrides } } };
    }
    if (input.path.startsWith('/api/magic-prompts/')) {
      const id = decodeURIComponent(input.path.slice('/api/magic-prompts/'.length));
      if (input.method === 'PUT') {
        if (typeof input.body.text !== 'string' || !input.body.text.includes('Native edited magic')) throw new Error('Magic editor did not send its native draft');
        magicAttempts++;
        if (magicAttempts === 1) return { status: 409, body: { error: 'Magic fixture conflict' } };
        magicOverrides[id] = input.body.text;
        magicOverrides['git.commit.generate.instructions'] = `Magic writes: ${magicAttempts}`;
      } else if (input.method === 'DELETE') {
        magicResets++; delete magicOverrides[id];
        magicOverrides['git.commit.generate.instructions'] = `Magic resets: ${magicResets}`;
      } else throw new Error('Unexpected Magic prompt method');
      return { status: 200, body: { version: 1, overrides: { ...magicOverrides } } };
    }
    if (input.path === '/api/command?location%5Bdirectory%5D=%2Fnative%2Fproject') return { status: 200, body: { data: [{ name: 'review', description: attempts ? `Read-back save attempts: ${attempts}` : 'Review a change', template: savedTemplate }] } };
    if (input.path === '/api/config/commands/review?directory=%2Fnative%2Fproject' && input.method === 'PATCH') {
      if (typeof input.body.template !== 'string' || !input.body.template.includes('Native edited review')) throw new Error('Command editor did not send its native draft');
      attempts++;
      if (attempts === 1) { firstBody = JSON.stringify(input.body); return { status: 409, body: { error: 'Settings revision conflict' } }; }
      if (JSON.stringify(input.body) !== firstBody) throw new Error('Retry changed the native settings draft');
      savedTemplate = input.body.template;
      return { status: 200, body: { ok: true } };
    }
    throw new Error('Unexpected settings request');
  } };
}
