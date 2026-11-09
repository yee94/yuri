import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { prepareInteractionEngineDriver } from './tests/chat-interaction-engine-driver';

const directory = path.dirname(fileURLToPath(import.meta.url));
test('native header opens real metadata, refreshes, closes, and preserves both toolbar callbacks', () => {
  const steps = [
    'await app.waitFor("id:chat-header-metadata");',
    'await app.waitFor("text:13:05");',
    'await app.press("id:chat-header-metadata");',
    'await app.waitFor("text:feature/header");',
    'await app.waitFor("text:700/1.0K");',
    'await app.waitFor("text:70.0%");',
    'await app.waitFor("text:Cursor · Fixture");',
    'await app.waitFor("text:ACCOUNT ALPHA");',
    'await app.waitFor("text:8%");',
    'await app.press("id:chat-metadata-refresh");',
    'await app.waitFor("text:700/1.0K");',
    'await app.press("id:chat-header-metadata");',
    'await app.press("id:request-count");',
    'const beforeTyping = app.texts().find(value => value.startsWith("Calls "));',
    'expect(beforeTyping).not.toBe("Calls 0");',
    'expect(beforeTyping).not.toBe("Calls -1");',
    'await app.type("id:unrelated-input", "Fifty unrelated characters must never fetch metadata");',
    'await app.press("id:request-count");',
    'expect(app.texts()).toContain(beforeTyping);',
    'for (const option of ["new-session", "files", "changes", "mcp", "remote-desktop", "refresh"]) {',
    'await app.press("id:chat-header-options");',
    'await app.waitFor("id:chat-menu-files");',
    'expect(app.shows("id:chat-menu-remote-desktop")).toBe(true);',
    'expect(app.texts()).not.toContain("Model / Agent settings");',
    'await app.press("id:chat-menu-" + option);',
    'await app.waitFor("text:Options " + option);',
    '}',
    'await app.press("id:chat-header-back");',
     'await app.waitFor("text:Back pressed");',
    'await app.press("id:native-header");',
    'await app.press("id:chat-header-options");',
    'await app.waitFor("id:chat-menu-files");',
    'await app.press("id:chat-menu-files");',
    'await app.waitFor("text:Options files");',
    'await app.press("id:chat-header-metadata");',
    'await app.waitFor("text:700/1.0K");',
    'await app.press("id:chat-header-metadata");',
    'await app.press("id:fail-anchor");',
    'await app.press("id:chat-header-options");',
    'await app.waitFor("text:Anchor unavailable");',
  ];
  const driver = prepareInteractionEngineDriver(directory, 'chat-header-test-app.tsx', 'tests/chat-header-host.js', steps);
  try {
    const fixture = driver.bundleHost();
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', driver.testFile, '--web-host', fixture], { cwd: directory, encoding: 'utf8', timeout: 45000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { driver.dispose(); }
}, 60000);

test('Chat delegates back/title to the system navigation bar and puts only context/workspace in its trailing slot', () => {
  const source = readFileSync(path.join(directory, 'application.tsx'), 'utf8').split('function Chat(props:')[1].split('function ResourceCard(')[0];
  expect(source).not.toContain('headerVisible={false}');
  expect(source).not.toContain('headerBackVisible={false}');
  expect(source).toContain('headerRight={platform.desktop ? undefined : <ChatHeaderActions');
  expect(source).toContain('header={platform.desktop ? undefined : <NativeChatHeader');
  expect(source).toContain('<NativeChatHeader');
  expect(source).not.toContain('headerLeft=');
  expect(source).not.toContain('headerRightSymbol');
  for (const action of ['new-session', 'files', 'changes', 'mcp', 'selection', 'refresh', 'auto-read', 'remote-desktop']) expect(source).toContain(`action === '${action}'`);
  const header = readFileSync(path.join(directory, 'chat-header.tsx'), 'utf8');
  expect(header).not.toContain('<WorkspaceAction id="selection"');
  expect(header).toContain('<WorkspaceAction id="remote-desktop"');
  expect(header).toContain('<WorkspaceAction id="auto-read"');
  expect(header).not.toContain('bg-card/90');
  expect(header).not.toContain('windowSize().height * .72');
});
