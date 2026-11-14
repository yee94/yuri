// The page's host for the web build and for `nsh test`: an in-memory Yuri server
// with two projects (one linked worktree), pinned and in-progress sessions, and
// a streaming transcript for the running session.
// Everything is built here: the module is loaded on its own, with no imports.

const NOW = Date.now();
const MINUTE = 60_000;

const studio = '/Users/studio/Code/yuri';
const studioWorktree = '/Users/studio/Code/yuri/.worktrees/fix-auth';
const site = '/Users/studio/Code/site';
const labHost = 'host-lab';
const labProject = '/Users/lab/Code/remote-app';
const labWorktree = '/Users/lab/Code/remote-app/.worktrees/api';

const projects = [
  { id: 'p-yuri', path: studio, label: 'yuri', addedAt: NOW - 40 * MINUTE, lastOpenedAt: NOW },
  { id: 'p-site', path: site, label: 'site', addedAt: NOW - 20 * MINUTE, lastOpenedAt: NOW },
];

const settings = {
  projects,
  activeProjectId: projects[0].id,
  recentModels: [{ providerID: 'anthropic', modelID: 'claude-sonnet-4-5', variant: 'high' }],
  favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }],
  hiddenModels: [],
  providerOrder: ['anthropic', 'openai'],
  usageDropdownProviders: ['claude'],
  usageDisplayMode: 'usage',
  usageSelectedModels: {},
};

let behaviorContent = '# Global rules\n\nPrefer small, reversible changes and run focused tests.\n';

const providers = [  {
    id: 'anthropic',
    name: 'Anthropic',
    models: {
      'claude-sonnet-4-5': {
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5',
        limit: { context: 200000, output: 64000 },
        variants: { high: {}, low: {} },
      },
      'claude-haiku-4-5': {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        limit: { context: 200000, output: 32000 },
        variants: {},
      },
    },
  },
  {
    id: 'openai',
    name: 'OpenAI',
    models: {
      'gpt-5-codex': {
        id: 'gpt-5-codex',
        name: 'GPT-5 Codex',
        limit: { context: 400000, output: 128000 },
        variants: { minimal: {}, medium: {} },
      },
    },
  },
];

const agents = [
  { name: 'build', mode: 'primary', description: 'Implement the change' },
  { name: 'plan', mode: 'primary', description: 'Read and plan without writing' },
];

const commands = [
  { name: 'compact', description: 'Compact the conversation' },
  { name: 'review', description: 'Review the working tree' },
];

let assistants = [
  {
    id: 'a-ops',
    name: 'Ops Bot',
    avatarSeed: 'ops',
    pinnedAt: null,
    revision: 1,
    enabled: true,
    defaultPrompt: 'You are the operations assistant.',
    workspacePath: null,
    effectiveWorkspacePath: studio,
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4-5',
    agent: 'build',
    variant: null,
    mode: 'continuous',
    sessionID: 's-assistant',
    sessionGeneration: 1,
    unreadCount: 2,
    readTip: { generation: 1, ordinal: 0, messageID: 'm-assistant-1' },
    working: false,
    latestMessagePreview: {
      createdAt: NOW - 3 * MINUTE,
      messageID: 'm-assistant-2',
      ordinal: 1,
      role: 'assistant',
      text: 'Deploy finished on the staging host.',
      fallbackKind: null,
    },
  },
  {
    id: 'a-docs',
    name: 'Docs Bot',
    avatarSeed: 'docs',
    pinnedAt: null,
    revision: 1,
    enabled: true,
    defaultPrompt: 'Answer documentation questions.',
    workspacePath: null,
    effectiveWorkspacePath: site,
    providerID: 'openai',
    modelID: 'gpt-5-codex',
    agent: null,
    variant: null,
    mode: 'continuous',
    sessionID: null,
    sessionGeneration: 0,
    unreadCount: 0,
    readTip: null,
    working: false,
    latestMessagePreview: null,
  },
  {
    id: 'a-pinned',
    name: 'Pinned Bot',
    avatarSeed: 'pinned',
    pinnedAt: NOW - 60 * MINUTE,
    revision: 1,
    enabled: true,
    defaultPrompt: 'Keep the pinned workspace tidy.',
    workspacePath: null,
    effectiveWorkspacePath: studio,
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4-5',
    agent: null,
    variant: null,
    mode: 'continuous',
    sessionID: null,
    sessionGeneration: 0,
    unreadCount: 1,
    readTip: { generation: 1, ordinal: 0, messageID: 'm-pinned-1' },
    working: false,
    latestMessagePreview: {
      createdAt: NOW - 5 * MINUTE,
      messageID: 'm-pinned-1',
      ordinal: 0,
      role: 'assistant',
      text: 'Pinned note for the release train.',
      fallbackKind: null,
    },
  },
];

const channelSettings = {
  wecom: { status: 'disconnected', error: null, configured: false, clientID: '', ownerID: '', hasSecret: false },
  feishu: { status: 'disconnected', error: null, configured: false, clientID: '', ownerID: '', hasSecret: false },
  dingtalk: { status: 'disconnected', error: null, configured: false, clientID: '', ownerID: '', hasSecret: false },
};
const weixin = { status: 'disconnected', error: null, qrCode: '' };

const scheduledTasks = [
  {
    projectId: 'p-yuri',
    task: {
      id: 'task-audit',
      name: 'Nightly dependency audit',
      enabled: true,
      schedule: { kind: 'daily', times: ['02:30'], time: '02:30', date: '', weekdays: [], cron: '', timezone: 'UTC' },
      execution: {
        prompt: 'Audit dependencies and open a task for breaking updates.',
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-5',
        agent: 'build',
      },
      state: {
        lastStatus: 'success',
        lastError: '',
        lastDurationMs: 84_000,
        nextRunAt: NOW + 6 * 60 * MINUTE,
        updatedAt: NOW - 30 * MINUTE,
      },
    },
  },
  {
    projectId: 'p-site',
    task: {
      id: 'task-changelog',
      name: 'Weekly changelog',
      enabled: false,
      schedule: { kind: 'weekly', times: ['09:00'], time: '09:00', date: '', weekdays: [1, 3], cron: '', timezone: 'UTC' },
      execution: {
        prompt: 'Write the weekly changelog from merged pull requests.',
        providerID: 'openai',
        modelID: 'gpt-5-codex',
        agent: '',
      },
      state: {
        lastStatus: 'error',
        lastError: 'Model quota exhausted',
        lastDurationMs: 12_000,
        nextRunAt: 0,
        updatedAt: NOW - 2 * 60 * MINUTE,
      },
    },
  },
];

const scheduledRuns = [
  {
    id: 'run-audit-2',
    projectId: 'p-yuri',
    taskId: 'task-audit',
    taskName: 'Nightly dependency audit',
    trigger: 'scheduled',
    status: 'success',
    sessionId: 's-running',
    directory: studio,
    error: null,
    startedAt: NOW - 30 * MINUTE,
    finishedAt: NOW - 30 * MINUTE + 84_000,
    durationMs: 84_000,
  },
  {
    id: 'run-audit-1',
    projectId: 'p-yuri',
    taskId: 'task-audit',
    taskName: 'Nightly dependency audit',
    trigger: 'manual',
    status: 'error',
    sessionId: null,
    directory: studio,
    error: 'Workspace lock timed out',
    startedAt: NOW - 26 * 60 * MINUTE,
    finishedAt: NOW - 26 * 60 * MINUTE + 12_000,
    durationMs: 12_000,
  },
  {
    id: 'run-changelog-1',
    projectId: 'p-site',
    taskId: 'task-changelog',
    taskName: 'Weekly changelog',
    trigger: 'scheduled',
    status: 'success',
    sessionId: null,
    directory: site,
    error: null,
    startedAt: NOW - 3 * 24 * 60 * MINUTE,
    finishedAt: NOW - 3 * 24 * 60 * MINUTE + 46_000,
    durationMs: 46_000,
  },
];

