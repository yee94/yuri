import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Script } from 'node:vm';
import { createSettingsTargetNavigation, prepareCollectionSearchTarget, searchSettingsFields, settingsSearchItems } from './settings-search-core';
import { settingsPreferenceFields } from './settings-preferences-core';
import { settingsBasicSections, settingsBasicTarget } from './settings-basics-core';

const root = path.dirname(fileURLToPath(import.meta.url));
const webPreferenceTargets = [
  { key: 'padding', id: 'appearance.spacing-density', page: 'appearance' },
  { key: 'pwaAppName', id: 'appearance.pwa-install-name', page: 'appearance' },
  { key: 'pwaOrientation', id: 'appearance.pwa-orientation', page: 'appearance' },
  { key: 'allowPromptingSubagentSessions', id: 'chat.subagent-read-only-banner', page: 'chat' },
] as const;
const sessionTargets = [
  { id: 'sessions.opencode-binary', title: 'settings.yuri.opencodeCli.field.binaryPath', query: 'CLI path', control: 'settings-sessions-cli-path' },
  { id: 'sessions.opencode-update-notifications', title: 'settings.yuri.opencodeCli.field.showUpdateNotifications', query: 'upgrade notifications', control: 'settings-sessions-update-notifications' },
  { id: 'sessions.passkeys', title: 'settings.yuri.passkeys.title', query: 'Passkey management', control: 'settings-sessions-passkey-add' },
] as const;

