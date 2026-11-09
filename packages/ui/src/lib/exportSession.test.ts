import { describe, expect, it, vi } from 'vitest';
import { formatSessionAsMarkdown as nativeFormat, buildExportFilename as nativeFilename } from './export-session-core';
vi.mock('@/lib/i18n', () => ({ getCurrentIntlLocale: () => 'en' }));
vi.mock('@/contexts/runtimeAPIRegistry', () => ({ getRegisteredRuntimeAPIs: () => undefined }));
vi.mock('@/lib/desktop', () => ({ isVSCodeRuntime: () => false, openDesktopPath: vi.fn(), revealDesktopPath: vi.fn(), saveDesktopMarkdownFile: vi.fn() }));
vi.mock('@/lib/utils', () => ({ getRevealLabelKey: () => 'reveal' }));
import { formatSessionAsMarkdown as webFormat, buildExportFilename as webFilename } from './exportSession';

describe('Web/native export formatter seam', () => {
  it('preserves model, timestamp, multipart text, descendants and the original filename export', () => {
    const records = [{ info: { id: 'message', sessionID: 'session', role: 'assistant', time: { created: 1000 }, providerID: 'provider', modelID: 'model' }, parts: [{ type: 'text', text: 'First' }, { type: 'reasoning', text: 'Not exported' }, { type: 'text', text: 'Second' }] }] as Parameters<typeof webFormat>[0];
    const children = [{ title: 'Child', agent: 'Agent', records, children: [] }];
    expect(webFormat(records, 'Title', children)).toBe(nativeFormat(records, 'Title', children, 'en'));
    expect(webFormat(records, 'Title', children)).toContain('FirstSecond');
    expect(webFormat(records, 'Title', children)).not.toContain('Not exported');
    expect(webFilename).toBe(nativeFilename);
    expect(webFilename('Title / 标题')).toMatch(/^title-标题-\d{4}-\d{2}-\d{2}\.md$/);
  });
});
