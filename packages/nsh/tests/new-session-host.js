import { assertNewSessionFixtureScope, fixtureRequest } from './new-session-request.js';

/** Isolated fake native bridge for new-session-fixture.tsx. Never production. */
export function createHost({ hostID = 'new-session-fixture', lease = 'new-session-fixture-lease' } = {}) {
  let loseCreate = false, failPrompt = false, creates = 0;
  const runtimeScope = { hostID, lease };
  let appearanceRevision = 0;
  const attachmentPicks = new Map();
  const sessions = new Map(), inbox = new Map(), prompts = [];
  let settings = { favoriteModels: [{ providerID: 'fixture', modelID: 'gpt-model', variant: 'high' }], recentModels: [{ providerID: 'fixture', modelID: 'claude-model' }] };
  const settingsWrites = [], projectWrites = [], files = new Map();
  const home = '/fixture/home', configDirectory = home + '/.config/yuri/projects';
  // Explicit paths for the two fixture projects, including projectId's no-btoa
  // fallback on QuickJS. Unknown files must still fail, not look absent.
  const configRoots = new Map([
    [configDirectory + '/path_L2ZpeHR1cmUvcHJvamVjdA.json', '/fixture/project'],
    [configDirectory + '/path__fixture_project.json', '/fixture/project'],
    [configDirectory + '/path_L2ZpeHR1cmUvb3RoZXI.json', '/fixture/other'],
    [configDirectory + '/path__fixture_other.json', '/fixture/other'],
    ['/fixture/project/.yuri/yuri.json', '/fixture/project'], ['/fixture/other/.yuri/yuri.json', '/fixture/other'],
  ]);
  let configDirectoryMade = false;
  const clone = value => JSON.parse(JSON.stringify(value));
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const nonempty = value => typeof value === 'string' && value.trim().length > 0;
  function bodyKeys(body, allowed, required = allowed) {
    if (!object(body) || Object.keys(body).some(key => !allowed.includes(key)) || required.some(key => !(key in body))) throw new Error('Invalid new-session fixture body');
  }
  function starterRefs(value) {
    return Array.isArray(value) && value.every(ref => object(ref) && Object.keys(ref).every(key => ['type', 'name'].includes(key)) && ['command', 'skill'].includes(ref.type) && nonempty(ref.name));
  }
  function modelRefs(value) {
    return Array.isArray(value) && value.every(ref => object(ref) && Object.keys(ref).every(key => ['providerID', 'modelID', 'variant'].includes(key)) && nonempty(ref.providerID) && nonempty(ref.modelID) && (ref.variant === undefined || typeof ref.variant === 'string'));
  }
  function catalogScope(params) {
    if (!['/fixture/project', '/fixture/other'].includes(params.get('directory'))) throw new Error('Unexpected new-session fixture catalog scope');
  }
  // These engine scenarios finish through the real handoff/prompt path. An
  // "admitted" result is impossible if the captured session selection is wrong.
  function assertSubmission(session, body) {
    const expected = {
      'Send captured configuration': { agent: 'plan', model: { providerID: 'fixture', id: 'gpt-model', variant: 'high' } },
      'Cycle primary catalog': { agent: 'plan' },
      'Long press preserves Build': { agent: 'build' },
      'Favorites preserve captured selection': { model: { providerID: 'fixture', id: 'gpt-model', variant: 'low' } },
    }[body.text];
    if (!expected) return;
    const actual = { ...(session.agent ? { agent: session.agent } : {}), ...(session.model ? { model: session.model } : {}) };
    if (actual.agent !== expected.agent || !!actual.model !== !!expected.model || ['providerID', 'id', 'variant'].some(key => actual.model?.[key] !== expected.model?.[key])) throw new Error('New-session fixture captured selection mismatch: ' + JSON.stringify(actual));
    if (body.text === 'Favorites preserve captured selection') {
      const favorites = settings.favoriteModels;
      if (settingsWrites.filter(patch => !patch.recentModels).length !== 3 || settingsWrites.filter(patch => patch.recentModels).length !== 1 || favorites.length !== 2 || !favorites.some(ref => ref.providerID === 'fixture' && ref.modelID === 'gpt-model' && ref.variant === 'low') || !favorites.some(ref => ref.providerID === 'fixture' && ref.modelID === 'claude-model')) throw new Error('New-session fixture favorite persistence mismatch');
    }
  }
  return {
    call(name, input) {
      if (name === 'connection.list') return { selected: hostID, connections: [{ id: hostID, label: 'Fixture', url: 'https://host.example', lastUsedAt: 0 }], runtimeScope: { ...runtimeScope } };
      if (name === 'appearance.reset') {
        if (Object.keys(input).join(',') !== 'hostID' || input.hostID !== null && input.hostID !== hostID) throw new Error('Invalid new-session appearance reset');
        return { revision: ++appearanceRevision };
      }
      if (name === 'appearance.apply') {
        if (Object.keys(input).sort().join(',') !== 'cssVars,fonts,hostID,mode,revision' || input.hostID !== hostID || input.revision !== appearanceRevision
          || !['light', 'dark', 'system'].includes(input.mode) || Object.keys(input.cssVars ?? {}).sort().join(',') !== 'dark,light'
          || Object.keys(input.fonts ?? {}).sort().join(',') !== 'assistantDark,assistantLight,mono,ui'
          || Object.values(input.fonts).some(font => !['system-ui', 'monospace', 'JetBrains Mono'].includes(font))) throw new Error('Invalid new-session appearance apply');
        return { uiFontFamily: input.fonts.ui, monoFontFamily: input.fonts.mono,
          assistantFontFamilies: { light: input.fonts.assistantLight, dark: input.fonts.assistantDark }, unsupportedFonts: [], systemColorScheme: 'light' };
      }
      if (name === 'runtime.stream' || name === 'runtime.stop') return true;
      if (name === 'runtime.pickAttachment') {
        if (!input || Object.keys(input).sort().join(',') !== 'expectedHost,kind,requestId' || !['files', 'images'].includes(input.kind)
          || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId) || attachmentPicks.has(input.requestId)
          || !input.expectedHost || Object.keys(input.expectedHost).sort().join(',') !== 'hostID,lease'
          || input.expectedHost.hostID !== hostID || input.expectedHost.lease !== lease) throw new Error('Invalid new-session fixture attachment pick');
        attachmentPicks.set(input.requestId, { ...input.expectedHost });
        return { uri: 'attachment://fixture/note', name: 'fixture-note.txt', mime: 'text/plain' };
      }
      if (name === 'runtime.cancelAttachment') {
        const captured = attachmentPicks.get(input?.requestId);
        if (!input || Object.keys(input).sort().join(',') !== 'expectedHost,requestId' || !captured || !input.expectedHost
          || Object.keys(input.expectedHost).sort().join(',') !== 'hostID,lease' || input.expectedHost.hostID !== captured.hostID || input.expectedHost.lease !== captured.lease) throw new Error('Invalid new-session fixture attachment cancellation');
        return true;
      }
      if (name !== 'runtime.request') throw new Error('Unexpected new-session fixture native call: ' + name);
      assertNewSessionFixtureScope(input, runtimeScope);
      const route = fixtureRequest(input), { path, method, params } = route;
      const ok = body => ({ status: 200, body });
      if (path === '/__fixture/new-session/lose-create') { route.expect('GET'); loseCreate = true; return ok({}); }
      if (path === '/__fixture/new-session/fail-prompt') { route.expect('GET'); failPrompt = true; return ok({}); }
      if (path === '/__fixture/new-session/stats') { route.expect('GET'); return ok(clone({ creates, prompts, settings, settingsWrites, projectWrites })); }
      if (path === '/api/config/settings') {
        route.expect(method === 'PUT' ? 'PUT' : 'GET');
        if (method === 'PUT') {
          bodyKeys(input.body, ['draftStarters', 'favoriteModels', 'recentModels'], []);
          const keys = Object.keys(input.body);
          const valid = keys.length > 0 && (keys.includes('draftStarters') ? keys.length === 1 && starterRefs(input.body.draftStarters) : keys.every(key => modelRefs(input.body[key])));
          if (!valid) throw new Error('Invalid new-session fixture settings patch');
          settingsWrites.push(clone(input.body)); settings = { ...settings, ...clone(input.body) };
        }
        return ok(clone(settings));
      }
      if (path === '/api/config/themes') { route.expect('GET'); return ok({ themes: [] }); }
      if (path === '/api/fs/home') { route.expect('GET'); return ok({ home }); }
      if (path === '/api/fs/read') {
        route.expect('GET', ['path', 'optional'], ['path']);
        const file = params.get('path');
        if (!configRoots.has(file) || params.has('optional') && params.get('optional') !== 'true') throw new Error('Unexpected new-session fixture file read');
        if (files.has(file)) return ok(files.get(file));
        return params.get('optional') === 'true' ? ok('') : { status: 404, body: { error: 'Fixture config not found' } };
      }
      if (path === '/api/fs/mkdir') {
        route.expect('POST'); bodyKeys(input.body, ['path']);
        if (input.body.path !== configDirectory) throw new Error('Unexpected new-session fixture mkdir');
        configDirectoryMade = true; return ok({ success: true, path: configDirectory });
      }
      if (path === '/api/fs/write') {
        route.expect('POST'); bodyKeys(input.body, ['path', 'content']);
        const { path: file, content } = input.body;
        if (!configDirectoryMade || !configRoots.has(file) || !file.startsWith(configDirectory + '/') || typeof content !== 'string') throw new Error('Unexpected new-session fixture file write');
        const config = JSON.parse(content);
        if (!object(config) || config.projectPath !== configRoots.get(file) || !starterRefs(config.draftStarters)) throw new Error('Invalid new-session fixture project config');
        files.set(file, content); projectWrites.push({ path: file, content }); return ok({ success: true, path: file });
      }
      if (path === '/api/config/commands/metadata') {
        route.expect('POST', ['directory'], ['directory']); catalogScope(params); bodyKeys(input.body, ['catalog']);
        if (input.body.catalog !== true) throw new Error('Invalid new-session fixture command catalog');
        return ok({ commands: [{ name: 'fixture-command', description: 'Registered native command', scope: 'user' }, { name: 'fixture-project-command', scope: 'project' }] });
      }
      if (path === '/api/config/skills') {
        route.expect('GET', ['directory', 'summary'], ['directory', 'summary']); catalogScope(params);
        if (params.get('summary') !== 'true') throw new Error('Invalid new-session fixture skill summary');
        return ok({ skills: [{ name: 'fixture-review', path: params.get('directory') + '/.agents/skills/fixture-review/SKILL.md', scope: 'project', source: 'agents', description: 'Fixture skill' }] });
      }
      if (path === '/api/config/catalog/providers') { route.expect('GET', ['directory'], ['directory']); return ok({ schemaVersion: 1, providers: [{ id: 'fixture', name: 'Fixture provider', models: { 'gpt-model': { id: 'gpt-model', name: 'GPT fixture', variants: { low: {}, high: {} }, limit: { context: 128000 }, capabilities: { toolcall: true, reasoning: true } }, 'claude-model': { id: 'claude-model', name: 'Claude fixture', variants: { high: {} } } } }] }); }
      if (path === '/api/agent') { route.expect('GET', ['location[directory]'], ['location[directory]']); return ok({ data: [{ name: 'build', mode: 'primary', description: 'Build fixture' }, { name: 'plan', mode: 'primary' }, { name: 'explore', mode: 'subagent' }] }); }
      if (path === '/api/skill') { route.expect('GET', ['location[directory]'], ['location[directory]']); return ok({ data: [{ id: 'fixture-review', name: 'Review', description: 'Fixture skill' }] }); }
      if (path === '/api/fs/find') { route.expect('GET', ['location[directory]', 'query', 'type', 'limit'], ['location[directory]', 'type', 'limit']); if (!params.has('query')) throw new Error('Missing new-session fixture search query'); return ok({ data: [{ type: params.get('type'), path: 'src/a.ts' }] }); }
      if (path === '/api/command') { route.expect('GET', ['location[directory]'], ['location[directory]']); return ok({ data: [{ name: 'fixture-command', description: 'Registered native command' }] }); }
      if (path === '/api/magic-prompts') { route.expect('GET'); return ok({ version: 1, overrides: {} }); }
      if (path === '/api/session/active') { route.expect('GET'); return ok({}); }
      if (path === '/api/permission/request' || path === '/api/form') { route.expect('GET', ['directory'], ['directory']); return ok([]); }
      if (path === '/api/yuri/session-index') {
        route.expect('GET');
        const directories = [...new Set([...sessions.values()].map(session => session.location.directory))].map(directory => ({ directory, sessions: [...sessions.values()].filter(session => session.location.directory === directory) }));
        return ok({ available: true, directories });
      }
      if (path === '/api/session' && method === 'POST') {
        route.expect('POST');
        if (!input.body || !input.body.location || typeof input.body.location.directory !== 'string' || !input.body.location.directory) throw new Error('Invalid new-session fixture create directory');
        const session = { id: `ses_draft_${++creates}`, title: 'Created draft fixture', location: input.body.location, time: { updated: creates } };
        sessions.set(session.id, session); inbox.set(session.id, []);
        if (loseCreate) { loseCreate = false; throw new Error('Fixture lost session creation response'); }
        return ok({ data: session });
      }
      if (path === '/api/session') { route.expect('GET', ['directory', 'search', 'limit', 'order', 'archived', 'parentID', 'cursor']); return ok({ items: [...sessions.values()], next: null }); }
      const match = /^\/api\/session\/([^/]+)(?:\/(model|agent|message(?:\/[^/]+)?|inbox|permission\/request|form|prompt|command|shell))?$/.exec(path);
      if (!match) throw new Error('Unexpected new-session fixture route: ' + input.path);
      const suffix = match[2] || '', writing = ['model', 'agent', 'prompt', 'command', 'shell'].includes(suffix);
      route.expect(writing ? 'POST' : 'GET', suffix === 'message' ? ['directory', 'limit', 'order', 'cursor'] : ['directory'], writing ? ['directory'] : []);
      const session = sessions.get(decodeURIComponent(match[1]));
      if (!session) return { status: 404, body: { error: 'Fixture session not found' } };
      if (params.has('directory') && params.get('directory') !== session.location.directory) throw new Error('Unexpected new-session fixture session directory');
      if (!suffix) return ok({ data: session });
      if (suffix === 'model' && method === 'POST') { session.model = input.body.model; return ok({}); }
      if (suffix === 'agent' && method === 'POST') { session.agent = input.body.agent; return ok({}); }
      if (suffix === 'message') return ok({ data: [] });
      if (suffix.startsWith('message/')) return { status: 404, body: { error: 'Fixture input has not been promoted' } };
      if (suffix === 'inbox') return ok(inbox.get(session.id));
      if (suffix === 'permission/request' || suffix === 'form') return ok([]);
      if (suffix === 'prompt') {
        assertSubmission(session, input.body);
        prompts.push({ sessionID: session.id, ...input.body });
        if (failPrompt) { failPrompt = false; throw new Error('Fixture unknown prompt response'); }
        const receipt = { id: input.body.id, sessionID: session.id, type: 'user', delivery: input.body.delivery, payload: { text: input.body.text } };
        inbox.get(session.id).push(receipt); return ok(receipt);
      }
      if (suffix === 'command' || suffix === 'shell') return ok(null);
      throw new Error('Unexpected new-session fixture route: ' + input.path);
    },
  };
}
