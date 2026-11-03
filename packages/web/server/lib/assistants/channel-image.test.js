import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: io.lookup }));
vi.mock('node:https', () => ({ request: io.request }));
import { loadChannelImage } from './channel-image.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKxkAAAAASUVORK5CYII=', 'base64');
const source = { url: 'https://images.example.com/generated.png?signature=image-capability' };
const input = { cwd: process.cwd(), allowedRoots: [] };
beforeEach(() => {
  vi.resetAllMocks();
  io.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  io.request.mockImplementation((_url, _options, callback) => {
    const request = new EventEmitter();
    request.end = () => {
      const response = Readable.from([png]);
      response.statusCode = 200;
      response.headers = {};
      callback(response);
    };
    return request;
  });
});

describe('public HTTPS image boundary', () => {
  it('pins the validated DNS answer instead of looking it up again at connection time', async () => {
    expect(await loadChannelImage(source, input)).toMatchObject({ buffer: png, mime: 'image/png' });
    expect(io.lookup).toHaveBeenCalledOnce();
    const [url, options] = io.request.mock.calls[0];
    expect(url.hostname).toBe('images.example.com');
    expect(options.headers).toBeUndefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const callback = vi.fn();
    options.lookup('images.example.com', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
    expect(io.lookup).toHaveBeenCalledOnce();
  });

  it('rejects any private DNS result before opening a connection', async () => {
    io.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    await expect(loadChannelImage(source, input)).rejects.toMatchObject({ code: 'image_unavailable' });
    expect(io.request).not.toHaveBeenCalled();
  });

  it.each([302, 401, 500])('rejects status %i without following redirects or accepting an empty image', async (status) => {
    io.request.mockImplementation((_url, _options, callback) => {
      const request = new EventEmitter();
      request.end = () => {
        const response = Readable.from([png]);
        response.statusCode = status;
        response.headers = { location: 'https://127.0.0.1/private' };
        callback(response);
      };
      return request;
    });
    await expect(loadChannelImage(source, input)).rejects.toMatchObject({ code: 'image_unavailable' });
    expect(io.request).toHaveBeenCalledOnce();
  });

  it('rejects oversized chunked bodies even without content-length', async () => {
    io.request.mockImplementation((_url, _options, callback) => {
      const request = new EventEmitter();
      request.end = () => {
        const response = Readable.from([Buffer.alloc(20 * 1024 * 1024 + 1)]);
        response.statusCode = 200;
        response.headers = {};
        callback(response);
      };
      return request;
    });
    await expect(loadChannelImage(source, input)).rejects.toMatchObject({ code: 'PROMPT_ATTACHMENT_TOO_LARGE' });
  });
});