const session = (id, title, directory, ageMinutes, extra) => ({
  id,
  title,
  directory,
  time: { created: NOW - ageMinutes * MINUTE, updated: NOW - ageMinutes * MINUTE },
  metadata: { yuri: { titleRefresh: { activityUpdatedAt: NOW - ageMinutes * MINUTE } } },
  ...extra,
});

const sessions = [
  session('s-pinned', 'Ship the pairing sheet', studio, 4, {
    summary: { additions: 12, deletions: 3 },
    time: { created: NOW - 90 * MINUTE, updated: NOW - 4 * MINUTE, pinned: NOW - 4 * MINUTE },
  }),
  session('s-running', 'Debug relay reconnect', studio, 2, { summary: { additions: 4, deletions: 0 } }),
  session('s-old', 'Tidy the settings panel', studio, 320, {}),
  session('s-index', 'Audit the session index', studio, 400, {}),
  session('s-index-child', 'Child of the index audit', studio, 410, { parentID: 's-index' }),
  session('s-shell', 'Polish the mobile shell', studio, 520, {}),
  session('s-worktree', 'Fix auth redirect', studioWorktree, 12, {
    summary: { additions: 7, deletions: 5 },
  }),
  session('s-unread', 'Publish the changelog', site, 8, {}),
  session('s-clock', 'Compare cache clocks', site, 150, {
    metadata: { yuri: { titleRefresh: { activityUpdatedAt: NOW - MINUTE } } },
  }),
];

const cacheWorktree = '/Users/studio/Code/yuri/.worktrees/cache-lab';
const worktrees = {
  [studio]: [
    { path: studioWorktree, name: 'fix-auth', branch: 'fix/auth' },
    { path: cacheWorktree, name: 'cache-lab', branch: 'cache/lab' },
  ],
};
const branches = { [studio]: ['main', 'fix/auth', 'feature/pairing'], [site]: ['main'] };

const gitStatus = {
  [studioWorktree]: {
    current: 'fix/auth',
    files: [{ path: 'packages/ui/src/auth/redirect.ts', index: '', working_dir: 'M' }],
    diffStats: { 'packages/ui/src/auth/redirect.ts': { insertions: 7, deletions: 5 } },
  },
  [studio]: {
    current: 'main',
    files: [
      { path: 'packages/ui/src/sync/relay-client.ts', index: 'M', working_dir: '' },
      { path: 'packages/ui/src/sync/transport.ts', index: '', working_dir: 'M' },
      { path: 'packages/ui/src/sync/relay-client.test.ts', index: '', working_dir: '?' },
    ],
    diffStats: {
      'packages/ui/src/sync/relay-client.ts': { insertions: 4, deletions: 2 },
      'packages/ui/src/sync/transport.ts': { insertions: 2, deletions: 2 },
      'packages/ui/src/sync/relay-client.test.ts': { insertions: 18, deletions: 0 },
    },
  },
};

const gitDiff = {
  'packages/ui/src/sync/relay-client.ts': {
    original: ['export function connect(socket) {', '  socket.onopen = () => {', '    resume(socket);', '  };', '}'].join('\n'),
    modified: ['export function connect(socket) {', '  socket.onopen = () => {', '    flushPending(socket);', '    resume(socket);', '  };', '}'].join('\n'),
  },
  'packages/ui/src/sync/transport.ts': {
    original: ['const retryDelay = 250;', 'export const maxAttempts = 3;'].join('\n'),
    modified: ['const retryDelay = 500;', 'export const maxAttempts = 5;'].join('\n'),
  },
};

const mcpStatus = {
  filesystem: { status: 'connected' },
  github: { status: 'failed', error: 'Authentication required' },
};

const quotaResults = {
  claude: {
    providerId: 'claude',
    providerName: 'Claude',
    ok: true,
    configured: true,
    usage: {
      windows: {
        '5h': { label: '5h', usedPercent: 42, remainingPercent: 58, resetAtFormatted: 'in 2h' },
        '7d': { label: '7d', usedPercent: 71, remainingPercent: 29, resetAtFormatted: 'Mon 09:00' },
      },
    },
    fetchedAt: NOW,
  },
};

const remoteProjects = [
  {
    id: 'p-remote',
    hostId: labHost,
    remoteProjectId: 'rp-lab',
    remoteState: 'ok',
    path: labProject,
    label: 'remote-app',
    icon: 'rocket',
    color: 'string',
    addedAt: NOW - 30 * MINUTE,
    lastOpenedAt: NOW,
  },
];
let remoteMeta = { label: 'remote-app', icon: 'rocket', color: 'string' };
const remoteSessions = [
  session('r-pinned', 'Review the API contract', labProject, 6, {
    time: { created: NOW - 120 * MINUTE, updated: NOW - 6 * MINUTE, pinned: NOW - 6 * MINUTE },
    metadata: { yuri: { sessionStatus: { type: 'idle' } } },
  }),
  session('r-worktree', 'Ship the API endpoint', labWorktree, 14, {
    metadata: { yuri: { sessionStatus: { type: 'idle' } } },
  }),
  session('r-worktree-2', 'Ship the API migration', labWorktree, 20, {
    metadata: { yuri: { sessionStatus: { type: 'idle' } } },
  }),
  session('r-worktree-3', 'Ship the API docs', labWorktree, 26, {
    metadata: { yuri: { sessionStatus: { type: 'idle' } } },
  }),
  session('r-worktree-4', 'Ship the API client', labWorktree, 32, {
    metadata: { yuri: { sessionStatus: { type: 'idle' } } },
  }),
  session('r-main', 'Draft the release notes', labProject, 40, {
    metadata: { yuri: { sessionStatus: { type: 'idle' } } },
  }),
];
let remotePinned = ['r-pinned'];
const remoteUnread = {};
const remoteWorktrees = { [labProject]: [labProject, labWorktree] };
const remoteBranches = { [labProject]: ['main', 'api/work'] };

/* One remote session's transcript, permission and content lease: the Hub proxies
   these exactly like a local session, so the phone renders the same chat. */
const remoteTranscripts = {};
function remoteTranscript(id) {
  if (remoteTranscripts[id]) return remoteTranscripts[id];
  remoteTranscripts[id] = id === 'r-worktree' ? [
    {
      info: {
        id: 'rm-user-1',
        role: 'user',
        sessionID: 'r-worktree',
        time: { created: NOW - 18 * MINUTE },
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
        metadata: { agent: 'build' },
      },
      parts: [text('The endpoint still returns 500 after the deploy. Can you trace it?')],
    },
    {
      info: {
        id: 'rm-assistant-1',
        role: 'assistant',
        sessionID: 'r-worktree',
        time: { created: NOW - 17 * MINUTE, completed: NOW - 15 * MINUTE },
        tokens: { input: 9210, output: 420, reasoning: 90 },
        modelID: 'claude-sonnet-4-5',
        providerID: 'anthropic',
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5', variant: 'high' },
      },
      parts: [
        reasoning('The handler resolves the project after the auth middleware, so a missing header throws.'),
        tool('rm-tool-1', 'read', { filePath: 'apps/api/src/routes/session.ts' }, 'export function session() { /* … */ }'),
        text(
          [
            'Found it: the route reads `request.project` before the auth hook runs.',
            '',
            'I moved the guard ahead of the handler and the endpoint returns 200 again.',
          ].join('\n'),
        ),
      ],
    },
  ] : [];
  return remoteTranscripts[id];
}
const remotePermissions = [
  {
    id: 'perm-remote',
    sessionID: 'r-worktree',
    permission: 'bash',
    patterns: ['npm test --workspace apps/api'],
    metadata: { command: 'npm test --workspace apps/api', description: 'Run the API tests' },
  },
];
let remoteLeases = [];
/** Every proxied call the Hub saw, with the machine it was routed to. */
const remoteCalls = [];

/** The Hub forwards one upstream event frame to every connected Hub client. */
function emitHost(type, properties, directory) {
  send({
    key: 'global',
    data: JSON.stringify({
      type: 'yuri:host-event',
      properties: {
        hubId: 'hub-mock',
        hostId: labHost,
        ...(directory ? { directory } : {}),
        payload: { type, properties },
      },
    }),
  });
}

