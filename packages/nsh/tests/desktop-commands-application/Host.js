import { createNavigationHost, isNavigationReadOnlyGoalRPC, navigationIdentity as identity } from '../desktop-application/NavigationHost.js';

export { identity };
export const authority = JSON.stringify([identity.hostID, identity.origin, identity.authorizationID]);
export const draftKey = 'nsh:chat-draft:v1:' + encodeURIComponent(JSON.stringify([identity.hostID, identity.directory, 'session', identity.sessionID, authority]));
export const attachment = { uri: 'file:///synthetic/retained.txt', name: 'retained.txt', mime: 'text/plain' };
export const draftRecord = (draft, attachments = []) => JSON.stringify({ version: 1, revision: 1, draft, references: [], attachments, pendingSend: null, queueEdit: null });
export const navigationRecord = JSON.stringify({ version: 1, entries: [{ partition: { connectionID: identity.hostID, origin: identity.origin, authorizationID: identity.authorizationID }, target: { kind: 'session', sessionID: identity.sessionID, directory: identity.directory } }] });
export const newDraftKey = 'nsh:chat-draft:v1:' + encodeURIComponent(JSON.stringify([identity.hostID, identity.directory, 'session', 'new-session-draft', authority]));
export const newDraftNavigation = (() => {
  const envelope = JSON.parse(navigationRecord);
  envelope.entries[0].target = { kind: 'new-session', projectID: identity.projectID, directory: identity.directory };
  return JSON.stringify(envelope);
})();

/** Uses the strict read-only Host; the only admitted mutation is an exact prompt. */
export function createCommandsHost() {
  return createSessionCommandsHost(identity.sessionID);
}

function createSessionCommandsHost(sessionID) {
  const fixture = createNavigationHost(), prompts = [];
  let unknown = false, verified = false;
  const targetPath = '/api/session/' + sessionID, originalPath = '/api/session/' + identity.sessionID;
  const request = fixture.handlers['runtime.request'];
  fixture.handlers['runtime.request'] = input => {
    if (input.path === targetPath + '/prompt?directory=' + encodeURIComponent(identity.directory) && input.method === 'POST') {
      fixture.writer.assertWrite(input, { kind: 'session', id: sessionID });
      const body = input.body;
      if (!body || typeof body.id !== 'string' || !body.id || typeof body.text !== 'string' || body.delivery !== 'steer' || body.files !== undefined
        || Object.keys(body).some(key => !['id', 'text', 'delivery', 'files', 'agents', 'skills', 'metadata'].includes(key))
        || input.expectedHost?.hostID !== identity.hostID || input.expectedHost?.lease !== identity.lease) throw new Error('Invalid local magic admission');
      prompts.push(input);
      if (unknown) throw new Error('Synthetic lost magic ACK');
      return { status: 200, body: { id: body.id, sessionID, type: 'user', text: body.text, delivery: 'steer', state: 'queued' } };
    }
    if (input.path.startsWith(targetPath + '/message/') && input.method === 'GET') {
      const prompt = prompts.at(-1), id = input.path.split('/message/')[1].split('?')[0];
      return prompt && prompt.body.id === id && verified
        ? { status: 200, body: { id, sessionID, role: 'user', text: prompt.body.text, time: { created: 4 } } }
        : { status: 404, body: { error: 'Not yet verified' } };
    }
    if (input.path.split('?')[0] === '/api/command' && input.method === 'GET') return { status: 200, body: { data: [{ name: 'compact', description: 'Host collision must not execute' }, { name: 'btw', description: 'Unbound Host collision must not execute' }] } };
    if (input.path === targetPath + '?directory=' + encodeURIComponent(identity.directory) && input.method === 'GET') {
      const response = request({ ...input, path: input.path.replace(targetPath, originalPath) });
      return { ...response, body: { ...response.body, id: sessionID,
        ...(sessionID === identity.sessionID ? {} : { title: 'Local magic created session' }), model: { providerID: 'fixture', id: 'model' } } };
    }
    if (input.method === 'GET' && input.path.startsWith(targetPath + '/')) return request({ ...input, path: input.path.replace(targetPath, originalPath) });
    return request(input);
  };
  return { ...fixture, prompts, loseAck() { unknown = true; }, verify() { verified = true; unknown = false; } };
}

