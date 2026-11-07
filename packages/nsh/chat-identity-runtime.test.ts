import { expect, it, vi } from 'vitest';

vi.mock('@dicebear/core', () => { throw new Error('DiceBear must remain outside the native runtime dependency graph'); });
vi.mock('react', () => { throw new Error('React must remain outside the native runtime dependency graph'); });

it('the production native artwork helper runs with DiceBear and React unavailable', async () => {
  const { nativeAgentAvatarDataUri, nativeAgentPalette } = await import('./chat-identity-core');
  expect(nativeAgentPalette('build', { '--status-success': '#57965D' })).toEqual({ background: '#57965D' });
  const uri = nativeAgentAvatarDataUri('build', { '--status-success': '#57965D' });
  expect(uri).toMatch(/^data:image\/svg\+xml,/);
  expect(decodeURIComponent(uri!)).toContain('fill="#57965d"');
  const custom = nativeAgentAvatarDataUri('custom-agent', { '--status-success': '#57965D' });
  expect(custom).toMatch(/^data:image\/svg\+xml(?:;charset=utf-8)?,/);
  expect(custom).toBe(nativeAgentAvatarDataUri(' CUSTOM-AGENT ', { '--status-success': '#57965D' }));
  expect(custom).not.toBe(uri);
  expect(decodeURIComponent(custom!)).toContain('Pablo Stanley');
});
