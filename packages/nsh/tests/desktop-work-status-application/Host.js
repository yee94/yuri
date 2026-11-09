import { createHeaderHost, navigationRecord, draftKey, draftRecord } from '../desktop-header-application/Host.js';
import { navigationIdentity as identity } from '../desktop-application/NavigationHost.js';
export { navigationRecord, draftKey, draftRecord };

export function createWorkStatusHost() {
  const fixture = createHeaderHost(), read = fixture.handlers['runtime.request'];
  const childReads = [], childTranscriptReads = [], parentReads = [];
  let failChildren = false, childTitle = 'Actual child title';
  const childID = 'ses_work_status_child';
  const tasks = [
    { id: 'done', content: 'Keep completed desktop task', status: 'completed', priority: 'medium' },
    { id: 'cancelled', content: 'Keep cancelled desktop task', status: 'cancelled', priority: 'low' },
    { id: 'pending', content: 'Keep pending desktop task', status: 'pending', priority: 'high' },
  ];
  fixture.handlers['runtime.request'] = input => {
    const url = new URL(input.path, identity.origin);
    const scoped = input.method === 'GET' && input.body === undefined && input.expectedHost?.hostID === identity.hostID && input.expectedHost?.lease === identity.lease;
    if (url.pathname === '/api/session' && url.searchParams.has('parentID')) {
      if (!scoped || url.searchParams.get('parentID') !== identity.sessionID || url.searchParams.get('directory') !== identity.directory || url.searchParams.get('location[directory]') !== identity.directory || url.searchParams.get('limit') !== '200' || url.searchParams.size !== 4) throw new Error('Wrong exact-parent child read');
      childReads.push(input);
      if (failChildren) return { status: 503, body: { error: 'Synthetic child read failed' } };
      return { status: 200, body: { data: [{ id: childID, parentID: identity.sessionID, title: childTitle, location: { directory: identity.directory } }], cursor: { next: null } } };
    }
    if (url.pathname === '/api/session/' + identity.sessionID + '/message') {
      if (!scoped || url.searchParams.get('directory') !== identity.directory || url.searchParams.get('limit') !== '20' || url.searchParams.get('order') !== 'desc' || url.searchParams.size !== 3) throw new Error('Wrong parent message read');
      parentReads.push(input);
      return { status: 200, body: { data: [
        { id: 'work-status-assistant', type: 'assistant', content: [
          { type: 'text', id: 'status-text', text: 'Actual retained parent transcript' },
          { type: 'tool', id: 'todo-part', tool: 'todowrite', state: { status: 'completed', input: { todos: tasks }, output: '' } },
          { type: 'tool', id: 'task-part', tool: 'task', state: { status: 'running', input: { description: 'Historical unfinished task', subagent_type: 'explore' }, metadata: { sessionId: childID } } },
        ] },
        { id: 'work-status-user', type: 'user', model: { providerID: 'fixture', id: 'model' }, content: [{ type: 'text', text: 'Read-only WorkStatus fixture' }] },
      ], cursor: { next: null } } };
    }
    if (url.pathname === '/api/session/' + childID || url.pathname === '/api/session/' + childID + '/message') {
      if (!scoped || url.searchParams.get('directory') !== identity.directory) throw new Error('Wrong readonly child authority');
      childTranscriptReads.push(input);
      return { status: 200, body: url.pathname.endsWith('/message') ? { data: [{ id: 'child-message', type: 'assistant', content: [{ type: 'text', text: 'Verified independent child transcript' }] }], cursor: { next: null } }
        : { id: childID, parentID: identity.sessionID, title: 'Actual child title', location: { directory: identity.directory }, execution: { type: 'idle' } } };
    }
    if (url.pathname === '/api/git/status' && url.searchParams.get('mode') === 'light') {
      if (!scoped || url.searchParams.get('directory') !== identity.directory || url.searchParams.size !== 2) throw new Error('Wrong WorkStatus Git read');
      return { status: 200, body: { isGitRepository: true, current: 'actual-main', isClean: false, files: [{ path: 'readme.md', index: ' ', working_dir: 'M' }] } };
    }
    return read(input);
  };
  return { ...fixture, childReads, childTranscriptReads, parentReads, failChildren(value) { failChildren = value; }, childTitle(value) { childTitle = value; } };
}