export function createBtwHost() {
  const fixture = createCommandsHost(), requests = [], cancels = [], seen = new Set();
  const read = fixture.handlers['runtime.request'];
  fixture.handlers['runtime.request'] = input => {
    if (input.method === 'GET' && input.path === '/api/git/remotes?directory=' + encodeURIComponent(identity.directory)
      && input.expectedHost?.hostID === identity.hostID && input.expectedHost?.lease === identity.lease) return { status: 200, body: [] };
    return read(input);
  };
  const caps = { version: 1, request: true, cancel: true, windowID: 'commands-window', maxRequests: 4096, maxConcurrent: 8, timeoutMs: 30000 };
  fixture.handlers['runtime.http.capabilities'] = input => { if (Object.keys(input).length) throw new Error('Invalid HTTP discovery'); return caps; };
  fixture.handlers['runtime.http.request'] = input => {
    if (input.windowID !== caps.windowID || input.expectedHost?.hostID !== identity.hostID || input.expectedHost?.lease !== identity.lease
      || typeof input.ownerID !== 'string' || typeof input.requestID !== 'string' || seen.has(input.requestID)
      || Object.keys(input).sort().join(',') !== 'body,expectedHost,method,ownerID,path,requestID,windowID' || input.method !== 'POST') throw new Error('Invalid BTW HTTP receipt');
    seen.add(input.requestID); requests.push(input);
    const base = '/api/session/' + identity.sessionID;
    if (input.path === base + '/model' && JSON.stringify(input.body) === JSON.stringify({ model: { providerID: 'fixture', id: 'model' } })) return { status: 204, body: null };
    if (input.path === base + '/agent' && JSON.stringify(input.body) === JSON.stringify({ agent: 'build' })) return { status: 204, body: null };
    if (input.path === base + '/generate' && Object.keys(input.body).join(',') === 'prompt' && typeof input.body.prompt === 'string') return { status: 200, body: { data: { text: 'Actual side answer, no main prompt' } } };
    throw new Error('Invalid BTW wire');
  };
  fixture.handlers['runtime.http.cancel'] = input => { cancels.push(input); return { ok: true }; };
  return { ...fixture, requests, cancels };
}

export function createDraftCommandsHost() {
  const createdID = 'created-from-local', targetPath = '/api/session/' + createdID;
  const fixture = createSessionCommandsHost(createdID), request = fixture.handlers['runtime.request'], creates = [], configurations = [];
  let lostCreate = false;
  fixture.handlers['runtime.request'] = input => {
    const path = input.path.split('?')[0];
    if (input.method === 'POST' && path === '/api/session') {
      fixture.writer.assertWrite(input, { kind: 'new-session', id: identity.directory });
      if (input.path !== path || JSON.stringify(input.body) !== JSON.stringify({ location: { directory: identity.directory } })
        || input.expectedHost?.hostID !== identity.hostID || input.expectedHost?.lease !== identity.lease) throw new Error('Wrong local create authority');
      creates.push(input);
      if (lostCreate) throw new Error('Synthetic lost create ACK');
      return { status: 200, body: { id: createdID, title: 'Local magic created session', location: { directory: identity.directory } } };
    }
    if (input.method === 'GET' && input.path === '/api/git/check?directory=' + encodeURIComponent(identity.directory)) return { status: 200, body: { isGitRepository: false } };
    if (path === targetPath || path.startsWith(targetPath + '/')) {
      if (input.method === 'POST' && [targetPath + '/model', targetPath + '/agent'].includes(path)) {
        fixture.writer.assertWrite(input, { kind: 'session', id: createdID });
        if (input.path !== path + '?directory=' + encodeURIComponent(identity.directory)
          || input.expectedHost?.hostID !== identity.hostID || input.expectedHost?.lease !== identity.lease
          || path.endsWith('/model') && JSON.stringify(input.body) !== JSON.stringify({ model: { providerID: 'fixture', id: 'model' } })
          || path.endsWith('/agent') && JSON.stringify(input.body) !== JSON.stringify({ agent: 'build' })) throw new Error('Wrong initial selection wire');
        configurations.push(input); return { status: 204, body: null };
      }
      return request(input);
    }
    if (input.body?.input?.sessionID === createdID && isNavigationReadOnlyGoalRPC({ ...input, body: { ...input.body, input: { ...input.body.input, sessionID: identity.sessionID } } })) return { status: 200, body: { output: null } };
    return request(input);
  };
  return { ...fixture, creates, configurations, createdID, loseCreate() { lostCreate = true; } };
}