/** The remote assistant streams through the same event frames as a local one. */
function scheduleRemoteReply(sessionID, directory, prompt) {
  const transcript = remoteTranscript(sessionID);
  const assistantID = `rm-reply-${Date.now().toString(36)}`;
  const message = {
    info: {
      id: assistantID,
      role: 'assistant',
      sessionID,
      time: { created: Date.now() },
      tokens: { input: 1400, output: 40 },
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
    },
    parts: [{ type: 'text', text: '' }],
  };
  transcript.push(message);
  emitHost('session.execution.started', { sessionID, directory }, directory);
  const reply = `Lab Mac answered on ${labHost} at /api/session/${sessionID}/prompt: ${prompt}`;
  const chunks = reply.match(/.{1,6}/g) || [];
  let index = 0;
  const step = () => {
    if (index < chunks.length) {
      const delta = chunks[index++];
      message.parts[0].text += delta;
      emitHost('session.text.delta', { sessionID, directory, assistantMessageID: assistantID, ordinal: 0, delta }, directory);
      setTimeout(step, 16);
      return;
    }
    message.info.time.completed = Date.now();
    emitHost(
      'session.text.ended',
      { sessionID, directory, assistantMessageID: assistantID, ordinal: 0, text: message.parts[0].text },
      directory,
    );
    emitHost('session.execution.succeeded', { sessionID, directory }, directory);
    emitHost('session.idle', { sessionID, directory }, directory);
  };
  setTimeout(step, 40);
}

const remoteSummary = () => ({
  hubId: 'hub-mock',
  hostId: labHost,
  stale: false,
  revision: 2,
  lastSyncedAt: NOW,
  pinnedSessionIds: remotePinned,
  directories: [labProject, labWorktree].map((directory) => ({
    directory,
    hasMore: directory === labWorktree,
    cursor: directory === labWorktree ? 'api-page-2' : null,
    lastSyncedAt: NOW,
    sessions: directory === labWorktree
      ? remoteSessions.filter((entry) => entry.directory === directory).slice(0, 2)
      : remoteSessions.filter((entry) => entry.directory === directory),
  })),
  unread: { revision: 1, sessions: remoteUnread },
  order: { revision: 1, sessionOrderByScope: {}, sessionOrderActivityByScope: {} },
  worktrees: { projectDirectories: remoteWorktrees, staleProjectDirectories: [] },
});
const hostCatalog = () => ({
  supported: true,
  hubId: 'hub-mock',
  hosts: [
    {
      id: labHost,
      name: 'Lab Mac',
      source: 'relay',
      state: 'connected',
      available: true,
      instanceId: 'instance-lab',
      lastSyncedAt: NOW,
    },
  ],
  projects: remoteProjects.map((project) => ({ ...project, ...remoteMeta })),
});

const unread = { 's-unread': { unreadCount: 2 } };
const pinned = ['s-pinned'];
const active = { 's-running': { type: 'busy' } };
let order = { revision: 1, sessionOrderByScope: {}, sessionOrderActivityByScope: {} };
const connections = [
  { id: 'mock', label: 'Studio', url: 'http://127.0.0.1:4096', transport: 'direct', lastUsedAt: NOW },
];
let selected = 'mock';
const scope = { hostID: 'mock', lease: 'mock-lease' };
const snapshot = () => ({ connections, selected, runtimeScope: scope });

const index = () => ({
  available: true,
  partial: true,
  pinnedSessionIds: pinned,
  directories: [studio, studioWorktree, site].map((directory) => ({
    directory,
    hasMore: false,
    sessions: sessions.filter((entry) => entry.directory === directory),
  })),
  sync: { completed: 3, total: 3, failedDirectories: [], pendingDirectories: [] },
});

/* Transcript samples: the running session carries a full turn (reasoning, tools,
   markdown) and older pages for the list's load-more. */

