import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAssistantDTO } from '@/queries/assistantDTO';
import type { AssistantLatestMessagePreview } from '@/queries/assistantDTO';
// @ts-expect-error Shared server contract fixture is JavaScript.
import { assistantContractFixtures } from '../../../../web/server/lib/assistants/contracts.js';
import { ASSISTANT_MESSAGE_PREVIEW_CLASS, getAssistantMessagePreview } from './assistantMessagePreview';

const preview: AssistantLatestMessagePreview = { createdAt: 123, messageID: 'm2', ordinal: 2, role: 'assistant', text: '最新消息', fallbackKind: null };
const t = (key: string) => key;

describe('Assistant snapshot message preview', () => {
  test('keeps the server-selected latest user or assistant message', () => {
    for (const role of ['user', 'assistant'] as const) {
      const assistant = parseAssistantDTO({ ...assistantContractFixtures.assistant, latestMessagePreview: { ...preview, role } });
      expect(assistant.latestMessagePreview).toEqual({ ...preview, role });
      expect(getAssistantMessagePreview(assistant.latestMessagePreview, t)).toBe('最新消息');
    }
  });

  test('normalizes legacy absence and authoritative empty history', () => {
    for (const latestMessagePreview of [undefined, null]) {
      const assistant = parseAssistantDTO({ ...assistantContractFixtures.assistant, latestMessagePreview });
      expect(assistant.latestMessagePreview).toBeNull();
      expect(getAssistantMessagePreview(assistant.latestMessagePreview, t)).toBe('assistants.contact.empty');
    }
  });

  test('rejects malformed preview contracts and internal roles', () => {
    for (const patch of [{ ordinal: -1 }, { ordinal: 1.5 }, { role: 'tool' }, { role: 'peer' }, { text: null }, { fallbackKind: 'tool' }]) {
      expect(() => parseAssistantDTO({ ...assistantContractFixtures.assistant, latestMessagePreview: { ...preview, ...patch } })).toThrow();
    }
  });

  test('uses readable attachment/card labels and preserves supplied titles', () => {
    const keys = { image: 'assistants.contact.attachment.image', file: 'assistants.contact.attachment.file', session: 'assistants.contact.card.session.untitled', assistant: 'assistants.title', schedule: 'assistants.settings.scheduledTasks.title' } as const;
    for (const fallbackKind of Object.keys(keys) as Array<keyof typeof keys>) {
      expect(getAssistantMessagePreview({ ...preview, fallbackKind, text: '' }, t)).toBe(keys[fallbackKind]);
      expect(getAssistantMessagePreview({ ...preview, fallbackKind, text: '  标题\n filename.txt  ' }, t)).toBe('标题 filename.txt');
    }
    expect(getAssistantMessagePreview({ ...preview, text: ' \n ' }, t)).toBe('assistants.contact.empty');
  });

  test('shares single-line truncation across both lists using snapshot only', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = await Promise.all(['AssistantView.tsx', '../../mobile/assistant/MobileAssistantTab.tsx'].map((path) => readFile(join(here, path), 'utf8')));
    for (const source of sources) {
      expect(source).toContain('ASSISTANT_MESSAGE_PREVIEW_CLASS');
      expect(source).toContain('.latestMessagePreview, t)');
      expect(source).not.toContain('defaultPrompt.trim()');
      expect(source).not.toContain('useAssistantContactMessagesQuery');
    }
    expect(ASSISTANT_MESSAGE_PREVIEW_CLASS).toContain('truncate');
    expect(ASSISTANT_MESSAGE_PREVIEW_CLASS).not.toContain('line-clamp-2');
  });

  test.each([
    ['**跳过与失败：** **3 条误存 global 的记录**', '跳过与失败： 3 条误存 global 的记录'],
    ['![Telegram Bot API Update 事件总线](https://example.com/image.png)', 'Telegram Bot API Update 事件总线'],
    ['![Telegram Bot API Update 事件总线…', 'Telegram Bot API Update 事件总线…'],
    ['[查看说明](https://example.com/docs)', '查看说明'],
    ['[查看说明](https://example.com/截断', '查看说明'],
    ['### 标题\n> 引用\n- [x] 完成\n1. 下一步', '标题 引用 完成 下一步'],
    ['`run_task` 与 ***强调***、_斜体_、~~旧内容~~', 'run_task 与 强调、斜体、旧内容'],
    ['```ts\nconst ready = true;\n```', 'const ready = true;'],
    ['```ts const ready = true; ```', 'const ready = true;'],
    ['<b>不渲染 HTML</b> &amp; 原样保留', '<b>不渲染 HTML</b> &amp; 原样保留'],
    ['普通消息 C#、a * b、snake_case_name、foo__bar__baz、[状态]、2 + 3 = 5', '普通消息 C#、a * b、snake_case_name、foo__bar__baz、[状态]、2 + 3 = 5'],
  ])('hides common Markdown markers without rendering: %s', (text, expected) => {
    const message = { ...preview, text };
    expect(getAssistantMessagePreview(message, t)).toBe(expected);
    expect(message.text).toBe(text);
  });

  test('keeps attachment filenames and card titles literal', () => {
    for (const fallbackKind of ['file', 'session'] as const) {
      expect(getAssistantMessagePreview({ ...preview, fallbackKind, text: '**literal**_name.txt' }, t)).toBe('**literal**_name.txt');
    }
  });
});
