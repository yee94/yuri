/** Isolated native transport fixture. No real Host or model calls. */
export function createHost() {
  let sent = false;
  return {
    call(name, input) {
      if (name === 'connection.list') return { selected: 'reference-fixture', connections: [{ id: 'reference-fixture', label: 'Fixture', url: 'https://host.example', lastUsedAt: 0 }] };
      if (name === 'runtime.stream' || name === 'runtime.stop') return true;
      if (name !== 'runtime.request') throw new Error('Unexpected reference fixture native call');
      const path = input.path;
      let body;
      if (path.startsWith('/api/fs/find?')) body = { location: {}, data: [{ path: path.includes('type=directory') ? 'src/' : 'src/neutral.ts', type: path.includes('type=directory') ? 'directory' : 'file' }] };
      else if (path.startsWith('/api/agent?')) body = { location: {}, data: [{ name: 'reviewer', mode: 'subagent' }] };
      else if (path.startsWith('/api/skill?')) body = { location: {}, data: [{ id: 'real-skill', name: 'Displayed skill', path: '/skills/real-skill' }] };
      else if (path.startsWith('/api/session?')) body = { data: [{ id: 'prior', title: 'Prior neutral work', location: { directory: '/other' } }], cursor: {} };
      else if (path.startsWith('/api/session/prior/message?')) body = { data: [{ id: 'previous', type: 'user', text: 'Neutral referenced context' }], cursor: {} };
      else if (path.startsWith('/api/session/reference-chat/prompt?')) {
        const prompt = input.body;
        const valid = prompt.files?.some(file => file.uri === 'file:///workspace/src/neutral.ts')
          && prompt.files?.some(file => file.uri === 'file:///workspace/src')
          && prompt.agents?.some(agent => agent.name === 'reviewer')
          && prompt.skills?.some(skill => skill.id === 'real-skill')
          && prompt.text.includes('Neutral referenced context') && prompt.text.includes('[skill:real-skill]');
        if (!valid) return { status: 400, body: { message: 'Reference wire was incomplete' } };
        sent = true;
        body = { id: prompt.id, sessionID: 'reference-chat', type: 'user', payload: { text: prompt.text } };
      } else if (path.startsWith('/api/session/reference-chat/message?')) body = { data: sent ? [{ id: 'reply', type: 'assistant', content: [{ type: 'text', text: 'Five-domain native prompt admitted' }] }] : [], cursor: {} };
      else if (path.startsWith('/api/session/reference-chat?')) body = { data: { id: 'reference-chat', location: { directory: '/workspace' }, execution: { type: 'idle' } } };
      else if (path === '/api/session/active') body = { data: {} };
      else if (path.includes('/inbox?') || path.includes('/permission/request?') || path.includes('/form?')) body = { data: [] };
      else throw new Error('Unexpected reference fixture route');
      return { status: 200, body };
    },
  };
}