export const panelRecord = JSON.stringify({ version: 1, scopes: [{
  scope: { host: { hostID: identity.hostID }, authorityKey: authority, sessionID: identity.sessionID, directory: identity.directory },
  tabs: [{ id: JSON.stringify(['chat', identity.directory, 'child']), kind: 'chat', target: { sessionID: 'child', directory: identity.directory, title: 'Child conversation' } }],
  selectedID: JSON.stringify(['chat', identity.directory, 'child']), rail: null, activeView: 'preview',
}] });
export const contextRecord = (() => {
  const envelope = JSON.parse(panelRecord), scope = envelope.scopes[0];
  scope.tabs = [{ id: 'context', kind: 'context' }]; scope.selectedID = 'context';
  return JSON.stringify(envelope);
})();
export function createEmbeddedHost() {
  const fixture = createCommandsHost(), request = fixture.handlers['runtime.request'];
  fixture.handlers['runtime.request'] = input => {
    const path = input.path.split('?')[0];
    for (const id of ['child', 'grandchild']) {
      if (path === '/api/session/' + id && input.method === 'GET') return { status: 200, body: {
        id, parentID: identity.sessionID, title: 'Verified ' + id, location: { directory: identity.directory }, time: { created: 1, updated: 2 }, execution: { type: 'idle' },
      } };
      if (path === '/api/session/' + id + '/message' && input.method === 'GET') return { status: 200, body: {
        data: [{ id: id + '-reply', role: 'assistant', parts: [{ type: 'text', text: 'Read-only actual ' + id },
          ...(id === 'child' ? [{ type: 'card', cardType: 'session', sessionID: 'grandchild', directory: identity.directory, title: 'Nested card target' }] : [])], time: { created: 2, completed: 3 } }],
        cursor: { next: null }, complete: true,
      } };
    }
    return request(input);
  };
  return fixture;
}

export function createPanelStreamHost({ capacity = false } = {}) {
  const fixture = createEmbeddedHost(), stream = fixture.handlers['runtime.stream'], stop = fixture.handlers['runtime.stop'];
  const request = fixture.handlers['runtime.request'];
  fixture.handlers['runtime.request'] = input => {
    if (input.method === 'GET' && input.path === '/api/git/remotes?directory=' + encodeURIComponent(identity.directory)
      && input.expectedHost?.hostID === identity.hostID && input.expectedHost?.lease === identity.lease) return { status: 200, body: [] };
    return request(input);
  };
  const starts = [], stops = [];
  const capability = { schemaVersion: 1, panelChat: { supported: true, maxStreams: 4, keyFormat: 'panel-chat:<owner>:<activation>', maxID: Number.MAX_SAFE_INTEGER, path: '/api/event', queryKeys: ['directory'], requiresExpectedHost: true } };
  fixture.handlers['runtime.stream.capabilities'] = input => {
    if (Object.keys(input).length) throw new Error('Nonempty stream capability request');
    return capability;
  };
  fixture.handlers['runtime.stream'] = input => {
    if (!input.key.startsWith('panel-chat:')) return stream(input);
    if (!/^panel-chat:[1-9][0-9]*:[1-9][0-9]*$/.test(input.key) || input.path !== '/api/event?directory=' + encodeURIComponent(identity.directory)
      || input.expectedHost?.hostID !== identity.hostID || input.expectedHost?.lease !== identity.lease) throw new Error('Invalid panel stream admission');
    starts.push(input); if (capacity) throw new Error('runtime_stream_capacity'); return true;
  };
  fixture.handlers['runtime.stop'] = input => {
    if (!input.key.startsWith('panel-chat:')) return stop(input);
    if (input.expectedHost?.hostID !== identity.hostID || input.expectedHost?.lease !== identity.lease || !starts.some(row => row.key === input.key)) throw new Error('Invalid panel stream cleanup');
    stops.push(input); return true;
  };
  return { ...fixture, starts, stops };
}

