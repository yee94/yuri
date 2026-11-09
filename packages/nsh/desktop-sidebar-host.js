/** Synthetic Host for the production desktop sidebar engine tests only. */
export function createHost(player) {
  const requests = [], pinned = new Set(['pin', 'pin-two']), deleted = new Set();
  let title = 'Desktop session', failPin = true, failRename = true, archived = false, failRead = false, failDelete = false;
  let orderMode = '', treeMode = '', order = { revision: 1, sessionOrderByScope: { '/workspace': ['head', 'z', 'a', 'running', 'old', 'hidden-rank'] }, sessionOrderActivityByScope: {} };
  let treeOrder = { projectDirectory: '/workspace', revision: 1, orderedPaths: ['/tree', '/tree-two', '/hidden-tree'] };
  let folders = { version: 1, foldersMap: {}, collapsedFolderIds: [], updatedAt: 0 };
  let treeData = false, restoreArchived = false;
  let archivedPages = false, archivedPageFail = false;
  let documentsMode = '', documentReceipts = new Map();
  let projectCatalog = [{ id: 'project', path: '/workspace', label: 'Desktop workspace' }];
  const session = (id, directory = '/workspace') => ({ id, title: id === 'head' ? title : id, location: { directory }, time: { created: 10, updated: id === 'head' ? 100 : 10, ...(id === 'head' && archived ? { archived: 100 } : {}) } });
  return { call(name, input) {
    if (name === 'connection.list') return { selected: 'desktop', connections: [{ id: 'desktop', label: 'Desktop Host', url: 'https://host.example', lastUsedAt: 0 }], runtimeScope: { hostID: 'desktop', lease: 'synthetic-desktop-lease' } };
    if (name === 'runtime.stream' || name === 'runtime.stop') return true;
    if (name.startsWith('desktop.documents.')) {
      // Audit metadata only, never a saved path or document body, even in the synthetic fixture.
      requests.push({ path: name, method: 'LOCAL', body: { requestID: input.requestID, ownerID: input.ownerID } });
      if (name === 'desktop.documents.save') {
        if (documentReceipts.has(input.requestID)) throw new Error('documents_busy_or_request_reused');
        const receipt = { requestID: input.requestID, state: documentsMode === 'cancelled' ? 'cancelled' : 'saved' };
        documentReceipts.set(input.requestID, receipt);
        if (documentsMode === 'lost-ack') { documentsMode = ''; throw new Error('synthetic_lost_ack'); }
        return receipt;
      }
      const receipt = documentReceipts.get(input.requestID); if (!receipt) throw new Error('documents_receipt_missing');
      return receipt;
    }
    if (name !== 'runtime.request') throw new Error(`Unexpected synthetic call: ${name}`);
    const { path, method, body } = input;
    requests.push({ path, method, body });
    let result;
    if (path === '/fixture/audit') result = requests;
    else if (path === '/fixture/documents-lost-ack') { documentsMode = 'lost-ack'; result = {}; }
    else if (path === '/fixture/documents-cancelled') { documentsMode = 'cancelled'; result = {}; }
    else if (path === '/fixture/tree-data') { treeData = true; result = {}; }
    else if (path === '/fixture/archived-pages') { treeData = true; archivedPages = true; result = {}; }
    else if (path === '/fixture/archived-page-fail') { archivedPageFail = true; result = {}; }
    else if (path === '/fixture/add-project') { projectCatalog.push({ id: 'other-project', path: '/other-project', label: 'Other project' }); result = {}; }
    else if (path === '/fixture/order-fail' || path === '/fixture/order-lost-ack') { orderMode = path.endsWith('fail') ? 'fail' : 'lost-ack'; result = {}; }
    else if (path === '/fixture/tree-fail' || path === '/fixture/tree-lost-ack') { treeMode = path.endsWith('fail') ? 'fail' : 'lost-ack'; result = {}; }
    else if (path === '/fixture/delete-fail') { failDelete = true; result = {}; }
    else if (path === '/fixture/read-failure') {
      failRead = true; result = {};
      player.hostEvent('runtime.event', { key: 'global', data: JSON.stringify({ type: 'yuri:session-index-changed', data: {} }) });
    }
    else if (path === '/fixture/burst') {
      for (let index = 0; index < 50; index++) player.hostEvent('runtime.event', { key: 'global', data: JSON.stringify({ type: 'session.part.text.delta', data: { sessionID: 'head', text: String(index) } }) });
      result = {};
    }
    else if (path === '/api/yuri/session-index' && failRead) { failRead = false; return { status: 503, body: { error: 'Synthetic catalog retry' } }; }
    else if (path === '/api/yuri/session-index') result = { available: true, pinnedSessionIds: [...pinned], directories: [
      { directory: '/workspace', sessions: ['head', 'pin', 'pin-two', 'z', 'a', 'running', 'old'].filter(id => !deleted.has(id) && (id !== 'head' || !archived)).map(id => session(id)), hasMore: true },
      { directory: '/tree', sessions: [session('tree', '/tree')], hasMore: false },
      { directory: '/tree-two', sessions: [session('tree-two', '/tree-two')], hasMore: false },
    ] };
    else if (path === '/api/session-folders') { if (method === 'POST') { folders = body; result = { success: true }; } else result = folders; }
    else if (path === '/api/session-folders/order') {
      if (method === 'POST') {
        const mode = orderMode; orderMode = '';
        if (mode === 'fail') return { status: 503, body: { error: 'Synthetic order retry' } };
        order = { revision: order.revision + 1, sessionOrderByScope: { ...order.sessionOrderByScope, [body.scopeKey]: body.order }, sessionOrderActivityByScope: { ...order.sessionOrderActivityByScope, [body.scopeKey]: body.activity } };
        if (mode === 'lost-ack') return { status: 503, body: { error: 'Synthetic order lost ACK' } };
      }
      result = order;
    }
    else if (path === '/api/session/active') result = { data: { running: { type: 'running' } } };
    else if (path.startsWith('/api/git/worktrees?')) result = [{ path: '/workspace', name: 'main', branch: 'main' }, { path: '/tree', name: 'tree', branch: 'feature/desktop' }, { path: '/tree-two', name: 'tree-two', branch: 'feature/second' }];
    else if (path.startsWith('/api/yuri/message-queue/worktrees/order?')) result = treeOrder;
    else if (path === '/api/yuri/message-queue/worktrees/order' && method === 'PUT') {
      const mode = treeMode; treeMode = '';
      if (mode === 'fail') return { status: 503, body: { error: 'Synthetic tree retry' } };
      if (body.expectedRevision !== treeOrder.revision) return { status: 409, body: { error: 'Synthetic tree conflict' } };
      treeOrder = { projectDirectory: body.projectDirectory, revision: treeOrder.revision + 1, orderedPaths: body.orderedPaths };
      if (mode === 'lost-ack') return { status: 503, body: { error: 'Synthetic tree lost ACK' } };
      result = { revision: treeOrder.revision };
    }
    else if (path === '/api/config/settings') { if (method === 'PUT') projectCatalog = body.projects; result = { projects: projectCatalog, activeProjectId: 'project' }; }
    else if (treeData && path.startsWith('/api/session/head/message?')) result = { data: [{ id: path.includes('cursor=older') ? 'message-old' : 'message-new', sessionID: 'head', type: 'user', text: path.includes('cursor=older') ? 'Earlier exported text' : 'Later exported text' }], cursor: path.includes('cursor=older') ? {} : { next: 'older' } };
    else if (path.startsWith('/api/session?') && path.includes('archived=')) throw new Error('session.list does not accept synthetic archive filters');
    else if (treeData && path.startsWith('/api/session?') && path.includes('cursor=child-page')) {
      if (path.includes('directory=') || path.includes('parentID=')) throw new Error('child cursor owns its scope');
      result = { data: [{ ...session('child-a'), parentID: 'head' }], cursor: {} };
    }
    else if (treeData && path.startsWith('/api/session?') && path.includes('parentID=head')) result = { data: [{ ...session('child-z'), parentID: 'head' }, { ...session('archived-child'), parentID: 'head', time: { archived: 10 } }], cursor: { next: 'child-page' } };
    else if (treeData && path.startsWith('/api/session?') && path.includes('parentID=child-z')) result = { data: [{ ...session('grandchild'), parentID: 'child-z' }], cursor: {} };
    else if (archivedPages && path.startsWith('/api/session?') && path.includes('cursor=archive-next')) {
      if (archivedPageFail) { archivedPageFail = false; return { status: 503, body: { error: 'Synthetic archived page retry' } }; }
      result = { data: deleted.has('archived-folded') ? [] : [{ ...session('archived-folded'), time: { created: 10, updated: 10, archived: 10 } }], cursor: {} };
    }
    else if (treeData && path.startsWith('/api/session?') && path.includes('parentID=null')) {
      const directory = decodeURIComponent(path.match(/[?&]directory=([^&]*)/)?.[1] || '');
      result = { data: [session('older', directory), ...(directory === '/workspace' && !restoreArchived && !deleted.has('archived-z') ? [{ ...session('archived-z'), time: { created: 10, updated: 10, archived: 10 } }] : [])], cursor: archivedPages && directory === '/workspace' ? { next: 'archive-next' } : {} };
    }
    else if (treeData && path === '/api/yuri/sessions/archived-z/archive') { restoreArchived = true; result = { session: session('archived-z') }; }
    else if (treeData && path.startsWith('/api/session/archived-z?')) result = { data: { ...session('archived-z'), time: { created: 10, updated: 10, ...(restoreArchived ? {} : { archived: 10 }) } } };
    else if (method === 'GET' && path.startsWith('/api/session/') && path.includes('?') && !path.includes('/message?')) { const target = path.split('/')[3].split('?')[0], directory = decodeURIComponent(path.match(/[?&]directory=([^&]*)/)?.[1] || '/workspace'); result = { data: session(target, directory) }; }
    else if (path.startsWith('/api/session?') && path.includes('parentID=head')) result = { data: [], cursor: {} };
    else if (archivedPages && path.startsWith('/api/session?') && path.includes('parentID=archived-')) result = { data: [], cursor: {} };
    else if (path.startsWith('/api/session?')) result = { data: [session('older')], cursor: {} };
    else if (path === '/api/yuri/session-index/session/head/pin') {
      if (failPin) { failPin = false; return { status: 503, body: { error: 'Synthetic pin retry' } }; }
      if (method === 'DELETE') pinned.delete('head'); else pinned.add('head'); result = {};
    } else if (path === '/api/yuri/sessions/head/metadata') {
      if (failRename) { failRename = false; return { status: 503, body: { error: 'Synthetic rename retry' } }; }
      result = { metadata: body.patch };
    } else if (path === '/api/session/head' && method === 'PATCH') { title = body.title; result = session('head'); }
    else if (path === '/api/yuri/sessions/head/archive') { archived = body.archivedAt > 0; result = { session: session('head') }; }
    else if (path.split('?')[0] === '/api/session/head' && method === 'DELETE') {
      if (failDelete) { failDelete = false; return { status: 503, body: { error: 'Synthetic delete retry' } }; }
      deleted.add('head'); result = true;
    }
    else if (archivedPages && path.startsWith('/api/session/archived-') && method === 'DELETE') { deleted.add(path.split('/')[3].split('?')[0]); result = true; }
    else if (path.startsWith('/api/location') || path.includes('/form') || path.includes('/permission')) result = { data: [] };
    else throw new Error(`Unexpected synthetic request: ${path}`);
    return { status: 200, body: result };
  } };
}
