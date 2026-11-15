import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { stageNativeApplication } from './scripts/stage-native-application.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
it('production wallpaper/row opens a conversation with both full text bubbles, compact timestamps and current replacement content', async () => {
  const ios = process.env.NSH_ASSISTANT_WORKSPACE_IOS === '1';
  const parent = await mkdtemp(path.join(directory, '.nsh/assistant-workspace-'));
  try {
    const stage = await stageNativeApplication({ root: path.join(parent, 'source'), entry: 'packages/nsh/assistants-workspace-fixture.tsx' });
    const screenshot = (name: string) => `await app.screenshot(${JSON.stringify(path.join(directory, '.nsh', name + '.png'))});`;
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', stage.entry, ...(ios ? ['--target', 'ios'] : [])], {
      cwd: stage.cwd, encoding: 'utf8', timeout: 120_000, input: [
        'await app.waitFor("text:Magpie 助理");',
        'expect(app.shows("id:assistant-wallpaper")).toBe(true);',
        ...(ios ? [screenshot('assistant-catalog-light')] : []),
        'await app.press("id:assistant-open-artwork-fixture");',
        'await app.waitFor("text:帮我整理一下今天的进展。");',
        'await app.waitFor("id:assistant-bubble-time");',
        'expect(app.texts().join(" ")).toContain("验证手机上的布局和交互。");',
        ...(ios ? [screenshot('assistant-conversation-light')] : []),
        'await app.press("id:workspace-replace");',
        'await app.waitFor("text:内容已更新，原文保留。");',
        'await app.press("id:workspace-theme");',
        'expect(app.texts().join(" ")).toContain("核心功能已完成。");',
        ...(ios ? [screenshot('assistant-conversation-dark')] : []),
        'await app.press("id:assistant-chat-identity");',
        'await app.waitFor("text:Settings opened");',
      ].join('\n'),
    });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { await rm(parent, { recursive: true, force: true }); }
}, 135_000);
