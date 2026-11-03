import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareChannelOutput, readChannelDeliveryImage } from './channel-output.js';
import { loadChannelImage } from './channel-image.js';
import { createAssistantsService } from './service.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKxkAAAAASUVORK5CYII=', 'base64');
const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });
const options = (overrides = {}) => ({ service: { prepareChannelImage: vi.fn(async () => ({ attachmentID: 'att_image' })) },
  assistantID: 'bot', generation: 0, language: 'zh-CN', failureText: 'failed', assertCurrent: () => {}, ...overrides });

describe('shared channel image output', () => {
  it.each(['session', 'assistant', 'schedule', 'future-card'])('silently excludes %s cards instead of sending title/link fallbacks', async (cardType) => {
    const input = options();
    const card = { type: 'card', cardType, title: 'Internal title', name: 'Internal name', url: 'yuri://internal' };
    expect(await prepareChannelOutput({ messageID: 'card', text: '', cards: [card] }, input)).toEqual([]);
    expect(await prepareChannelOutput({ messageID: 'card-parts', parts: [card], cards: [card] }, input)).toEqual([]);
    expect(input.service.prepareChannelImage).not.toHaveBeenCalled();
    expect(await prepareChannelOutput({ messageID: 'mixed', parts: [{ type: 'text', text: 'Normal reply' }, card,
      { type: 'file', mime: 'image/png', attachmentID: 'att_image' }] }, input))
      .toEqual([{ text: 'Normal reply' }, { text: '', image: { attachmentID: 'att_image' } }]);
  });
  it('keeps prose/image order, parses escaped/spaced/reference URLs, ignores code and ordinary links', async () => {
    const input = options();
    const output = await prepareChannelOutput({ messageID: 'm', text: 'Before ![a](</a b.png>) after ![b][ref]\n\n[ref]: https://example.com/b.png\n\n`![code](/secret.png)` [link](/file.png)' }, input);
    expect(output.map((part) => part.image ? 'image' : part.text)).toEqual(['Before', 'image', 'after', 'image', '`![code](/secret.png)` [link](/file.png)']);
    expect(input.service.prepareChannelImage.mock.calls.map(([, source]) => source.url)).toEqual(['/a b.png', 'https://example.com/b.png']);
    expect(JSON.stringify(output)).not.toContain('/a b.png');
  });

  it('supports attachment-only replies and partial failure without dropping later content', async () => {
    const input = options();
    input.service.prepareChannelImage.mockRejectedValueOnce(new Error('private path and credential'));
    const result = await prepareChannelOutput({ messageID: 'm', parts: [{ type: 'file', mime: 'image/png', attachmentID: 'one' },
      { type: 'text', text: 'next' }, { type: 'file', mime: 'image/jpeg', url: 'data:image/jpeg;base64,AA==' }] }, input);
    expect(result).toEqual([{ text: '图片未能发送，请在 Yuri 中查看原图。' }, { text: 'next' }, { text: '', image: { attachmentID: 'att_image' } }]);
    expect(JSON.stringify(result)).not.toMatch(/private|credential|data:/);
  });

  it('fences late image preparation after a reset', async () => {
    let current = true;
    const input = options({ assertCurrent: () => { if (!current) throw new Error('cancelled'); } });
    input.service.prepareChannelImage.mockImplementation(async () => { current = false; return { attachmentID: 'old' }; });
    await expect(prepareChannelOutput({ messageID: 'm', text: '![a](/a.png)' }, input)).rejects.toThrow('cancelled');
  });

  it('snapshots local generated images into owned durable attachments and reuses them after source removal', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-channel-images-'));
    cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
    const service = createAssistantsService({ dbPath: path.join(directory, 'assistants.sqlite'), dataDir: directory,
      buildOpenCodeUrl: () => 'http://127.0.0.1:1', getOpenCodeAuthHeaders: () => ({}),
      getAllowedRoots: () => [directory], createChatCompletion: async () => ({ choices: [] }) });
    cleanups.push(() => service.close());
    const bot = service.createAssistant({ name: 'Image test', providerID: 'p', modelID: 'm', workspacePath: directory });
    const source = path.join(directory, 'generated.png');
    await fs.writeFile(source, png);
    const image = await service.prepareChannelImage(bot.id, { url: source }, { generation: 0, uploadID: 'test-image' });
    await fs.unlink(source);
    expect(await service.prepareChannelImage(bot.id, { url: source }, { generation: 0, uploadID: 'test-image' })).toEqual(image);
    expect(await readChannelDeliveryImage(service, bot.id, image)).toMatchObject({ buffer: png, mime: 'image/png' });
    const other = service.createAssistant({ name: 'Other', providerID: 'p', modelID: 'm' });
    await expect(readChannelDeliveryImage(service, other.id, image)).rejects.toMatchObject({ code: 'not_found' });
  });

  it.each(['https://127.0.0.1/a.png', 'https://[::1]/a.png', 'https://[::ffff:127.0.0.1]/a.png', 'http://example.com/a.png',
    'https://user:password@example.com/a.png', 'https://169.254.169.254/a.png', 'https://10.0.0.1/a.png'])('rejects unsafe remote image %s', async (url) => {
    await expect(loadChannelImage({ url }, { cwd: os.tmpdir(), allowedRoots: [] })).rejects.toMatchObject({ code: 'image_unavailable' });
  });

  it('rejects disguised HTML/SVG and bounds inline bytes', async () => {
    const input = { cwd: os.tmpdir(), allowedRoots: [] };
    await expect(loadChannelImage({ url: 'data:image/png;base64,PGh0bWw+' }, input)).rejects.toThrow();
    await expect(loadChannelImage({ url: 'data:image/svg+xml;base64,PHN2Zz4=' }, input)).rejects.toThrow();
    expect(await loadChannelImage({ url: `data:image/png;base64,${png.toString('base64')}` }, input)).toMatchObject({ buffer: png, mime: 'image/png' });
  });
});
