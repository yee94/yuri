/** In-memory authority fixture. No user connections, credentials or real Host writes. */
export function createHost() {
  const requests = [];
  let disabled = false, created = false;
  let folders = { version: 1, foldersMap: { '/workspace': [{ id: 'folder', name: 'Synthetic folder', sessionIds: [], createdAt: 1 }] }, collapsedFolderIds: [], updatedAt: 1 };
  const session = id => ({ id, title: id, location: { directory: '/workspace' }, time: { created: 1, updated: 1 }, ...(id === 'root' ? { hasChildren: true } : {}) });
  const snapshot = () => ({ enabled: !disabled, revision: disabled ? 2 : 1, assistants: disabled ? [] : [{ id: 'bot', revision: 1, enabled: true, working: true, activeContactTurn: null, name: 'Synthetic bot', effectiveWorkspacePath: '/workspace', avatarSeed: 'saved-authority-artwork', unreadCount: 102, latestMessagePreview: { messageID: 'message', ordinal: 1, role: 'assistant', text: 'Preview', fallbackKind: null, createdAt: 1 } }] });
  return { call(name, input) {
    if (name === 'connection.list') return { selected: 'fixture', connections: [{ id: 'fixture', label: 'Fixture', url: 'https://host.example', authorizationID: 'synthetic-authorization', lastUsedAt: 0 }], runtimeScope: { hostID: 'fixture', lease: 'fixture-lease' } };
    if (name === 'runtime.stream' || name === 'runtime.stop') return true;
    if (name !== 'runtime.request') throw new Error('unexpected_native_call');
    const { path, method, body } = input; requests.push({ path, method }); let result;
    if (path === '/fixture/authority-audit') result = requests;
    else if (path === '/fixture/authority-disable') { disabled = true; result = {}; }
    else if (path === '/api/config/settings') result = { projects: [{ id: 'project', path: '/workspace', name: 'Workspace' }] };
    else if (path === '/api/yuri/session-index') result = { available: true, directories: [{ directory: '/workspace', sessions: [session('root'), ...(created ? [session('created')] : [])], hasMore: false }], pinnedSessionIds: [] };
    else if (path === '/api/yuri/assistants/snapshot') result = snapshot();
    else if (path === '/api/yuri/assistants/capability') result = { supported: true, enabled: true, revision: disabled ? 2 : 1 };
    else if (path === '/api/yuri/scheduled-tasks') result = { tasks: [{ projectId: 'project', task: { id: 'task', state: { lastStatus: 'running' } } }], failedProjectIds: [] };
    else if (path === '/api/session-folders/order') result = { revision: 1, sessionOrderByScope: {}, sessionOrderActivityByScope: {} };
    else if (path.startsWith('/api/yuri/message-queue/worktrees/order?')) result = { projectDirectory: '/workspace', revision: 1, orderedPaths: [] };
    else if (path === '/api/session-folders') { if (method === 'POST') { folders = body; result = { success: true }; } else result = folders; }
    else if (path === '/api/session' && method === 'POST') { created = true; result = { data: session('created') }; }
    else if (path.startsWith('/api/session/created?')) result = { data: session('created') };
    else if (path === '/api/session/active') result = {};
    else if (path.startsWith('/api/session?')) result = { data: [], cursor: {} };
    else if (path.startsWith('/api/git/worktrees?') || path === '/api/debug/location') result = [];
    else throw new Error(`unexpected_fixture_request:${method}:${path}`);
    return { status: 200, body: result };
  } };
}
