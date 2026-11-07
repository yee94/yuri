/** Synthetic production-App fixture: no fetch, filesystem, model, Git or real Host calls. */
const directory = '/workspace/project';
const scope = 'directory=%2Fworkspace%2Fproject';
const session = '/api/session/ses_1';
const rpc = '/api/rpc/opencode.goal/get?location%5Bdirectory%5D=%2Fworkspace%2Fproject';
const objective = 'Synthetic busy Goal objective';
const queuedText = 'Synthetic ordinary queued follow-up';
const initialGoal = {
  id: 'goal-synthetic', objective: 'Synthetic existing Goal', status: 'active',
  rounds: 2, maxRounds: 20, stalls: 0, boot: 'synthetic-process', updatedAt: 1000,
  reason: 'Synthetic authoritative Goal reason',
};

export function createHost(options = {}) {
  // Isolate durable drafts even if a headless runtime shares Storage across Host bundles.
  const hostID = `goal-tasks-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const modelID = options.modelID ?? 'Native test model';
  const modelName = options.modelName ?? 'Native test model';
  const variant = options.variant ?? 'high';
  let goal = { ...initialGoal }, revision = 0;
  let pauses = 0, resumes = 0, clears = 0, objectives = 0, prompts = 0, selection = 0, faults = 0;
  let appearanceRevision = 0;
  let settingsReads = 0;
  let notificationLease = null;
  const inbox = [];
  const receipt = () => `GOAL_FIXTURE pause=${pauses} resume=${resumes} clear=${clears} objective=${objectives} prompt=${prompts} selection=${selection} faults=${faults}`;
  const ok = body => ({ status: 200, body });
  const reject = message => { faults++; throw new Error(`Goal fixture rejected: ${message}`); };
  const authority = () => ({ id: 'ses_1', title: 'Native conversation', directory,
    execution: { type: 'running' }, model: { id: modelID, providerID: 'fixture', variant }, agent: 'build' });
  const history = [{ id: 'synthetic-plan', type: 'assistant', time: { created: 1000, completed: 2000 }, finish: 'tool-calls', content: [
    { type: 'tool', id: 'synthetic-todowrite', name: 'todowrite', state: { status: 'completed', input: JSON.stringify({ todos: [
      { id: 'synthetic-done', content: 'Synthetic completed task', status: 'completed', priority: 'medium' },
      { id: 'synthetic-active', content: 'Synthetic active task', status: 'in_progress', priority: 'high' },
      { id: 'synthetic-pending', content: 'Synthetic pending task', status: 'pending', priority: 'low' },
    ] }) } },
  ] }];
  function gitStatus() {
    return { isClean: false, isGitRepository: true, current: receipt(), files: [
      { path: 'synthetic-goal.txt', index: ' ', working_dir: 'M' },
      { path: 'synthetic-tasks.txt', index: ' ', working_dir: 'M' },
    ], diffStats: { 'synthetic-goal.txt': { insertions: 2, deletions: 1 }, 'synthetic-tasks.txt': { insertions: 1, deletions: 0 } } };
  }
  return { call(name, input = {}) {
    if (name === 'connection.list') return { selected: hostID, connections: [{ id: hostID, label: 'Synthetic Host', url: 'https://host.example', lastUsedAt: 0 }] };
    if (name === 'runtime.stop') return true;
    if (name === 'runtime.stream') {
      if ((input.key === 'global' && input.path === '/api/yuri/events') || (input.key === 'chat' && input.path === `/api/event?${scope}`)) return true;
      return reject('stream scope');
    }
    if (name === 'appearance.reset') return { revision: ++appearanceRevision };
    if (name === 'appearance.apply') return { applied: true, revision: input.revision };
    if (name === 'speech.prepare') return { provider: 'browser', visible: false, mode: 'final' };
    if (name === 'speech.stop' || name === 'speech.release') return true;
    if (name === 'notification.configure') {
      const events = ['completion', 'error', 'question', 'permission', 'schedule', 'assistant', 'goal'];
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'enabled,events,hostID,language,mode' ||
        !settingsReads || input.hostID !== hostID || input.enabled !== false || input.mode !== 'hidden-only' || input.language !== 'en' ||
        !Array.isArray(input.events) || JSON.stringify(input.events) !== JSON.stringify(events)) return reject('notification configuration');
      // In-memory configuration receipt only, never OS authorization or scheduling.
      // The five other notification capabilities still fail closed below.
      notificationLease ??= 'goal-tasks-memory-notification-lease';
      return { lease: notificationLease };
    }
    if (name !== 'runtime.request') return reject(`native ${name}`);
    const { path, method = 'GET', body } = input;
    if (method === 'POST' && path === rpc) {
      if (JSON.stringify(body) !== JSON.stringify({ input: { sessionID: 'ses_1' } })) return reject('RPC input');
      return ok({ output: goal ? { ...goal, reason: receipt() } : null });
    }
    if (method === 'POST' && path === `${session}/command?${scope}`) {
      if (!body || body.name !== 'goal' || 'id' in body) return reject('non-native Goal command');
      const keys = Object.keys(body).sort().join(',');
      if (['pause', 'resume', 'clear'].includes(body.text)) {
        if (keys !== 'name,text') return reject('panel command carries delivery/resources');
        if (body.text === 'pause' && goal?.status === 'active') { pauses++; goal = { ...goal, status: 'paused' }; }
        else if (body.text === 'resume' && goal?.status === 'paused') { resumes++; goal = { ...goal, status: 'active' }; }
        else if (body.text === 'clear' && goal) { clears++; goal = null; }
        else return reject('invalid Goal transition');
      } else {
        if (body.text !== objective || body.delivery !== 'queue' || keys !== 'delivery,name,text') return reject('busy Goal objective wire');
        objectives++; goal = { ...initialGoal, objective, rounds: 0 };
      }
      revision++;
      if (goal) goal = { ...goal, updatedAt: 1000 + revision };
      return { status: 204, body: null };
    }
    if (method === 'POST' && path === `${session}/prompt?${scope}`) {
      prompts++;
      if (body?.text !== queuedText || body.delivery !== 'queue' || typeof body.id !== 'string' ||
        ['model', 'agent', 'variant', 'command'].some(key => key in body)) return reject('ordinary queue wire/selection');
      const item = { id: body.id, sessionID: 'ses_1', type: 'user', delivery: 'queue', payload: { text: queuedText } };
      inbox.push(item); return ok(item);
    }
    if (method !== 'GET') {
      if (path === `${session}/model?${scope}` || path === `${session}/agent?${scope}`) selection++;
      return reject(`write ${method} ${path}`);
    }
    if (path === '/api/config/settings') {
      settingsReads++;
      return ok({ projects: [{ id: 'p1', name: 'Native workspace', path: directory }], usageDropdownProviders: [], magpieHiddenProviders: [] });
    }
    if (path === '/api/config/themes') return ok({ themes: [] });
    if (path === '/api/debug/location') return ok([{ directory }]);
    if (path === '/api/form?location%5Bdirectory%5D=%2Fworkspace%2Fproject' || path === '/api/permission/request?location%5Bdirectory%5D=%2Fworkspace%2Fproject') return ok({ data: [] });
    if (path === '/api/yuri/session-index') return ok({ available: true, directories: [{ directory, sessions: [{ id: 'ses_1', title: 'Native conversation', time: { updated: 2 } }] }] });
    if (path === '/api/yuri/assistants/snapshot') return ok({ assistants: [] });
    if (path === '/api/yuri/scheduled-tasks') return ok({ tasks: [], failedProjectIds: [] });
    if (path === '/api/session-folders/order') return ok({ revision: 0, sessionOrderByScope: {}, sessionOrderActivityByScope: {} });
    if (path === `/api/yuri/message-queue/worktrees/order?projectDirectory=%2Fworkspace%2Fproject`) return ok({ projectDirectory: directory, revision: 0, orderedPaths: [] });
    if (path === `/api/session?${scope}&parentID=null&limit=20&order=desc` || path === '/api/session?parentID=null&limit=30&order=desc') return ok({ data: [authority()], cursor: { next: null } });
    if (path === `/api/git/worktrees?${scope}`) return ok([]);
    if (path === '/api/session/active') return ok({ data: { ses_1: { type: 'running' } } });
    if (path === `${session}?${scope}`) return ok({ data: authority() });
    if (path === `${session}/message?${scope}&limit=20&order=desc`) return ok({ data: history, cursor: { next: null }, complete: true });
    if (path === `${session}/inbox?${scope}`) return ok({ data: [...inbox] });
    if (path === `${session}/form?${scope}` || path === `/api/permission/request?${scope}` || path === '/api/command?location%5Bdirectory%5D=%2Fworkspace%2Fproject') return ok({ data: [] });
    if (path === `/api/git/status?${scope}` || path === `/api/git/status?${scope}&mode=light`) return ok(gitStatus());
    if (path === `/api/config/catalog/providers?${scope}`) return ok({ schemaVersion: 1, providers: [{ id: 'fixture', name: 'Fixture provider', models: {
      [modelID]: { id: modelID, name: modelName, variants: { low: {}, high: {}, [variant]: {} }, limit: { context: 200000 } },
    } }] });
    if (path === '/api/agent?location%5Bdirectory%5D=%2Fworkspace%2Fproject') return ok({ data: [{ id: 'build', name: 'build', mode: 'primary' }, { id: 'plan', name: 'plan', mode: 'primary' }] });
    if (path === '/api/quota/providers') return ok({ providers: [] });
    if (path === `/api/quota/magpie?${scope}`) return ok({ sources: [], incomplete: false });
    return reject(`read ${path}`);
  } };
}
