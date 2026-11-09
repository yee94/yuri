/** Fixture-only history mutations. Never touches a real Host or user history. */
import { assertFixtureRequestScope, createHost as baseHost } from './host.js';
export function createHost(options = {}) {
  const base = baseHost();
  let revert = null;
  let appearanceRevision = 0;
  const settings = () => ({
    ...base.call('runtime.request', { path: '/api/config/settings', method: 'GET' }).body,
    useSystemTheme: true, themeVariant: 'dark', themeId: 'jetbrains-dark',
    lightThemeId: 'jetbrains-light', darkThemeId: 'jetbrains-dark',
    uiFont: 'system', monoFont: 'system-mono', fontSize: 100, timeFormatPreference: 'auto',
    chatRenderMode: 'sorted', activityRenderMode: 'collapsed', showReasoningTraces: true,
    collapsibleUserMessages: true, sessionGoalEnabled: true, showAssistantTps: true,
    collapsibleThinkingBlocks: true, followUpBehavior: 'queue',
    ...options.settings,
  });
  const user = { id: 'history-user', type: 'user', time: { created: 1000 }, content: [
    { type: 'text', text: 'Editable historical input' },
    { type: 'file', source: { type: 'uri', uri: 'file:///host/upload.txt' }, filename: 'upload.txt', mime: 'text/plain' },
  ] };
  const answer = { id: 'history-answer', type: 'assistant', model: { id: 'gpt-6.1-sol', providerID: 'fixture', variant: 'high' }, agent: 'build', finish: 'tool-calls', time: { created: 1100, streamed: 2100, completed: 3200 }, tokens: { output: 4, reasoning: 1 }, content: [
    { type: 'tool', id: 'task-fixture', tool: 'task', state: { status: 'completed', title: 'Misleading ses_title', input: { subagent_type: 'explore' }, metadata: { sessionID: 'child-session' }, output: 'Child result' } },
    { type: 'tool', id: 'shell-fixture', tool: 'bash', state: { status: 'completed', input: { command: 'pwd' }, output: 'Neutral shell result' } },
  ] };
  // Ordinary completed tools still require a model follow-up before terminal stop.
  const finalAnswer = { id: 'history-final-answer', type: 'assistant', model: answer.model, agent: answer.agent, finish: 'stop', time: { created: 3300, streamed: 4300, completed: 5300 }, tokens: { output: 6, reasoning: 4 }, content: [
    { type: 'text', text: 'Historical answer' },
  ] };
  return { call(name, input) {
    if (name === 'appearance.reset') {
      if (Object.keys(input).join(',') !== 'hostID' || input.hostID !== null && input.hostID !== 'fixture') throw new Error('Unsafe transcript appearance reset');
      return { revision: ++appearanceRevision };
    }
    if (name === 'appearance.apply') {
      if (Object.keys(input).sort().join(',') !== 'cssVars,fonts,hostID,mode,revision' || input.hostID !== 'fixture' || input.revision !== appearanceRevision ||
        !['light', 'dark', 'system'].includes(input.mode) || Object.keys(input.cssVars ?? {}).sort().join(',') !== 'dark,light' ||
        Object.keys(input.fonts ?? {}).sort().join(',') !== 'assistantDark,assistantLight,mono,ui' ||
        Object.values(input.fonts).some(font => !['system-ui', 'monospace', 'JetBrains Mono'].includes(font))) throw new Error('Unsafe transcript appearance apply');
      return { uiFontFamily: input.fonts.ui, monoFontFamily: input.fonts.mono,
        assistantFontFamilies: { light: input.fonts.assistantLight, dark: input.fonts.assistantDark }, unsupportedFonts: [], systemColorScheme: 'dark' };
    }
    if (name !== 'runtime.request') return base.call(name, input);
    assertFixtureRequestScope(input, base.call('connection.list', {}).runtimeScope);
    const { path, method, body } = input;
    if (path === '/api/config/settings' || path === '/api/config/themes') {
      if (method !== 'GET') throw new Error('Unsafe transcript appearance request');
      if (path === '/api/config/themes') return { status: 200, body: { themes: [] } };
      if (options.failSettings?.()) return { status: 503, body: { error: 'Transcript fixture settings unavailable' } };
      return { status: 200, body: settings() };
    }
    if (path.startsWith('/api/config/catalog/providers')) return { status: 200, body: { providers: [{ id: 'fixture', models: {
      'gpt-6.1-sol': { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
      'current-other': { id: 'current-other', name: 'Different current model' },
    } }] } };
    if (path.startsWith('/api/session/ses_1/revert/stage?')) {
      if (method !== 'POST' || body.messageID !== user.id || typeof body.files !== 'boolean') throw new Error('Unsafe transcript fixture stage');
      revert = { messageID: user.id, files: [] };
      return { status: 200, body: revert };
    }
    if (path.startsWith('/api/session/ses_1/revert?')) {
      if (method !== 'DELETE') throw new Error('Unsafe transcript fixture clear');
      revert = null; return { status: 204, body: null };
    }
    if (path.startsWith('/api/session/ses_1/message/history-user?')) return { status: 200, body: user };
    if (path.startsWith('/api/session/ses_1/message/history-answer?')) return { status: 200, body: answer };
    if (path.startsWith('/api/session/ses_1/message/history-final-answer?')) return { status: 200, body: finalAnswer };
    if (path.startsWith('/api/session/ses_1/message?')) return { status: 200, body: { data: revert ? [] : [finalAnswer, answer, user], cursor: { next: null } } };
    if (path.startsWith('/api/session/ses_1?')) return { status: 200, body: { id: 'ses_1', model: { id: 'current-other', providerID: 'fixture', variant: 'low' }, agent: 'plan', execution: { type: 'idle' }, revert } };
    if (path.startsWith('/api/session/child-session?')) return { status: 200, body: { id: 'child-session', directory: '/workspace/project', title: 'Authoritative child session', execution: { type: 'idle' } } };
    if (path.startsWith('/api/session/child-session/message?')) return { status: 200, body: { data: [{ id: 'child-answer', type: 'assistant', content: [{ type: 'text', text: 'Authoritative child content' }] }] } };
    if (path.startsWith('/api/session/child-session/inbox') || path.startsWith('/api/session/child-session/permission') || path.startsWith('/api/session/child-session/form')) return { status: 200, body: { data: [] } };
    return base.call(name, input);
  } };
}
