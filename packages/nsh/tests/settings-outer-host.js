/** Own-fixture only: this file never calls a real Host or a model. */
export function createHost() {
  let projectAttempts = 0, behaviorAttempts = 0, documentWrites = 0, visibilityAttempts = 0, modelAttempts = 0;
  let modelName = 'Fixture model';
  let preferenceAttempts = 0;
  let notificationWrites = 0, notificationConfigurations = 0, authorization = 'denied';
  const notificationEvents = ['completion', 'subtask', 'error', 'question', 'permission', 'schedule', 'assistant', 'goal'];
  const notificationFields = ['nativeNotificationsEnabled', 'notifyOnCompletion', 'notifyOnSubtasks', 'notifyOnError', 'notifyOnQuestion', 'notifyOnPermission', 'notifyOnScheduledTasks', 'notifyOnAssistants', 'notifyOnGoals'];
  let settings = {
    projects: [
      { id: 'project', path: '/fixture/project', label: 'Native workspace', icon: 'code', color: 'primary', defaultModel: 'fixture/model', unknown: { retained: true } },
      { id: 'other', path: '/fixture/other', label: 'Unrelated workspace', unknown: 7 },
    ],
    activeProjectId: 'other', responseStyleEnabled: false, responseStylePreset: 'concise',
    globalBehaviorPrompt: 'Original rules\n', notificationMode: 'hidden-only', nativeNotificationsEnabled: true,
    notificationTemplates: { completion: 'Preserved Web template' },
    hiddenModels: [{ providerID: 'unrelated', modelID: 'preserved' }],
    summaryModelMode: 'disabled', summaryProviderID: 'fixture', summaryModelID: 'old-model', summaryCommitPrompt: 'Preserved prompt',
    fontSize: 100, defaultModel: '', defaultVariant: 'old-variant', defaultAgent: '',
  };
  let content = 'Original rules\n';
  const scope = { hostID: 'outer-settings-fixture', lease: 'synthetic-outer-settings-lease' };
  return { call(name, input = {}) {
    if (name === 'connection.list') return { selected: scope.hostID, runtimeScope: scope, connections: [{ id: scope.hostID, label: 'Synthetic settings Host', url: 'https://settings.example.invalid', lastUsedAt: 0 }] };
    if (name === 'notification.status' || name === 'notification.openSettings') {
      if (Object.keys(input).length !== 0) throw new Error('Notification permission call carried unexpected data');
      if (name === 'notification.openSettings') { authorization = 'authorized'; return null; }
      return { authorization, alert: authorization === 'authorized' ? 'enabled' : 'disabled', sound: authorization === 'authorized' ? 'enabled' : 'disabled', badge: 'unsupported', backgroundPush: false };
    }
    if (name === 'notification.configure') {
      const expected = notificationEvents.filter((_, index) => index === 1 ? settings.notifyOnSubtasks === true : settings[notificationFields[index + 1]] !== false);
      if (Object.keys(input).sort().join(',') !== 'enabled,events,hostID,language,mode' || input.hostID !== 'outer-settings-fixture' || input.language !== 'en' || input.mode !== settings.notificationMode || input.enabled !== settings.nativeNotificationsEnabled || JSON.stringify(input.events) !== JSON.stringify(expected)) throw new Error('Invalid synthetic notification configuration');
      notificationConfigurations++;
      return { lease: 'outer-settings-memory-lease' };
    }
    if (name !== 'runtime.request') throw new Error('Unexpected outer settings native call');
    if (input.path !== '/fixture/notifications/audit' && (input.expectedHost?.hostID !== scope.hostID || input.expectedHost?.lease !== scope.lease)) throw new Error('Outer fixture request lacks admitted scope');
    const { path, method, body } = input;
    if (path === '/fixture/notifications/audit' && method === 'GET') return { status: 200, body: { enabled: settings.nativeNotificationsEnabled, notificationMode: settings.notificationMode, template: settings.notificationTemplates.completion, writes: notificationWrites, configurations: notificationConfigurations, authorization } };
    if (path === '/api/config/settings') {
      if (method === 'PUT' && body.projects) {
        projectAttempts++;
        if (body.projects[0].unknown?.retained !== true || body.projects[1].unknown !== 7 || 'activeProjectId' in body) throw new Error('Project metadata overwrote unrelated settings');
        if (projectAttempts === 1) return { status: 409, body: { error: 'Fixture project conflict' } };
        settings = { ...settings, ...body };
      } else if (method === 'PUT' && 'summaryModelID' in body) {
        if (body.summaryModelMode !== 'provider' || 'summaryCommitPrompt' in body) throw new Error('Summary model selection lost its mode or overwrote the prompt');
        settings = { ...settings, ...body };
      } else if (method === 'PUT' && 'hiddenModels' in body) {
        visibilityAttempts++;
        if (Object.keys(body).length !== 1 || !body.hiddenModels.some(item => item.providerID === 'unrelated' && item.modelID === 'preserved')) throw new Error('Provider model preference overwrote another provider');
        if (visibilityAttempts === 1) return { status: 409, body: { error: 'Fixture visibility conflict' } };
        settings = { ...settings, ...body };
      } else if (method === 'PUT' && 'notificationMode' in body) {
        if (Object.keys(body).length !== 1 || !['always', 'hidden-only'].includes(body.notificationMode)) throw new Error('Notification mode write changed unrelated settings');
        notificationWrites++; settings = { ...settings, ...body };
      } else if (method === 'PUT' && Object.keys(body).some(key => notificationFields.includes(key))) {
        if (!Object.keys(body).length || Object.keys(body).some(key => !notificationFields.includes(key) || typeof body[key] !== 'boolean')) throw new Error('Native notification write changed Web-only or unrelated settings');
        notificationWrites++;
        settings = { ...settings, ...body };
      } else if (method === 'PUT' && 'fontSize' in body) {
        if (Object.keys(body).length !== 1 || body.fontSize !== 125) throw new Error('Preference draft was not validated or isolated');
        preferenceAttempts++;
        if (preferenceAttempts === 1) return { status: 409, body: { error: 'Fixture preference conflict' } };
        settings = { ...settings, ...body };
      } else if (method === 'PUT' && 'defaultModel' in body) {
        if (body.defaultModel !== 'fixture/model' || body.defaultVariant !== '' || Object.keys(body).length !== 2) throw new Error('Default model did not atomically clear its variant');
        settings = { ...settings, ...body };
      } else if (method === 'PUT' && 'defaultVariant' in body) {
        if (body.defaultVariant !== 'high' || Object.keys(body).length !== 1) throw new Error('Variant selection was not catalog-authoritative');
        settings = { ...settings, ...body };
      } else if (method === 'PUT' && 'defaultAgent' in body) {
        if (body.defaultAgent !== 'visible-subagent' || Object.keys(body).length !== 1) throw new Error('Agent selection lost its visibility contract');
        settings = { ...settings, ...body };
      } else if (method === 'PUT') {
        behaviorAttempts++;
        if (documentWrites !== 1) throw new Error('Already committed behavior document was written twice');
        if (behaviorAttempts === 1) return { status: 409, body: { error: 'Fixture behavior conflict' } };
        if (body.globalBehaviorPrompt !== content) throw new Error('Behavior retry lost the committed document');
        settings = { ...settings, ...body };
      }
      return { status: 200, body: settings };
    }
    if (path === '/api/behavior/agents-md') {
      if (method === 'PUT') { documentWrites++; content = body.content; }
      return { status: 200, body: { content } };
    }
    if (path === '/api/config/catalog/providers?directory=%2Ffixture%2Fproject' || path === '/api/config/catalog/providers') return { status: 200, body: { schemaVersion: 1, providers: [{ id: 'fixture', name: 'Fixture provider', models: { model: { name: modelName, variants: { high: {} } } } }] } };
    if (path === '/api/config/themes') return { status: 200, body: { themes: [] } };
    if (path === '/api/agent?location%5Bdirectory%5D=%2Ffixture%2Fproject') return { status: 200, body: { data: [{ name: 'build' }, { name: 'visible-subagent', mode: 'subagent' }, { name: 'hidden-agent', options: { hidden: true } }] } };
    if (path === '/api/config/providers/model' && method === 'PUT') {
      if (body.providerId !== 'fixture' || body.modelId !== 'model' || body.directory !== '/fixture/project') throw new Error('Model editor changed its target scope');
      modelAttempts++;
      if (modelAttempts === 1) return { status: 409, body: { error: 'Fixture model conflict' } };
      modelName = body.name;
      return { status: 200, body: { ok: true } };
    }
    if (path === '/api/integration/fixture?location%5Bdirectory%5D=%2Ffixture%2Fproject') return { status: 200, body: { data: { methods: [] } } };
    if (path === '/api/config/skills?summary=true&directory=%2Ffixture%2Fproject') return { status: 200, body: { skills: [{ name: 'builtin-fixture', description: 'Built-in fixture skill', path: '<built-in>' }] } };
    if (path === '/api/config/skills/builtin-fixture?directory=%2Ffixture%2Fproject') return { status: 200, body: { name: 'builtin-fixture', path: '<built-in>', sources: { md: { path: '<built-in>', instructions: 'Read only fixture instructions', description: 'Built-in fixture skill', supportingFiles: [{ path: 'reference.md' }] } } } };
    if (path === '/api/config/skills/builtin-fixture/files/reference.md?directory=%2Ffixture%2Fproject' && method === 'GET') return { status: 200, body: { content: 'Read only supporting file' } };
    throw new Error('Unexpected outer settings request: ' + method + ' ' + path);
  } };
}
