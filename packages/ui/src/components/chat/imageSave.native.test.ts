import { beforeEach, expect, test, vi } from 'vitest';

const media = vi.hoisted(() => ({
  stageFile: vi.fn(),
  saveStagedFile: vi.fn(),
  discardStagedFile: vi.fn(),
  saveFile: vi.fn(),
  saveImage: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isPluginAvailable: () => true },
  registerPlugin: () => media,
}));
vi.mock('@/lib/platform', () => ({ isCapacitorApp: () => true }));
vi.mock('@/lib/desktop', () => ({ isVSCodeRuntime: () => false }));
vi.mock('@/contexts/runtimeAPIRegistry', () => ({ getRegisteredRuntimeAPIs: () => null }));

import { saveImageToDevice } from './imageSave';

const video = (bytes: number) => ({
  kind: 'video' as const,
  sourceUrl: 'https://example.test/clip.mp4',
  filename: 'clip.mp4',
  mimeType: 'video/mp4',
  prefetchedBlob: new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }),
});

beforeEach(() => {
  for (const fn of Object.values(media)) fn.mockReset();
  media.discardStagedFile.mockResolvedValue(undefined);
});

test('large videos stage in bounded chunks and report save progress', async () => {
  media.stageFile.mockResolvedValue(undefined);
  media.saveStagedFile.mockResolvedValue({ cancelled: false });
  const progress: Array<number | null> = [];

  await expect(saveImageToDevice(video(7 * 1024 * 1024), undefined, (p) => progress.push(p))).resolves.toBe('saved');

  expect(media.stageFile).toHaveBeenCalledTimes(3);
  expect(media.stageFile.mock.calls.map(([options]) => options.append)).toEqual([false, true, true]);
  const id = media.stageFile.mock.calls[0][0].id;
  expect(media.saveStagedFile).toHaveBeenCalledWith({ id, filename: 'clip.mp4' });
  expect(media.saveFile).not.toHaveBeenCalled();
  expect(progress.at(-1)).toBe(99);
  expect(Math.max(...progress.map(Number))).toBeLessThan(100);
});

test('audio saves through the same staged file picker, not the photo gallery', async () => {
  media.stageFile.mockResolvedValue(undefined);
  media.saveStagedFile.mockResolvedValue({ cancelled: false });

  await expect(saveImageToDevice({ kind: 'audio', sourceUrl: 'https://example.test/song.mp3', filename: 'song',
    prefetchedBlob: new Blob([new Uint8Array(10)], { type: 'audio/mpeg' }) })).resolves.toBe('saved');
  expect(media.saveStagedFile).toHaveBeenCalledWith(expect.objectContaining({ filename: 'song.mp3' }));
  expect(media.saveImage).not.toHaveBeenCalled();
});

test('older native shells without staging fall back to saveFile', async () => {
  media.stageFile.mockRejectedValue(Object.assign(new Error('not implemented'), { code: 'UNIMPLEMENTED' }));
  media.saveFile.mockResolvedValue({ cancelled: false });

  await expect(saveImageToDevice(video(10))).resolves.toBe('saved');
  expect(media.saveFile).toHaveBeenCalledTimes(1);
  expect(media.saveStagedFile).not.toHaveBeenCalled();
});

test('a failed chunk discards the staged file and surfaces the error', async () => {
  media.stageFile.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk full'));

  await expect(saveImageToDevice(video(4 * 1024 * 1024))).rejects.toThrow('disk full');
  expect(media.discardStagedFile).toHaveBeenCalledTimes(1);
  expect(media.saveStagedFile).not.toHaveBeenCalled();
});