export const embeddedToolsDirectory = '/fixture/child-worktree';
export const embeddedToolsRecord = (() => {
  const envelope = JSON.parse(panelRecord), scope = envelope.scopes[0], tab = scope.tabs[0];
  tab.target.directory = embeddedToolsDirectory;
  tab.id = scope.selectedID = JSON.stringify(['chat', embeddedToolsDirectory, 'child']);
  return JSON.stringify(envelope);
})();
export function createEmbeddedToolsHost() {
  const fixture = createEmbeddedHost(), request = fixture.handlers['runtime.request'];
  fixture.handlers['runtime.request'] = input => {
    const path = input.path.split('?')[0];
    if (input.method === 'GET' && (path === '/api/session/child' || path === '/api/session/child/message')) {
      if (!input.path.includes('directory=' + encodeURIComponent(embeddedToolsDirectory)) || input.expectedHost?.hostID !== identity.hostID || input.expectedHost?.lease !== identity.lease) throw new Error('Wrong child tool authority');
      if (path === '/api/session/child') return { status: 200, body: { id: 'child', parentID: identity.sessionID, location: { directory: embeddedToolsDirectory }, title: 'Child tool snapshot' } };
      return { status: 200, body: { data: [{ id: 'child-tool-message', type: 'assistant', finish: 'stop', content: [
        { type: 'tool', id: 'fixed-edit', name: 'edit', state: { status: 'completed', input: { filePath: embeddedToolsDirectory + '/snapshot.ts', oldString: 'EXACT HISTORICAL BEFORE', newString: 'EXACT HISTORICAL AFTER' } } },
        { type: 'text', text: 'Read-only child tool snapshot' },
      ] }], cursor: { next: null } } };
    }
    return request(input);
  };
  return fixture;
}

export function createContentLinksHost({ btw = false } = {}) {
  const fixture = btw ? createBtwHost() : createEmbeddedToolsHost(), request = fixture.handlers['runtime.request'];
  const fileReads = [], resources = [], body = 'Exact linked file\nSecond line\nThird line';
  fixture.handlers['runtime.request'] = input => {
    const url = new URL(input.path, identity.origin);
    if (input.method === 'GET' && input.expectedHost?.hostID === identity.hostID && input.expectedHost?.lease === identity.lease) {
      if (url.searchParams.get('directory') === embeddedToolsDirectory && url.searchParams.size === 1) {
        if (url.pathname === '/api/git/check') return { status: 200, body: { isGitRepository: true } };
        if (url.pathname === '/api/git/status') return { status: 200, body: { isClean: true, files: [] } };
        if (url.pathname === '/api/git/branches') return { status: 200, body: { current: 'main', all: ['main'] } };
        if (url.pathname === '/api/git/remotes') return { status: 200, body: [] };
      }
      if (url.pathname === '/api/session/' + identity.sessionID + '/message' || url.pathname === '/api/session/child/message') {
        const child = url.pathname.includes('/child/');
        return { status: 200, body: { data: [{ id: child ? 'child-link' : 'main-link', role: 'assistant',
          parts: [{ type: 'text', text: `[${child ? 'Child file' : 'Main file'}](readme.md#L2)\n\n[Host preview](http://localhost:3000/example)\n\n[Other Host preview](http://localhost:3000/other)\n\n[Unavailable anchor](#heading)` }], time: { created: 2, completed: 3 } }], cursor: { next: null } } };
      }
      if (['/api/fs/stat', '/api/fs/read'].includes(url.pathname) && url.searchParams.size === 2 && [identity.directory, embeddedToolsDirectory].includes(url.searchParams.get('directory')) && url.searchParams.get('path') === url.searchParams.get('directory') + '/readme.md') {
        fileReads.push(input);
        return { status: 200, body: url.pathname.endsWith('/stat') ? { path: url.searchParams.get('path'), isFile: true, isBinary: false, size: body.length, mtimeMs: 1, mimeType: 'text/plain' } : body };
      }
      if (url.pathname === '/api/git/remotes' && url.searchParams.get('directory') === identity.directory) return { status: 200, body: [] };
    }
    return request(input);
  };
  fixture.handlers['resources.read'] = input => {
    if (Object.keys(input).sort().join(',') !== 'expectedHost,path,requestId' || input.path !== embeddedToolsDirectory + '/readme.md'
      || input.expectedHost?.hostID !== identity.hostID || input.expectedHost?.lease !== identity.lease || !input.requestId) throw new Error('Wrong exact child resource scope');
    resources.push(input);
    return { kind: 'text', path: input.path, text: body, mime: 'text/plain', lease: 'content-link-lease' };
  };
  fixture.handlers['resources.close'] = () => true; fixture.handlers['resources.release'] = () => true;
  if (btw) {
    const generate = fixture.handlers['runtime.http.request'];
    fixture.handlers['runtime.http.request'] = input => {
      const result = generate(input);
      return input.path.endsWith('/generate') ? { status: 200, body: { data: { text: '[Side file](readme.md#L2)\n\n[Side anchor](#heading)' } } } : result;
    };
  }
  return { ...fixture, fileReads, resources };
}

