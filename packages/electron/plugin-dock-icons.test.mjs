import { describe, expect, it, vi } from 'vitest';
import { createPluginDockIcons } from './plugin-dock-icons.mjs';

const png = (width = 24, height = 24) => {
  const buffer = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer); buffer.write('IHDR', 12); buffer.writeUInt32BE(width, 16); buffer.writeUInt32BE(height, 20);
  return `data:image/png;base64,${buffer.toString('base64')}`;
};
describe('plugin Dock resource ownership', () => {
  it('arbitrates windows and restores previous/default icons without file writes', () => {
    const apply = vi.fn(); let index = 0;
    const icons = createPluginDockIcons({ decode: () => ({ id: ++index, isEmpty: () => false }), apply });
    icons.set('a', png()); icons.set('b', png());
    expect(apply.mock.lastCall[0].id).toBe(2);
    icons.remove('b'); expect(apply.mock.lastCall[0].id).toBe(1);
    icons.remove('a'); expect(apply).toHaveBeenLastCalledWith(null);
    icons.remove('a'); expect(apply).toHaveBeenCalledTimes(4);
  });
  it('bounds images before decoding, rejects invalid pixels and retains the previous selection on failure', () => {
    const apply = vi.fn(); const decode = vi.fn(() => ({ isEmpty: () => false }));
    const icons = createPluginDockIcons({ decode, apply });
    icons.set('a', png());
    for (const invalid of [png(1025), png(0), 'file:///icon.png', 'data:image/svg+xml,<svg/>', 'data:image/png;base64,iVBORw0KGgo=']) expect(() => icons.set('b', invalid)).toThrow();
    expect(decode).toHaveBeenCalledTimes(1);
    decode.mockReturnValueOnce({ isEmpty: () => true });
    expect(() => icons.set('b', png())).toThrow();
    icons.remove('b'); expect(apply).toHaveBeenCalledTimes(1);
    icons.remove('a'); expect(apply).toHaveBeenLastCalledWith(null);
  });
});
