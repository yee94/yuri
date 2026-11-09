/** Synthetic request/event fixture. Never reaches a real Host, provider or native window. */
export function createHost(player) {
  const requests = [];
  let revision = 3, fail = false, mode = '', deleteFailed = false;
  let bots = [
    { id: 'a', name: 'Research Bot', revision: 1, pinnedAt: null, enabled: true, effectiveWorkspacePath: '/workspace', unreadCount: 2, readTip: { generation: 1, messageID: 'tip-a' }, latestMessagePreview: { text: 'Authoritative latest reply', createdAt: 2 } },
    { id: 'b', name: 'Review Bot', revision: 2, pinnedAt: 10, enabled: true, effectiveWorkspacePath: '/workspace', unreadCount: 0, latestMessagePreview: { text: 'Review ready', createdAt: 1 } },
    { id: 'c', name: 'Build Bot', revision: 1, pinnedAt: null, enabled: true, effectiveWorkspacePath: '/workspace', unreadCount: 0, latestMessagePreview: { text: 'Build ready', createdAt: 0 } },
  ];
  const ok = body => ({ status: 200, body });
  return { call(name, input) {
    if (name === 'connection.list') return { selected: 'desktop-assistants', connections: [{ id: 'desktop-assistants', label: 'Synthetic Host', url: 'https://host.example', lastUsedAt: 0 }], runtimeScope: { hostID: 'desktop-assistants', lease: 'synthetic-assistants-lease' } };
    if (name !== 'runtime.request') throw new Error(`Unexpected fixture native call: ${name}`);
    const { path, method, body } = input; requests.push({ path, method, body });
    if (path === '/fixture/audit') return ok(requests);
    if (path.startsWith('/fixture/')) {
      const value = path.slice('/fixture/'.length);
      if (value === 'refresh') { bots = [...bots].reverse(); revision++; }
      if (value === 'remove-b') { bots = bots.filter(bot => bot.id !== 'b'); revision++; }
      if (value === 'restore-b') { bots = [...bots, { id: 'b', name: 'Review Bot', revision: 3, pinnedAt: 10, enabled: true, effectiveWorkspacePath: '/workspace', unreadCount: 0 }]; revision++; }
      if (value === 'remove-a') { bots = bots.filter(bot => bot.id !== 'a'); revision++; }
      if (value === 'move-a') { bots = bots.map(bot => bot.id === 'a' ? { ...bot, revision: bot.revision + 1, effectiveWorkspacePath: '/other-workspace' } : bot); revision++; }
      if (value === 'restore-a') { bots = [{ id: 'a', name: 'Research Bot', revision: 4, pinnedAt: null, enabled: true, effectiveWorkspacePath: '/workspace', unreadCount: 0 }, ...bots.filter(bot => bot.id !== 'a')]; revision++; }
      if (value === 'fail') fail = true; else { mode = value === 'refresh' ? '' : value; if (mode === 'unknown') fail = true; }
      player.hostEvent('runtime.event', { key: 'global', data: JSON.stringify({ type: 'yuri:assistants-changed', data: {} }) });
      return ok({});
    }
    if (path === '/api/yuri/assistants/capability') return ok(mode === 'unknown' ? {} : { supported: mode !== 'unsupported', enabled: mode !== 'disabled' });
    if (path === '/api/yuri/assistants/snapshot') {
      if (fail || mode === 'unsupported') { fail = false; return { status: 503, body: { error: 'synthetic_assistants_offline' } }; }
      return ok({ enabled: mode !== 'disabled', revision, assistants: mode === 'empty' ? [] : bots });
    }
    const id = path.split('/')[4], bot = bots.find(bot => bot.id === id);
    if (!bot) throw new Error(`Unexpected fixture request: ${method} ${path}`);
    if (path.endsWith('/contact/read') && method === 'POST') { bot.unreadCount = 0; revision++; return ok({ assistantID: id, generation: 1 }); }
    if (method === 'PATCH') {
      if (body.expectedRevision !== bot.revision) throw new Error('fixture_revision_conflict');
      bots = bots.map(value => ({ ...value, pinnedAt: body.pinned ? value.id === id ? 20 : null : value.id === id ? null : value.pinnedAt, revision: value.id === id ? value.revision + 1 : value.revision }));
      revision++; return ok(bots.find(value => value.id === id));
    }
    if (method === 'DELETE') {
      if (!deleteFailed) { deleteFailed = true; return { status: 503, body: { error: 'synthetic_delete_failed' } }; }
      bots = bots.filter(value => value.id !== id); revision++; return ok({ assistantID: id, tombstoneAt: 100 });
    }
    throw new Error(`Unexpected fixture request: ${method} ${path}`);
  } };
}
