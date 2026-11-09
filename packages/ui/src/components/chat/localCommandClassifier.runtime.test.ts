import { expect, test, vi } from 'vitest';
const runtime = vi.hoisted(() => ({ vscode: false }));
vi.mock('@/lib/desktop', () => ({ isVSCodeRuntime: () => runtime.vscode }));
import * as wrapper from './localCommandClassifier';
import * as core from '../../lib/composer-local-commands-core';

test('Web wrapper keeps runtime detection dynamic and explicit reload overrides win', () => {
  for (const vscode of [false, true, false]) {
    runtime.vscode = vscode;
    expect(wrapper.getLocalChatCommand('/reload detail', 'normal')).toBe(vscode ? 'reload' : null);
    expect(wrapper.preservesComposerResources('/reload', 'normal')).toBe(vscode);
    expect(wrapper.consumesImmediateCommandText('/reload', 'normal')).toBe(vscode);
    expect(wrapper.getLocalChatCommand('/reload', 'normal', { reloadEnabled: !vscode })).toBe(vscode ? null : 'reload');
    for (const name of core.LOCAL_CHAT_COMMANDS) {
      for (const mode of ['normal', 'shell'] as const) {
        expect(wrapper.getLocalChatCommand(` /\u2003${name.toUpperCase()} tail`, mode)).toBe(core.getLocalChatCommand(` /\u2003${name.toUpperCase()} tail`, mode, { reloadEnabled: vscode }));
      }
    }
  }
  expect(wrapper.LOCAL_CHAT_COMMANDS).toBe(core.LOCAL_CHAT_COMMANDS);
  expect(wrapper.IMMEDIATE_LOCAL_CHAT_COMMANDS).toBe(core.IMMEDIATE_LOCAL_CHAT_COMMANDS);
});

test('metadata preserves exact Web ordering, descriptions, flags and target/VS Code availability', () => {
  const context = { hasSession: true, hasMessages: false, canStartSessionCommand: true, reloadEnabled: true };
  const all = core.getComposerLocalCommandMetadata(context, key => key);
  expect(all.map(row => row.name)).toEqual(['new', 'init', 'btw', 'undo', 'redo', 'fork', 'timeline', 'model', 'compact', 'reload', 'summary', 'workspace-review', 'craft-goal', 'catch-up', 'debug', 'weigh', 'explore']);
  expect(all.find(row => row.name === 'btw')).toEqual({ id: 'yuri:btw', name: 'btw', source: 'yuri', description: 'chat.btw.description', isBuiltIn: true });
  expect(all.find(row => row.name === 'summary')).toEqual({ id: 'yuri:summary', name: 'summary', source: 'yuri', description: 'chat.commandAutocomplete.command.summaryDescription', isYuri: true });
  expect(core.getComposerLocalCommandMetadata({ ...context, hasMessages: true, reloadEnabled: false }, key => key).map(row => row.name)).toEqual(all.map(row => row.name).filter(name => name !== 'init' && name !== 'reload'));
  expect(core.getComposerLocalCommandMetadata({ hasSession: false, hasMessages: false, canStartSessionCommand: false, reloadEnabled: false }, key => key).map(row => row.name)).toEqual(['new', 'model', 'compact']);
  expect(core.getComposerLocalCommandMetadata({ hasSession: false, hasMessages: false, canStartSessionCommand: true, reloadEnabled: false }, key => key).map(row => row.name)).toEqual(['new', 'model', 'compact', 'workspace-review', 'craft-goal', 'catch-up', 'debug', 'weigh', 'explore']);
});