export function createHistoryHost() {
  const fixture = createCommandsHost(), request = fixture.handlers['runtime.request'], writes = [];
  const messages = [1, 2, 3].flatMap(index => [
    { id: 'history-user-' + index, type: 'user', role: 'user', parts: [{ type: 'text', text: 'History question ' + index }], time: { created: index * 10 } },
    { id: 'history-answer-' + index, type: 'assistant', role: 'assistant', parts: [{ type: 'text', text: 'History answer ' + index }], time: { created: index * 10 + 1, completed: index * 10 + 2 } },
  ]);
  let revert = null, loseAck = false, paginated = false;
  const historyPages = [];
  const base = '/api/session/' + identity.sessionID;
  fixture.handlers['runtime.request'] = input => {
    const path = input.path.split('?')[0];
    if (input.body?.input?.sessionID === 'history-fork' && isNavigationReadOnlyGoalRPC({ ...input, body: { ...input.body, input: { ...input.body.input, sessionID: identity.sessionID } } })) return { status: 200, body: { output: null } };
    if (input.method === 'GET' && (path === '/api/session/history-fork' || path.startsWith('/api/session/history-fork/'))) {
      const response = request({ ...input, path: input.path.replace('/api/session/history-fork', base) });
      return path === '/api/session/history-fork' ? { ...response, body: { ...response.body, id: 'history-fork', title: 'Acknowledged history fork' } } : response;
    }
    if (input.method === 'GET' && path === base) {
      const response = request(input);
      return { ...response, body: { ...response.body, revert } };
    }
    if (input.method === 'GET' && path === base + '/message') {
      historyPages.push(input);
      const older = input.path.includes('&cursor=history-older');
      if (input.path.includes('&cursor=') && !older) throw new Error('Invalid history cursor');
      const data = paginated ? older ? messages.slice(0, 2) : messages.slice(2) : messages;
      return { status: 200, body: { data: [...data].reverse(), cursor: { next: paginated && !older ? 'history-older' : null } } };
    }
    if (input.method === 'GET' && path.startsWith(base + '/message/')) {
      const message = messages.find(row => row.id === path.slice((base + '/message/').length));
      if (!message) throw new Error('Unknown historical message');
      return { status: 200, body: message };
    }
    if (input.method === 'GET' && path === '/api/session/active') return { status: 200, body: {} };
    if (input.method === 'POST' && path === base + '/fork') {
      if (input.path !== path + '?directory=' + encodeURIComponent(identity.directory)
        || input.expectedHost?.hostID !== identity.hostID || input.expectedHost?.lease !== identity.lease
        || !input.body || Object.keys(input.body).some(key => key !== 'before')
        || input.body.before !== undefined && !messages.some(row => row.id === input.body.before)) throw new Error('Wrong fork authority or boundary');
      writes.push(input);
      if (loseAck) throw new Error('Synthetic lost fork ACK');
      return { status: 200, body: { id: 'history-fork', title: 'Acknowledged history fork', location: { directory: identity.directory } } };
    }
    if (input.method === 'POST' && path === base + '/revert/stage' || input.method === 'DELETE' && path === base + '/revert') {
      if (input.path !== path + '?directory=' + encodeURIComponent(identity.directory)
        || input.expectedHost?.hostID !== identity.hostID || input.expectedHost?.lease !== identity.lease) throw new Error('Wrong historical write authority');
      if (input.method === 'POST' && (input.body?.files !== true || !messages.some(row => row.type === 'user' && row.id === input.body.messageID)
        || Object.keys(input.body).sort().join(',') !== 'files,messageID')) throw new Error('Invalid history stage');
      writes.push(input);
      revert = input.method === 'DELETE' ? null : { messageID: input.body.messageID, files: [] };
      if (loseAck) throw new Error('Synthetic lost history ACK');
      return { status: 200, body: revert };
    }
    return request(input);
  };
  return { ...fixture, writes, historyPages, paginateHistory() {
    paginated = true;
    for (let index = 4; index <= 11; index++) messages.push(
      { id: 'history-user-' + index, type: 'user', role: 'user', parts: [{ type: 'text', text: 'History question ' + index }], time: { created: index * 10 } },
      { id: 'history-answer-' + index, type: 'assistant', role: 'assistant', parts: [{ type: 'text', text: 'History answer ' + index }], time: { created: index * 10 + 1, completed: index * 10 + 2 } },
    );
  }, loseHistoryAck() { loseAck = true; } };
}