const text = (value) => ({ type: 'text', text: value });
const reasoning = (value) => ({ type: 'reasoning', text: value });
const tool = (id, name, input, output, status, metadata) => ({
  type: 'tool',
  id,
  name,
  state: {
    status: status || 'completed',
    input,
    ...(output === undefined ? {} : { output }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(status === 'running' ? {} : { time: { start: NOW - 40_000, end: NOW - 30_000 } }),
  },
});

const assistant = (id, parts, extra) => ({
  info: {
    id,
    role: 'assistant',
    sessionID: extra && extra.sessionID,
    time: { created: NOW - 60_000, completed: NOW - 20_000 },
    tokens: { input: 18420, output: 860, reasoning: 240 },
    modelID: 'claude-sonnet-4-5',
    providerID: 'anthropic',
    model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5', variant: 'high' },
    ...(extra || {}),
  },
  parts,
});

const user = (id, value, sessionID, ageMinutes) => ({
  info: {
    id,
    role: 'user',
    sessionID,
    time: { created: NOW - (ageMinutes ?? 90) * MINUTE },
    model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
    metadata: { agent: 'build' },
  },
  parts: [text(value)],
});

const runningTurn = [
  user('m-run-1', 'The relay keeps dropping after a reconnect. Can you find why and fix it?', 's-running', 30),
  assistant(
    'm-run-2',
    [
      reasoning('The socket reconnects, but the pending request queue is never flushed. Let me read the relay client first.'),
      tool('t-1', 'read', { filePath: 'packages/ui/src/sync/relay-client.ts' }, 'export function connect() { /* … */ }'),
      tool('t-2', 'bash', { command: 'rg -n "reconnect" packages/ui/src/sync' }, 'relay-client.ts:41\ntransport.ts:88'),
      tool(
        't-3',
        'edit',
        { filePath: 'packages/ui/src/sync/transport.ts' },
        'Updated the retry delay.',
        'completed',
        {
          patch: [
            '--- a/packages/ui/src/sync/transport.ts',
            '+++ b/packages/ui/src/sync/transport.ts',
            '@@ -1,2 +1,2 @@',
            '-const retryDelay = 250;',
            '+const retryDelay = 500;',
            ' export const maxAttempts = 3;',
          ].join('\n'),
        },
      ),
      text(
        [
          'Found it: **relay-client.ts** recreates the socket without draining the queued frames.',
          '',
          '```ts',
          'socket.onopen = () => {',
          '  flushPending(socket);',
          '};',
          '```',
          '',
          '| Before | After |',
          '| --- | --- |',
          '| frames lost | frames replayed |',
          '',
          'See the [relay guide](https://example.com/relay) for the retry contract.',
        ].join('\n'),
      ),
    ],
    { sessionID: 's-running' },
  ),
];

const olderMessages = [];
for (let i = 0; i < 11; i++) {
  olderMessages.push(
    user(`m-old-${i * 2}`, `Background question ${i + 1}: summarize what this module does.`, 's-running', 400 - i),
    assistant(`m-old-${i * 2 + 1}`, [text(`Summary ${i + 1}: the module owns one focused concern and stays small.`)], {
      sessionID: 's-running',
      id: `m-old-${i * 2 + 1}`,
    }),
  );
}

const transcripts = {
  's-assistant': [
    user('m-assistant-1', 'Did the staging deploy finish?', 's-assistant', 6),
    assistant('m-assistant-2', [text('Deploy finished on the staging host.')], {
      sessionID: 's-assistant',
      id: 'm-assistant-2',
    }),
  ],
  's-running': [...olderMessages, ...runningTurn],
  's-old': [
    user('m-old-panel-1', 'Tidy the settings panel spacing.', 's-old'),
    assistant('m-old-panel-2', [text('Aligned the rows to the shared control radius.')], { sessionID: 's-old', id: 'm-old-panel-2' }),
  ],
};

const inboxes = {};
const revertSnapshots = {};

const forms = [
  {
    id: 'frm-demo',
    sessionID: 's-old',
    title: 'Pick a reconnect strategy',
    fields: [
      {
        key: 'strategy',
        type: 'select',
        title: 'Strategy',
        description: 'Where should the relay reconnect land?',
        options: [
          { label: 'Retry in place', value: 'retry' },
          { label: 'Drain then retry', value: 'drain' },
        ],
      },
    ],
  },
];

const permissions = [
  {
    id: 'perm-demo',
    sessionID: 's-running',
    permission: 'bash',
    patterns: ['git status --short'],
    metadata: { command: 'git status --short', description: 'Inspect the working tree' },
  },
];

const directoryOf = (path) => {
  const at = path.indexOf('directory=');
  return at < 0 ? '' : decodeURIComponent(path.slice(at + 'directory='.length).split('&')[0]);
};
const locationOf = (path) => {
  const at = path.indexOf('location%5Bdirectory%5D=');
  return at < 0 ? '' : decodeURIComponent(path.slice(at + 'location%5Bdirectory%5D='.length).split('&')[0]);
};
const paramOf = (path, name) => {
  const at = path.indexOf(`${name}=`);
  return at < 0 ? '' : decodeURIComponent(path.slice(at + name.length + 1).split('&')[0]);
};
const sessionOf = (path) => decodeURIComponent(path.split('/api/session/')[1].split(/[/?]/)[0]);

/** The Hub's route to one Remote Host: summaries and `/api/hosts/<id>/api/...` proxying. */
function remoteRoute(path, method, body) {
  const prefix = `/api/hosts/${labHost}`;
  if (!path.startsWith(prefix)) return null;
  const inner = path.slice(prefix.length);
  if (inner === '/summaries') return remoteSummary();
  if (inner === '/connect') return { host: hostCatalog().hosts[0] };
  if (inner.startsWith('/projects')) {
    if (method === 'PATCH') {
      remoteMeta = {
        label: (body && body.label) || remoteMeta.label,
        icon: body && body.icon !== undefined ? body.icon : remoteMeta.icon,
        color: body && body.color !== undefined ? body.color : remoteMeta.color,
      };
      return { project: { ...remoteProjects[0], ...remoteMeta } };
    }
    if (method === 'DELETE') {
      remoteProjects.splice(0, remoteProjects.length);
      return { removed: true };
    }
    return { project: { ...remoteProjects[0], ...remoteMeta } };
  }
  if (!inner.startsWith('/api/')) return {};
  const id = inner.includes('/session/') ? decodeURIComponent(inner.split('/session/')[1].split(/[/?]/)[0]) : '';
  if (inner.startsWith('/api/yuri/session-index/session/')) {
    const at = remotePinned.indexOf(id);
    if (method === 'POST' && at < 0) remotePinned.push(id);
    if (method === 'DELETE' && at >= 0) remotePinned.splice(at, 1);
    return { pinnedSessionIds: remotePinned };
  }
  if (inner.startsWith('/api/yuri/session-unread/')) {
    if (method === 'PUT') {
      if (body && body.unread) remoteUnread[id] = { directory: labProject, unreadCount: 1, revision: 1 };
      else delete remoteUnread[id];
    }
    return { sessions: remoteUnread };
  }
  if (inner.startsWith('/api/yuri/sessions/') && inner.endsWith('/archive')) {
    const entry = remoteSessions.find((value) => value.id === id);
    if (entry && body) {
      if (Number(body.archivedAt) > 0) entry.time = { ...entry.time, archived: Number(body.archivedAt) };
      else delete entry.time.archived;
    }
    return true;
  }
  if (inner.startsWith('/api/yuri/sessions/') && inner.endsWith('/metadata')) {
    const entry = remoteSessions.find((value) => value.id === id);
    if (entry && body && body.patch && body.patch.yuri && body.patch.yuri.titleAuthority) {
      entry.title = body.patch.yuri.titleAuthority.title;
    }
    return { metadata: entry ? entry.metadata : {} };
  }
  if (inner === '/subscriptions' && method === 'POST') {
    const lease = `sub-${remoteLeases.length + 1}`;
    remoteLeases.push(lease);
    const directory = body && typeof body.directory === 'string' ? body.directory : labWorktree;
    const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId : '';
    // Web `HostContentDemand`: the lease answers once the upstream channel is ready.
    setTimeout(() => emitHost('yuri:content-ready', { id: lease, sessionId, channelId: 'chan-remote', readyGeneration: 'gen-1' }, directory), 20);
    return { id: lease, channelId: 'chan-remote', readyGeneration: 'gen-1' };
  }
  if (inner.startsWith('/subscriptions/') && method === 'DELETE') {
    const lease = decodeURIComponent(inner.slice('/subscriptions/'.length));
    remoteLeases = remoteLeases.filter((entry) => entry !== lease);
    return true;
  }
  if (inner.startsWith('/api/session/') && inner.includes('/message')) {
    const all = remoteTranscript(id);
    const limit = Number(paramOf(inner, 'limit')) || 20;
    const cursor = paramOf(inner, 'cursor');
    const upper = cursor ? Math.max(0, Number(cursor)) : all.length;
    const lower = Math.max(0, upper - limit);
    return { data: all.slice(lower, upper).reverse(), cursor: { next: lower > 0 ? String(lower) : null } };
  }
  if (inner.startsWith('/api/session/') && inner.includes('/prompt')) {
    const directory = directoryOf(inner) || labWorktree;
    const promptText = body && typeof body.text === 'string' ? body.text : '';
    remoteCalls.push({ hostId: labHost, method, path: inner });
    if (body && typeof body.id === 'string' && promptText) {
      remoteTranscript(id).push({
        info: { id: body.id, role: 'user', sessionID: id, time: { created: Date.now() } },
        parts: [{ type: 'text', text: promptText }],
      });
    }
    scheduleRemoteReply(id, directory, promptText);
    return { id: body && body.id };
  }
  if (inner.startsWith('/api/session/') && inner.includes('/interrupt')) {
    remoteCalls.push({ hostId: labHost, method, path: inner });
    return true;
  }
  if (inner.startsWith('/api/session/') && inner.includes('/permission/')) {
    const permissionID = decodeURIComponent((inner.split('/permission/')[1] || '').split(/[/?]/)[0]);
    const at = remotePermissions.findIndex((entry) => entry.id === permissionID);
    if (at >= 0) remotePermissions.splice(at, 1);
    remoteCalls.push({ hostId: labHost, method, path: inner });
    return true;
  }
  if (inner.startsWith('/api/session/') && inner.includes('/inbox')) return [];
  if (inner.startsWith('/api/session/') && inner.includes('/compact')) {
    const directory = directoryOf(inner) || labWorktree;
    remoteCalls.push({ hostId: labHost, method, path: inner });
    remoteTranscript(id).push({
      info: { id: `rm-compact-${Date.now().toString(36)}`, role: 'assistant', clientRole: 'compaction', sessionID: id, time: { created: Date.now() } },
      parts: [{ type: 'compaction', status: 'completed' }],
    });
    emitHost('session.execution.started', { sessionID: id, directory }, directory);
    setTimeout(() => emitHost('session.idle', { sessionID: id, directory }, directory), 20);
    return true;
  }
  if (inner.startsWith('/api/session/') && inner.includes('/revert/stage')) return { messageID: body && body.messageID, files: [] };
  if (inner.startsWith('/api/session/') && inner.includes('/revert')) return true;
  if (inner.startsWith('/api/session/') && inner.includes('/fork')) {
    const directory = directoryOf(inner) || labWorktree;
    const forkedID = `r-fork-${Date.now().toString(36)}`;
    remoteSessions.unshift(session(forkedID, 'Fork of Ship the API endpoint', directory, 0, {}));
    remoteTranscript(forkedID).push(...remoteTranscript(id));
    return { id: forkedID, directory, title: 'Fork of Ship the API endpoint' };
  }
  if (inner.startsWith('/api/session/') && (inner.includes('/model') || inner.includes('/agent')) && method === 'POST') return true;
  if (inner.startsWith('/api/permission/request')) return remotePermissions;
  if (inner.startsWith('/api/form')) return [];
  if (inner.startsWith('/api/session/') && method === 'GET' && !inner.includes('/message')) {
    const entry = remoteSessions.find((value) => value.id === id) || {};
    return {
      ...entry,
      title: entry.title || '',
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5', variant: 'high' },
      agent: 'build',
    };
  }
  if (inner.startsWith('/api/session/') && method === 'PATCH') {
    const entry = remoteSessions.find((value) => value.id === id);
    if (entry && body && typeof body.title === 'string') entry.title = body.title;
    return entry || {};
  }
  if (inner.startsWith('/api/session/') && method === 'DELETE') {
    const at = remoteSessions.findIndex((value) => value.id === id);
    if (at >= 0) remoteSessions.splice(at, 1);
    return true;
  }
  if (inner === '/api/session' || inner.startsWith('/api/session?')) {
    const directory = directoryOf(inner);
    const search = paramOf(inner, 'search').toLowerCase();
    if (inner.includes('parentID=') && !inner.includes('parentID=null')) return { data: [], cursor: null };
    if (method === 'POST') {
      const created = session(`r-new-${Date.now().toString(36)}`, 'New session', directory || labWorktree, 0, {});
      remoteSessions.unshift(created);
      remoteTranscript(created.id);
      return created;
    }
    if (inner.includes('cursor=api-page-2')) {
      const rows = remoteSessions.filter((entry) => entry.directory === labWorktree).slice(2);
      return { data: rows, cursor: null };
    }
    if (method === 'GET') {
      const rows = remoteSessions.filter(
        (entry) =>
          (!directory || entry.directory === directory) &&
          (!search || entry.title.toLowerCase().includes(search)),
      );
      return { data: rows, cursor: null };
    }
    return {};
  }
  if (inner.startsWith('/api/session-folders/order')) {
    return { revision: 1, sessionOrderByScope: {}, sessionOrderActivityByScope: {} };
  }
  if (inner.startsWith('/api/git/branches')) return { all: remoteBranches[directoryOf(inner)] || ['main'] };
  if (inner.startsWith('/api/git/worktrees/validate')) return { ok: true, errors: [] };
  if (inner.startsWith('/api/git/worktrees')) {
    if (method === 'POST') {
      const name = body && body.worktreeName ? body.worktreeName : 'worktree';
      const target = `${labProject}/.worktrees/${name}`;
      const rows = remoteWorktrees[labProject] || (remoteWorktrees[labProject] = [labProject]);
      if (!rows.includes(target)) rows.push(target);
      return { path: target };
    }
    if (method === 'DELETE') {
      const rows = remoteWorktrees[labProject] || [];
      const at = rows.indexOf(body && body.directory);
      if (at >= 0) rows.splice(at, 1);
      return { success: true };
    }
    return remoteWorktrees[labProject] || [];
  }
  if (inner.startsWith('/api/git/status')) return { isClean: true, current: 'main', isGitRepository: true, files: [] };
  if (inner.startsWith('/api/git/remote-branches')) return { success: true };
  // Catalog and workspace reads resolve on the Host, exactly where the session runs.
  if (
    [
      '/api/config/',
      '/api/agent',
      '/api/command',
      '/api/fs/',
      '/api/quota/',
      '/api/mcp',
      '/api/experimental/mcp/',
      '/api/git/file-diff',
    ].some((prefix) => inner.startsWith(prefix))
  )
    return route(inner, method, body);
  return {};
}

const route = (path, method, body) => {
  const verb = method || 'GET';
  if (path === '/api/hosts') return hostCatalog();
  const remote = remoteRoute(path, verb, body);
  if (remote !== null) return remote;
  if (path.startsWith('/api/yuri/content-search')) {
    const query = paramOf(path, 'q').toLowerCase();
    const hits = query
      ? sessions
          .filter((entry) => entry.title.toLowerCase().includes(query))
          .map((entry) => ({
            sessionID: entry.id,
            messageID: 'm-' + entry.id,
            role: 'assistant',
            createdAt: NOW - MINUTE,
            snippet: 'Message about ' + query + '.',
            directory: entry.directory,
            title: entry.title,
          }))
      : [];
    return { hits };
  }
  if (path.startsWith('/api/config/settings')) {
    if (verb === 'PUT') {
      if (body && Array.isArray(body.projects)) {
        projects.length = 0;
        for (const project of body.projects) projects.push(project);
        settings.projects = projects;
      }
      if (body) Object.assign(settings, body);
      return settings;
    }
    return settings;
  }
  if (path.startsWith('/api/config/catalog/providers')) {
    return {
      schemaVersion: 1,
      ok: true,
      providers,
      default: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
      partial: false,
      complete: true,
    };
  }
  if (path.startsWith('/api/config/mcp')) return [{ name: 'filesystem' }, { name: 'github' }];
  if (path.startsWith('/api/mcp')) {
    return { data: Object.entries(mcpStatus).map(([name, status]) => ({ name, status })) };
  }
  if (path.startsWith('/api/experimental/mcp/')) {
    const parts = path.split('/');
    const name = decodeURIComponent(parts[parts.indexOf('mcp') + 1] || '');
    const action = (parts[parts.indexOf('mcp') + 2] || '').split('?')[0];
    if (mcpStatus[name]) mcpStatus[name] = action === 'connect' ? { status: 'connected' } : { status: 'disabled' };
    return true;
  }
  if (path.startsWith('/api/quota/') && !path.startsWith('/api/quota/magpie')) {
    const providerId = decodeURIComponent(path.split('/api/quota/')[1].split(/[/?]/)[0]);
    return quotaResults[providerId] || { providerId, providerName: providerId, ok: true, configured: false, usage: null, fetchedAt: NOW };
  }
  if (path.startsWith('/api/config/plugins')) return { entries: [] };
  if (path.startsWith('/api/config/skills')) {
    return {
      skills: [
        { name: 'commit', description: 'Write a commit message', scope: 'global' },
        { name: 'review', description: 'Review the working tree', scope: 'project' },
      ],
    };
  }
  if (path.startsWith('/api/config/reload')) return true;
  if (path.startsWith('/api/behavior/agents-md')) {
    if (verb === 'PUT' && body && typeof body.content === 'string') behaviorContent = body.content;
    return { content: behaviorContent };
  }
  if (path.startsWith('/api/quota/magpie')) return { sources: [] };
  if (path.startsWith('/api/system/info')) return { serveVersion: '1.2.3', yuriVersion: '1.2.3', opencodeVersion: '0.9.0' };
  if (path.startsWith('/api/opencode/upgrade-status')) return { version: '0.9.0', serveVersion: '0.9.0', currentVersion: '0.9.0', management: 'manual-global', canManage: false };

  if (path.startsWith('/api/yuri/assistants/capability')) {
    return { supported: true, enabled: true, revision: 1, serverInstanceID: 'mock', sharingAvailable: false };
  }
  if (path.startsWith('/api/yuri/assistants/snapshot')) return { revision: 1, enabled: true, assistants };

  const assistantMatch = /^\/api\/yuri\/assistants\/([^/?]+)(?:\/([^/?]+))?(?:\/([^/?]+))?/.exec(path);
  if (assistantMatch) {
    const id = decodeURIComponent(assistantMatch[1]);
    const area = assistantMatch[2] || '';
    const leaf = assistantMatch[3] || '';
    const entry = assistants.find((value) => value.id === id);
    if (verb === 'POST' && area === 'session') {
      if (entry) {
        entry.sessionID = entry.sessionID || 's-assistant';
        entry.sessionGeneration = entry.sessionGeneration || 1;
        entry.unreadCount = 0;
        return {
          sessionID: entry.sessionID,
          directory: entry.effectiveWorkspacePath,
          sessionGeneration: entry.sessionGeneration,
        };
      }
      return { sessionID: 's-assistant', directory: studio, sessionGeneration: 1 };
    }
    if (area === 'contact') {
      if (entry) entry.unreadCount = 0;
      return { assistantID: id, unreadCount: 0 };
    }
    if (area === 'channels') {
      const provider = leaf;
      const state = channelSettings[provider] || { status: 'unsupported', error: null };
      if (verb === 'POST' && path.endsWith('/retry')) {
        channelSettings[provider] = { ...state, status: 'connected', error: null };
        return channelSettings[provider];
      }
      if (verb === 'PUT') {
        channelSettings[provider] = {
          ...state,
          status: 'disconnected',
          configured: true,
          clientID: (body && body.clientID) || '',
          ownerID: (body && body.ownerID) || '',
          hasSecret: !!(body && body.clientSecret) || !!state.hasSecret,
        };
        return channelSettings[provider];
      }
      if (verb === 'DELETE') {
        channelSettings[provider] = {
          ...state,
          status: 'disconnected',
          configured: false,
          clientID: '',
          ownerID: '',
          hasSecret: false,
        };
        return channelSettings[provider];
      }
      return state;
    }
    if (area === 'weixin') {
      if (verb === 'POST' && leaf === 'verify') {
        weixin.status = 'connected';
        weixin.qrCode = '';
        return { ...weixin };
      }
      if (verb === 'POST' && leaf === 'retry') {
        weixin.status = 'connected';
        weixin.error = null;
        return { ...weixin };
      }
      if (verb === 'POST') {
        weixin.status = 'waiting';
        weixin.qrCode = 'https://example.com/weixin-qr.svg';
        return { ...weixin };
      }
      if (verb === 'DELETE') {
        weixin.status = 'disconnected';
        weixin.qrCode = '';
        return { ...weixin };
      }
      return { ...weixin };
    }
    if (area === 'scheduled-tasks') {
      return scheduledTasks.map((row) => ({ projectID: row.projectId, task: row.task }));
    }
    if (verb === 'PATCH' && entry) {
      const patch = { ...(body || {}) };
      if (typeof patch.pinned === 'boolean') {
        entry.pinnedAt = patch.pinned ? Date.now() : null;
        delete patch.pinned;
      }
      delete patch.expectedRevision;
      Object.assign(entry, patch);
      entry.revision += 1;
      return entry;
    }
    if (verb === 'DELETE') {
      assistants = assistants.filter((value) => value.id !== id);
      return true;
    }
    if (verb === 'GET') return entry || {};
    return entry || {};
  }
  if (path.startsWith('/api/yuri/assistants')) {
    if (verb === 'POST') {
      const created = {
        id: `a-${Date.now().toString(36)}`,
        name: (body && body.name) || 'New bot',
        avatarSeed: (body && body.avatarSeed) || undefined,
        pinnedAt: null,
        revision: 1,
        enabled: true,
        defaultPrompt: (body && body.defaultPrompt) || '',
        workspacePath: (body && body.workspacePath) || null,
        effectiveWorkspacePath: studio,
        providerID: (body && body.providerID) || 'anthropic',
        modelID: (body && body.modelID) || 'claude-sonnet-4-5',
        agent: (body && body.agent) || null,
        variant: null,
        mode: (body && body.mode) || 'continuous',
        sessionID: null,
        sessionGeneration: 0,
        unreadCount: 0,
        readTip: null,
        working: false,
        latestMessagePreview: null,
      };
      assistants.push(created);
      return created;
    }
    return assistants;
  }

  if (path === '/api/yuri/scheduled-tasks') return { tasks: scheduledTasks, failedProjectIds: [] };
  if (path.startsWith('/api/yuri/scheduled-task-runs')) {
    const projectId = paramOf(path, 'projectId');
    const taskId = paramOf(path, 'taskId');
    const scoped = scheduledRuns
      .filter((run) => (!projectId || run.projectId === projectId) && (!taskId || run.taskId === taskId))
      .sort((left, right) => right.startedAt - left.startedAt);
    const limit = Number(paramOf(path, 'limit')) || 20;
    const before = Number(paramOf(path, 'before'));
    const remaining = before ? scoped.filter((run) => run.startedAt < before) : scoped;
    const page = remaining.slice(0, limit);
    const complete = remaining.length <= limit;
    return {
      runs: page,
      nextCursor: complete ? null : String(page[page.length - 1].startedAt),
      complete,
    };
  }

  const projectTaskMatch = /^\/api\/projects\/([^/?]+)\/scheduled-tasks(?:\/([^/?]+))?(?:\/run)?/.exec(path);
  if (projectTaskMatch) {
    const projectId = decodeURIComponent(projectTaskMatch[1]);
    const taskId = projectTaskMatch[2] ? decodeURIComponent(projectTaskMatch[2]) : '';
    if (verb === 'PUT' && body && body.task) {
      const draft = body.task;
      const at = scheduledTasks.findIndex((row) => row.projectId === projectId && row.task.id === draft.id);
      const next = {
        id: draft.id || `task-${Date.now().toString(36)}`,
        name: draft.name,
        enabled: draft.enabled !== false,
        schedule: draft.schedule,
        execution: {
          prompt: draft.prompt,
          providerID: draft.providerID,
          modelID: draft.modelID,
          agent: draft.agent,
        },
        state: { lastStatus: 'idle', lastError: '', lastDurationMs: 0, nextRunAt: 0, updatedAt: Date.now() },
      };
      if (at >= 0) scheduledTasks[at] = { projectId, task: next };
      else scheduledTasks.push({ projectId, task: next });
      return { tasks: scheduledTasks.filter((row) => row.projectId === projectId).map((row) => row.task) };
    }
    if (verb === 'DELETE') {
      const at = scheduledTasks.findIndex((row) => row.projectId === projectId && row.task.id === taskId);
      if (at >= 0) scheduledTasks.splice(at, 1);
      return { tasks: scheduledTasks.filter((row) => row.projectId === projectId).map((row) => row.task) };
    }
    if (path.endsWith('/run')) return true;
    return { tasks: scheduledTasks.filter((row) => row.projectId === projectId).map((row) => row.task) };
  }
  if (path.startsWith('/api/agent')) return agents;
  if (path.startsWith('/api/command')) return commands;
  if (path.startsWith('/api/fs/find')) {
    const query = paramOf(path, 'query').toLowerCase();
    const files = [
      { path: 'packages/ui/src/sync/relay-client.ts', type: 'file' },
      { path: 'packages/ui/src/sync/transport.ts', type: 'file' },
      { path: 'packages/ui/src/sync/DOCUMENTATION.md', type: 'file' },
      { path: 'packages/nsh/app/chat/ChatPage.tsx', type: 'file' },
    ];
    return { data: files.filter((file) => !query || file.path.toLowerCase().includes(query)) };
  }
  if (path.startsWith('/api/git/status')) {
    const directory = directoryOf(path);
    const status = gitStatus[directory];
    return status
      ? { isClean: false, isGitRepository: true, current: status.current, files: status.files, diffStats: status.diffStats }
      : { isClean: true, isGitRepository: true, current: 'main', files: [] };
  }
  if (path.startsWith('/api/git/file-diff')) {
    const file = paramOf(path, 'path');
    const diff = gitDiff[file];
    return diff ? { ...diff, isBinary: false } : { original: '', modified: '', isBinary: false };
  }
  if (path.startsWith('/api/git/branches')) return { all: branches[directoryOf(path)] || ['main'] };
  if (path.startsWith('/api/git/primary-root')) return { root: directoryOf(path) };
  if (path.startsWith('/api/git/check')) return { isGitRepository: directoryOf(path) !== site };
  if (path.startsWith('/api/git/remote-branches')) return { success: true };
  if (path.startsWith('/api/git/worktrees/validate')) return { ok: true, errors: [] };
  if (path.startsWith('/api/git/worktrees')) {
    const directory = directoryOf(path);
    if (verb === 'POST') {
      const name = body && body.worktreeName ? body.worktreeName : 'worktree';
      const target = `${directory}/.worktrees/${name}`;
      const rows = worktrees[directory] || (worktrees[directory] = []);
      if (!rows.some((row) => row.path === target)) {
        rows.push({ path: target, name, branch: (body && (body.branchName || body.existingBranch)) || name });
      }
      return { path: target };
    }
    if (verb === 'DELETE') {
      const rows = worktrees[directory] || [];
      const at = rows.findIndex((row) => row.path === (body && body.directory));
      if (at >= 0) rows.splice(at, 1);
      return { success: true };
    }
    return worktrees[directory] || [];
  }
  if (path === '/api/yuri/session-index') return index();
  if (path.startsWith('/api/yuri/session-index/sync')) return { synced: true };
  if (path.startsWith('/api/yuri/session-index/session/')) {
    const id = decodeURIComponent(path.split('/session/')[1].split('/')[0]);
    const at = pinned.indexOf(id);
    if (verb === 'POST' && at < 0) pinned.push(id);
    if (verb === 'DELETE' && at >= 0) pinned.splice(at, 1);
    return { pinnedSessionIds: pinned };
  }
  if (path.startsWith('/api/yuri/session-unread/')) {
    const id = decodeURIComponent(path.split('/session-unread/')[1]);
    if (verb === 'PUT') {
      if (body && body.unread) unread[id] = { unreadCount: 1 };
      else delete unread[id];
    }
    return { sessions: unread };
  }
  if (path.startsWith('/api/yuri/session-unread')) return { sessions: unread };
  if (path.startsWith('/api/session-folders/order')) {
    if (verb === 'POST' && body && typeof body.scopeKey === 'string') {
      order = {
        revision: order.revision + 1,
        sessionOrderByScope: { ...order.sessionOrderByScope, [body.scopeKey]: body.order || [] },
        sessionOrderActivityByScope: {
          ...order.sessionOrderActivityByScope,
          [body.scopeKey]: body.activity || {},
        },
      };
    }
    return order;
  }
  if (path === '/api/session/active') return active;

  if (path.startsWith('/api/permission/request')) return permissions;
  if (path.startsWith('/api/permission/')) {
    const parts = path.split('/');
    const id = decodeURIComponent(parts[parts.indexOf('permission') + 1] || '');
    const at = permissions.findIndex((entry) => entry.id === id);
    if (at >= 0) permissions.splice(at, 1);
    return true;
  }
  if (path.startsWith('/api/form')) return forms;

  if (path.startsWith('/api/session/') && path.includes('/permission/')) {
    const id = decodeURIComponent(path.split('/permission/')[1].split(/[/?]/)[0]);
    const at = permissions.findIndex((entry) => entry.id === id);
    if (at >= 0) permissions.splice(at, 1);
    return true;
  }
  if (path.startsWith('/api/session/') && path.includes('/form/')) {
    const formID = decodeURIComponent(path.split('/form/')[1].split(/[/?]/)[0]);
    const at = forms.findIndex((entry) => entry.id === formID);
    if (at >= 0) forms.splice(at, 1);
    return true;
  }
  if (path.startsWith('/api/session/') && path.includes('/message')) {
    const id = sessionOf(path);
    const all = transcripts[id] || [];
    const limit = Number(paramOf(path, 'limit')) || 20;
    const cursor = paramOf(path, 'cursor');
    const upper = cursor ? Math.max(0, Number(cursor)) : all.length;
    const lower = Math.max(0, upper - limit);
    const page = all.slice(lower, upper).reverse();
    return { data: page, cursor: { next: lower > 0 ? String(lower) : null } };
  }
  if (path.startsWith('/api/session/') && path.includes('/revert/stage')) {
    const id = sessionOf(path);
    const messageID = body && typeof body.messageID === 'string' ? body.messageID : '';
    const all = transcripts[id] || [];
    revertSnapshots[id] = [...all];
    const at = all.findIndex((message) => message.info && message.info.id === messageID);
    if (at >= 0) transcripts[id] = all.slice(0, at + 1);
    return {
      messageID,
      files: [{ file: 'packages/ui/src/sync/relay-client.ts', status: 'modified', additions: 4, deletions: 2, patch: '' }],
    };
  }
  if (path.startsWith('/api/session/') && path.includes('/revert')) {
    const id = sessionOf(path);
    if (verb === 'DELETE') {
      if (revertSnapshots[id]) transcripts[id] = revertSnapshots[id];
      delete revertSnapshots[id];
    }
    return true;
  }
  if (path.startsWith('/api/session/') && path.includes('/fork')) {
    const id = sessionOf(path);
    const directory = (sessions.find((entry) => entry.id === id) || {}).directory || studio;
    const title = (sessions.find((entry) => entry.id === id) || {}).title || 'Forked session';
    const before = body && typeof body.before === 'string' ? body.before : '';
    const source = transcripts[id] || [];
    const at = before ? source.findIndex((message) => message.info && message.info.id === before) : -1;
    const forkedID = `s-fork-${Date.now().toString(36)}`;
    transcripts[forkedID] = at >= 0 ? source.slice(0, at) : source.map((message) => ({ ...message }));
    sessions.unshift(session(forkedID, `Fork of ${title}`, directory, 0, {}));
    return { id: forkedID, directory, title: `Fork of ${title}` };
  }
  if (path.startsWith('/api/session/') && path.includes('/compact')) {
    const id = sessionOf(path);
    const compactionID = `m-compact-${Date.now().toString(36)}`;
    transcripts[id] = transcripts[id] || [];
    transcripts[id].push({
      info: { id: compactionID, role: 'assistant', clientRole: 'compaction', sessionID: id, time: { created: Date.now() } },
      parts: [{ type: 'compaction', status: 'completed' }],
    });
    send({
      key: 'chat',
      data: JSON.stringify({ directory: (sessions.find((entry) => entry.id === id) || {}).directory || studio, type: 'session.compaction.completed', data: { sessionID: id } }),
    });
    send({
      key: 'chat',
      data: JSON.stringify({ directory: (sessions.find((entry) => entry.id === id) || {}).directory || studio, type: 'session.idle', data: { sessionID: id } }),
    });
    return true;
  }
  if (path.startsWith('/api/session/') && path.includes('/inbox')) {
    const id = sessionOf(path);
    const queue = inboxes[id] || [];
    if (verb === 'DELETE') {
      const inboxID = decodeURIComponent(path.split('/inbox/')[1].split(/[/?]/)[0] || '');
      inboxes[id] = queue.filter((row) => row.id !== inboxID);
      return true;
    }
    if (verb === 'PATCH') {
      const inboxID = decodeURIComponent(path.split('/inbox/')[1].split(/[/?]/)[0] || '');
      const row = queue.find((entry) => entry.id === inboxID);
      inboxes[id] = queue.filter((entry) => entry.id !== inboxID);
      if (row && body?.delivery === 'steer') {
        transcripts[id] = transcripts[id] || [];
        transcripts[id].push({
          info: { id: row.id, role: 'user', sessionID: id, time: { created: Date.now() } },
          parts: [row.text],
        });
        scheduleReply(id, row.id);
      }
      return inboxes[id];
    }
    return queue;
  }
  if (path.startsWith('/api/session/') && path.includes('/prompt')) {
    const id = sessionOf(path);
    const text = body && typeof body.text === 'string' ? body.text : '';
    const messageID = body && typeof body.id === 'string' ? body.id : `m-${Date.now()}`;
    if (body && body.delivery === 'queue') {
      inboxes[id] = [...(inboxes[id] || []), { id: messageID, type: 'user', text, payload: { text }, delivery: 'queue' }];
      return { id: messageID, sessionID: id };
    }
    transcripts[id] = transcripts[id] || [];
    transcripts[id].push({
      info: { id: messageID, role: 'user', sessionID: id, time: { created: Date.now() } },
      parts: [
        { type: 'text', text },
        ...(Array.isArray(body && body.files)
          ? body.files.map((file) => ({ type: 'file', url: file.uri, filename: file.name, mime: 'image/png' }))
          : []),
      ],
    });
    scheduleReply(id, messageID);
    return { id: messageID, sessionID: id };
  }
  if (path.startsWith('/api/session/') && path.includes('/interrupt')) {
    const id = sessionOf(path);
    stopReply(id);
    return true;
  }
  if (path.startsWith('/api/session/') && path.includes('/model')) return true;
  if (path.startsWith('/api/session/') && path.includes('/agent')) return true;
  if (path.startsWith('/api/session/') && path.includes('/message/')) return {};
  if (path.startsWith('/api/yuri/sessions/') && path.endsWith('/archive')) {
    const id = decodeURIComponent(path.split('/sessions/')[1].split('/')[0]);
    const entry = sessions.find((value) => value.id === id);
    if (entry && body) {
      if (Number(body.archivedAt) > 0) entry.time = { ...entry.time, archived: Number(body.archivedAt) };
      else delete entry.time.archived;
    }
    return true;
  }
  if (path.startsWith('/api/yuri/sessions/') && path.endsWith('/metadata')) {
    const id = decodeURIComponent(path.split('/sessions/')[1].split('/')[0]);
    const entry = sessions.find((value) => value.id === id);
    if (entry && body && body.patch && body.patch.yuri && body.patch.yuri.titleAuthority) {
      entry.title = body.patch.yuri.titleAuthority.title;
    }
    return true;
  }
  if (path.startsWith('/api/session/') && verb === 'PATCH') {
    const id = decodeURIComponent(path.split('/api/session/')[1].split('?')[0]);
    const entry = sessions.find((value) => value.id === id);
    if (entry && body && typeof body.title === 'string') entry.title = body.title;
    return entry || {};
  }
  if (path.startsWith('/api/session/') && verb === 'DELETE') {
    const id = decodeURIComponent(path.split('/api/session/')[1].split('?')[0]);
    const at = sessions.findIndex((value) => value.id === id);
    if (at >= 0) sessions.splice(at, 1);
    return true;
  }
  if (path.startsWith('/api/session/') && verb === 'GET') {
    const id = sessionOf(path);
    const entry = sessions.find((value) => value.id === id);
    return {
      ...(entry || { id, title: 'New session', directory: studio }),
      model: { providerID: 'anthropic', id: 'claude-sonnet-4-5', variant: 'high' },
      agent: 'build',
    };
  }
  if (path === '/api/session' || path.startsWith('/api/session?')) {
    const directory = directoryOf(path);
    const parentID = paramOf(path, 'parentID');
    if (verb === 'GET') {
      if (parentID && parentID !== 'null') {
        return {
          data: [
            session('s-child-1', 'Explore the relay queue', directory || studio, 3, {}),
            session('s-child-2', 'Write the regression test', directory || studio, 5, {}),
          ],
          cursor: null,
        };
      }
      const search = paramOf(path, 'search').toLowerCase();
      const rows = sessions.filter(
        (entry) =>
          (!directory || entry.directory === directory) &&
          (!search || entry.title.toLowerCase().includes(search)),
      );
      return { data: rows, cursor: null };
    }
    const created = session('s-new', 'New session', directory || studio, 0, {});
    sessions.unshift(created);
    return created;
  }
  if (path.startsWith('/api/fs/home')) return { home: '/Users/studio' };
  return {};
};

/* The mock stream: prompt replies arrive as chat events, token by token. */

let streaming = null;
let players = [];
const send = (payload) => {
  for (const player of players) {
    const owner = payload.key === 'chat' && player.chatOwner ? player.chatOwner : payload.ownerID;
    player.hostEvent('runtime.event', { ...payload, ...(owner ? { ownerID: owner } : {}) });
  }
};

const stopReply = (sessionID) => {
  if (!streaming || streaming.sessionID !== sessionID) return;
  if (streaming.step) clearTimeout(streaming.step);
  streaming = null;
};

function emitDelta(state, delta) {
  send({
    key: 'chat',
    ownerID: state.owner,
    data: JSON.stringify({
      directory: state.directory,
      type: 'session.text.delta',
      data: {
        sessionID: state.sessionID,
        assistantMessageID: state.assistantID,
        ordinal: 0,
        delta,
        directory: state.directory,
      },
    }),
  });
}

function scheduleReply(sessionID, userMessageID) {
  const directory = (sessions.find((entry) => entry.id === sessionID) || {}).directory || studio;
  stopReply(sessionID);
  const assistantID = `m-reply-${Date.now().toString(36)}`;
  const state = { sessionID, directory, assistantID, owner: 'mock-chat', step: undefined, index: 0 };
  streaming = state;
  const reply = [
    'Sure — the queue drains now after a reconnect. I updated the relay client and added a regression test.',
    'The pending frames replay before the socket resumes, and the retry delay stays bounded.',
    'I also checked the transport counters and the reconnect path against the contract.',
  ].join(' ').repeat(6);
  const chunks = reply.match(/.{1,7}/g) || [];
  transcripts[sessionID] = transcripts[sessionID] || [];
  transcripts[sessionID].push({
    info: {
      id: assistantID,
      role: 'assistant',
      sessionID,
      time: { created: Date.now() },
      tokens: { input: 1200, output: 32 },
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
    },
    parts: [{ type: 'text', text: '' }],
  });
  const assistantMessage = transcripts[sessionID][transcripts[sessionID].length - 1];
  const emit = (type, data) =>
    send({
      key: 'chat',
      ownerID: state.owner,
      data: JSON.stringify({ directory, type, data: { sessionID, directory, ...data } }),
    });
  emit('session.execution.started', {});
  const step = () => {
    if (streaming !== state) return;
    if (state.index < chunks.length) {
      const delta = chunks[state.index];
      state.index += 1;
      assistantMessage.parts[0].text += delta;
      emitDelta(state, delta);
      state.step = setTimeout(step, 24);
      return;
    }
    assistantMessage.info.time.completed = Date.now();
    emit('session.text.ended', { assistantMessageID: assistantID, ordinal: 0, text: assistantMessage.parts[0].text });
    emit('session.execution.succeeded', {});
    emit('session.idle', {});
    streaming = null;
  };
  state.step = setTimeout(step, 60);
  void userMessageID;
}

export function createHost(player) {
  players.push(player);
  player.hostEvent('runtime.event', { key: 'global', type: 'reconnected' });
  return {
    async call(name, args) {
      const input = args || {};
      if (name === 'connection.list') return snapshot();
      if (name === 'connection.select') {
        if (connections.some((entry) => entry.id === input.id)) selected = input.id;
        return snapshot();
      }
      if (name === 'connection.remove') {
        const at = connections.findIndex((entry) => entry.id === input.id);
        if (at >= 0) connections.splice(at, 1);
        if (selected === input.id) selected = connections[0] ? connections[0].id : null;
        return snapshot();
      }
      if (name === 'connection.connect') {
        const url = typeof input.url === 'string' && input.url ? input.url : 'http://127.0.0.1:4096';
        const label = typeof input.label === 'string' && input.label ? input.label : 'Yuri';
        const id = 'mock-' + (connections.length + 1);
        connections.push({ id, label, url, transport: 'direct', lastUsedAt: Date.now() });
        selected = id;
        return snapshot();
      }
      if (name === 'native.clientMetadata') return { schemaVersion: 1, version: '1.18.2', build: '370', updates: { status: 'unsupported' } };
      if (name === 'camera.scan') return 'yuri://connect?url=http%3A%2F%2F127.0.0.1%3A4096';
      if (name === 'runtime.pickAttachment') {
        return {
          uri: 'file:///Users/studio/Code/yuri/screenshot.png',
          name: 'screenshot.png',
          mime: 'image/png',
          size: 184320,
        };
      }
      if (name === 'runtime.pendingAttachments') return [];
      if (name === 'runtime.reconcileAttachment') return null;
      if (name === 'runtime.cancelAttachment') return null;
      if (name === 'runtime.acknowledgeAttachment') return null;
      if (name === 'runtime.request') {
        const body = route(String(input.path || ''), String(input.method || 'GET'), input.body);
        return { status: 200, body };
      }
      if (name === 'runtime.stream') {
        if (input.key === 'chat' && typeof input.ownerID === 'string') player.chatOwner = input.ownerID;
        return { ok: true };
      }
      if (name === 'runtime.stop') {
        if (input.key === 'chat' && player.chatOwner === input.ownerID) player.chatOwner = null;
        return { ok: true };
      }
      throw new Error('no host function ' + name);
    },
  };
}
