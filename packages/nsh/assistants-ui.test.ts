import { runSettingsEngineFixture } from './tests/settings-engine-fixture-runner.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));
it('native engine renders real AssistantHome and details without React/DOM; local search issues no HTTP', () => {

  const steps = [
    'await app.waitFor("text:Research Bot");',
    'await app.waitFor("text:Authoritative latest reply");',
    'expect(app.texts().join("\\n")).not.toContain("Never use personality as preview");',
    'await app.press("id:assistant-toggle-search");',
    'await app.press("id:assistants-fixture-audit");',
    'await app.waitUntil(() => app.texts().some(text => text.startsWith("{\\"requests\\":")));',
    'const searchAudit = JSON.parse(app.texts().find(text => text.startsWith("{\\"requests\\":")));',
    'const before=app.host.calls().length;',
    'await app.type("id:assistant-search","Research");',
    'expect(app.host.calls().length).toBe(before);',
    'await app.press("id:assistants-fixture-audit");',
    'await app.waitUntil(() => app.texts().some(text => text.includes("\\"auditReads\\":2")));',
    'expect(JSON.parse(app.texts().find(text => text.startsWith("{\\"requests\\":")))).toEqual({...searchAudit,auditReads:2});',
    'await app.press("id:assistant-open-a");',
    'expect(app.texts().join("\\n")).toContain("a");',
    'await app.drag("id:assistant-open-a",{x:2,y:45});',
    'expect(app.shows("id:assistant-swipe-delete-a")).toBe(false);',
    'await app.drag("id:assistant-open-a",{x:-100,y:2});',
    'await app.waitFor("id:assistant-swipe-delete-a");',
    'app.onDialog(()=>"Cancel");',
    'const beforeCancel=app.host.calls().length;',
    'await app.press("id:assistant-swipe-delete-a");',
    'expect(app.host.calls().length).toBe(beforeCancel);',
    'expect(app.shows("id:assistant-open-a")).toBe(true);',
    'await app.press("id:assistants-fixture-audit");',
    'await app.waitUntil(() => app.texts().some(text => text.includes("\\"auditReads\\":3")));',
    'expect(JSON.parse(app.texts().find(text => text.startsWith("{\\"requests\\":")))).toMatchObject({deleteAttempts:0});',
    'await app.drag("id:assistant-open-a",{x:-100,y:0});',
    'app.onDialog(()=>"Delete");',
    'await app.press("id:assistant-swipe-delete-a");',
    'await app.waitFor("text:HTTP 500: delete_test_failure");',
    'await app.press("id:assistants-fixture-audit");',
    'await app.waitUntil(() => app.texts().some(text => text.includes("\\"deleteAttempts\\":1")));',
    'expect(app.shows("id:assistant-open-a")).toBe(true);',
    'await app.drag("id:assistant-open-a",{x:-100,y:0});',
    'await app.press("id:assistant-swipe-edit-a");',
    'await app.waitFor("text:Message channels");',
    'await app.waitFor("text:Generate a random avatar");',
    'await app.press("text:WeCom");',
    'await app.waitFor("text:Message channels are disabled in development builds. Use a release build, or enable channels in the host configuration, then reopen this dialog.");',
    'expect(app.texts().join("\\n")).not.toContain("Bot secret");',
    'expect(app.texts().join("\\n")).not.toMatch(/Unexpected request|Unexpected Assistant|runtime_stale|page_operation_stale/);',
  ];
  const result = runSettingsEngineFixture(directory, 'assistants-test-app.tsx', 'tests/assistants-host.js', steps, 60_000);
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 90_000);