describe('Native Settings field search', () => {
  it('excludes iOS/browser-only appearance entries from desktop search and global config from iOS', () => {
    for (const os of ['macos', 'windows']) {
      for (const query of ['iosNativeUiEnabled', 'pwaAppName', 'mobileKeyboardMode']) expect(searchSettingsFields(query, key => key, os)).toEqual([]);
      expect(searchSettingsFields('opencode.jsonc', key => key, os).map(item => item.id)).toEqual(['global-config.editor']);
    }
    expect(searchSettingsFields('opencode.jsonc', key => key, 'ios')).toEqual([]);
  });
  it.each(webPreferenceTargets)('matches Web target $id and forwards its real Prefs reveal callback to measured navigation', async item => {
    const web = ts.createSourceFile('search.ts', readFileSync(path.join(root, '../ui/src/lib/settings/search.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
    const ids = new Set<string>();
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && node.name.getText(web) === 'id' && ts.isStringLiteral(node.initializer)) ids.add(node.initializer.text);
      ts.forEachChild(node, visit);
    };
    visit(web); expect(ids.has(item.id)).toBe(true);
    const field = settingsPreferenceFields.find(field => field.key === item.key)!;
    expect(field).toMatchObject({ id: item.id, page: item.page });
    expect(settingsSearchItems.filter(entry => entry.id === item.id)).toHaveLength(1);
    expect(searchSettingsFields(item.key, key => key)).toContainEqual(expect.objectContaining({ id: item.id, page: item.page }));
    const source = ts.createSourceFile('settings-preferences.tsx', readFileSync(path.join(root, 'settings-preferences.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let opening = '';
    const find = (node: ts.Node) => { if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === 'SettingsTarget') opening = node.getText(source); ts.forEachChild(node, find); };
    find(source); expect(opening).not.toBe('');
    const scrollTo = vi.fn(), viewport = { measure: async () => ({ pagePosition: { y: 90 } }), scrollTo };
    const navigation = createSettingsTargetNavigation(() => viewport, () => true), reveal = vi.spyOn(navigation, 'reveal');
    navigation.onScroll({ offset: { y: 120 } });
    const output = ts.transpileModule(`(${opening.slice(0, -1)} />)`, { compilerOptions: { target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' } }).outputText;
    const props = new Script(output).runInNewContext({ SettingsTarget: 'SettingsTarget', jsx: (_type: unknown, props: unknown) => props, id: () => field.id, props: { target: item.id }, navigation, previewVisibility: {} }) as { id: string; target: string; onReveal: (node: { measure: () => Promise<{ pagePosition: { y: number } }> }) => void };
    expect(props.id).toBe(props.target); props.onReveal({ measure: async () => ({ pagePosition: { y: 420 } }) });
    await reveal.mock.results[0].value;
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ y: 450, animated: false });
  });
  it('matches translated field labels and technical synonyms, not only page titles', () => {
    const t = (key: string) => key.endsWith('section.messageStreamTransport') ? '消息流传输' : key;
    expect(searchSettingsFields('消息流', t).map(item => item.id)).toEqual(['chat.message-transport']);
    expect(searchSettingsFields('ws', t).some(item => item.id === 'chat.message-transport')).toBe(true);
    expect(searchSettingsFields('git commit', t).map(item => item.id)).toEqual(['summary-ai.commit-prompt']);
    expect(searchSettingsFields('  ', t)).toEqual([]);
    expect(searchSettingsFields('not-in-any-setting', t)).toEqual([]);
  });
  it('indexes every new visible field once, without dynamic entities or hidden desktop controls', () => {
    expect(new Set(settingsSearchItems.map(item => item.id)).size).toBe(settingsSearchItems.length);
    for (const field of settingsPreferenceFields) expect(settingsSearchItems.some(item => item.id === field.id)).toBe(true);
    for (const section of settingsBasicSections) for (const field of section.fields) expect(settingsSearchItems.some(item => item.id === settingsBasicTarget(section.page, field))).toBe(true);
    expect(settingsSearchItems.some(item => /inline-assistant|spellcheck|terminal-quick/.test(item.id))).toBe(false);
  });
  it('exposes the implemented About surfaces including the disabled update explanation and conditional export target', () => {
    const about = settingsSearchItems.filter(item => item.page === 'about');
    expect(about.map(item => item.id)).toEqual(['about.feedback', 'about.host-update', 'about.check-updates', 'about.beta-updates', 'about.diagnostics', 'about.export-diagnostics']);
    expect(searchSettingsFields('export diagnostics', key => key).some(item => item.id === 'about.export-diagnostics')).toBe(true);
  });
  it.each(sessionTargets)('indexes the permanent Sessions surface $id with its existing localized label', item => {
    expect(settingsSearchItems.filter(entry => entry.id === item.id)).toEqual([expect.objectContaining({ page: 'sessions', title: item.title })]);
    expect(searchSettingsFields(item.query, key => key).map(entry => entry.id)).toContain(item.id);
    expect(searchSettingsFields('已翻译的设置标签', key => key === item.title ? '已翻译的设置标签' : '').map(entry => entry.id)).toEqual([item.id]);
    expect(prepareCollectionSearchTarget('sessions', item.id)).toBeNull();
  });
  it('keeps Sessions leaf anchors permanent and aligned with the static catalog, using the original measured reveal port', () => {
    const source = ts.createSourceFile('settings-sessions.tsx', readFileSync(path.join(root, 'settings-sessions.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const attribute = (node: ts.JsxElement, name: string) => node.openingElement.attributes.properties.find((item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText(source) === name);
    for (const item of sessionTargets) {
      const matches: ts.JsxElement[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'SettingsTarget') {
          const id = attribute(node, 'id')?.initializer;
          if (id && ts.isStringLiteral(id) && id.text === item.id) matches.push(node);
        }
        ts.forEachChild(node, visit);
      };
      visit(source); expect(matches).toHaveLength(1);
      const target = matches[0];
      expect(attribute(target, 'target')?.initializer?.getText(source)).toBe('{props.target}');
      expect(attribute(target, 'onReveal')?.initializer?.getText(source)).toBe('{props.onReveal}');
      expect(target.getText(source)).toContain(`testID="${item.control}"`);
      for (let parent: ts.Node | undefined = target.parent; parent; parent = parent.parent) {
        if (ts.isJsxElement(parent)) expect(['If', 'Each']).not.toContain(parent.openingElement.tagName.getText(source));
      }
      if (item.id === 'sessions.passkeys') {
        expect(target.getText(source)).toContain("<SettingsGroup title={t('settings.yuri.passkeys.title')}>");
        expect(target.getText(source)).toContain('settings-sessions-auth-reset');
        expect(target.getText(source)).toContain('settings-sessions-passkey-delete-${row().id}');
      }
    }
  });
  it('does not index the conditional browser selector or dynamic credentials and preserves collection target preparation', () => {
    expect(settingsSearchItems.some(item => item.id === 'sessions.browser-provider')).toBe(false);
    expect(settingsSearchItems.filter(item => item.id.startsWith('sessions.passkey')).map(item => item.id)).toEqual(['sessions.passkeys']);
    expect(prepareCollectionSearchTarget('mcp', 'mcp.advanced')).toEqual({ create: true, draft: { type: 'remote' } });
    expect(prepareCollectionSearchTarget('mcp', 'mcp.command')).toEqual({ create: true, draft: { type: 'local' } });
    expect(prepareCollectionSearchTarget('commands', 'commands.template')).toEqual({ create: true, draft: {} });
    expect(prepareCollectionSearchTarget('sessions', 'sessions.browser-provider')).toBeNull();
  });
  it('reuses keys present in all ten Settings dictionaries for the new permanent Sessions results', () => {
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'pl', 'pt-BR', 'uk']) {
      const source = readFileSync(path.join(root, `../ui/src/lib/i18n/messages/${locale}.settings.ts`), 'utf8');
      for (const { title } of sessionTargets) expect(source.includes(`'${title}':`) || source.includes(`"${title}":`), `${locale}: ${title}`).toBe(true);
    }
  });
  it('reveals the actual measured field without reordering or assuming uniform row height', async () => {
    const scrollTo = vi.fn(), viewport = { measure: async () => ({ pagePosition: { y: 90 } }), scrollTo };
    const navigation = createSettingsTargetNavigation(() => viewport, () => true);
    navigation.onScroll({ offset: { y: 120 } });
    await navigation.reveal({ measure: async () => ({ pagePosition: { y: 420 } }) });
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ y: 450, animated: false });
    await navigation.reveal({ measure: async () => ({ pagePosition: { y: 900 } }) });
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });
  it('waits for real layout and fences a late measurement when the owner changes', async () => {
    let current = true;
    const scrollTo = vi.fn(), viewport = { measure: async () => ({ pagePosition: { y: 0 } }), scrollTo };
    const navigation = createSettingsTargetNavigation(() => viewport, () => current);
    await navigation.reveal({ measure: async () => null });
    expect(scrollTo).not.toHaveBeenCalled();
    let resolve!: (value: { pagePosition: { y: number } }) => void;
    const pending = navigation.reveal({ measure: () => new Promise(done => { resolve = done; }) });
    current = false; resolve({ pagePosition: { y: 100 } }); await pending;
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
