import { expect, it, vi } from 'vitest';
import { generatedAvatarDataUri } from '../ui/src/lib/generatedAvatar';
import { getAgentColor } from '../ui/src/lib/agentColors';
import { agentAvatarThemeTokens, resolveAgentAvatarColors } from '../ui/src/lib/agentAvatarPalette';
import { themes } from '../ui/src/lib/theme/themes';
import { nativeAgentAvatarDataUri, nativeAgentPalette } from './chat-identity-core';
import { nativeAgentAvatarTemplates, nativeAgentPlateMarker } from './agent-avatar-templates';

const svg = (uri: string) => {
  const comma = uri.indexOf(',');
  return uri.slice(0, comma).includes(';base64') ? Buffer.from(uri.slice(comma + 1), 'base64').toString('utf8') : decodeURIComponent(uri.slice(comma + 1));
};
it('native Agent templates exactly match Web seed/style/palette artwork across the real theme catalog, including JetBrains', () => {
  for (const theme of themes) {
    const tokens = agentAvatarThemeTokens(theme.colors);
    for (const name of Object.keys(nativeAgentAvatarTemplates)) {
      const palette = resolveAgentAvatarColors(getAgentColor(name).var, key => tokens[key] ?? '');
      expect(nativeAgentPalette(name, tokens)).toEqual(palette);
      const original = generatedAvatarDataUri('agent', name, false, palette);
      const native = nativeAgentAvatarDataUri(name, tokens)!;
      expect(svg(native), `${theme.metadata.id}/${name}`).toBe(svg(original));
      expect(svg(native)).toContain('Pablo Stanley');
      expect(svg(native)).toContain('Free for personal and commercial use');
      expect(svg(native)).not.toContain(nativeAgentPlateMarker);
    }
  }
});

it('all four face geometries and attribution remain identical when only the plate color changes', () => {
  for (const name of Object.keys(nativeAgentAvatarTemplates)) {
    const token = getAgentColor(name).var;
    const first = svg(nativeAgentAvatarDataUri(name, { [token]: '#123456' })!);
    const second = svg(nativeAgentAvatarDataUri(name, { [token]: '#abcdef' })!);
    expect(first.replace('#123456', nativeAgentPlateMarker)).toBe(nativeAgentAvatarTemplates[name as keyof typeof nativeAgentAvatarTemplates]);
    expect(first.replace('#123456', '#abcdef')).toBe(second);
  }
});

it('normalizes the same known seed, caches 200 repeated reads and renders exact custom/session identities', () => {
  const encode = vi.spyOn(globalThis, 'encodeURIComponent');
  try {
    const first = nativeAgentAvatarDataUri(' Build ', { '--status-success': '#102039' });
    expect(encode).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 200; index++) expect(nativeAgentAvatarDataUri('build', { '--status-success': '#102039' })).toBe(first);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(nativeAgentAvatarDataUri('build', { '--status-success': '#aabbcc' })).not.toBe(first);
    expect(encode).toHaveBeenCalledTimes(2);
  } finally { encode.mockRestore(); }
  for (const name of [undefined, '', 'custom-agent', '__proto__', 'constructor', ...Array.from({ length: 200 }, (_, index) => `child-${index}`)]) {
    const palette = nativeAgentPalette(name, {});
    expect(svg(nativeAgentAvatarDataUri(name, {})!)).toBe(svg(generatedAvatarDataUri('agent', name, false, palette)));
  }
  expect(nativeAgentAvatarDataUri('child-1', {})).not.toBe(nativeAgentAvatarDataUri('child-2', {}));
});
it('native arbitrary-seed generation never reads or installs a global clone', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'structuredClone');
  try {
    Object.defineProperty(globalThis, 'structuredClone', { configurable: true,
      get: () => { throw new Error('Native artwork must not read the global clone'); },
      set: () => { throw new Error('Native artwork must not install a global clone'); },
    });
    expect(nativeAgentAvatarDataUri('quickjs-child-fixture', {})).toContain('data:image/svg+xml');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'structuredClone', descriptor);
    else Reflect.deleteProperty(globalThis, 'structuredClone');
  }
});

it('arbitrary identities reuse 200 input-adjacent reads and the shared count budget evicts rather than retaining without bound', () => {
  const encode = vi.spyOn(globalThis, 'encodeURIComponent');
  try {
    const first = nativeAgentAvatarDataUri('native-cache-contract', {});
    expect(encode).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 200; index++) expect(nativeAgentAvatarDataUri(' NATIVE-CACHE-CONTRACT ', {})).toBe(first);
    expect(encode).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 128; index++) nativeAgentAvatarDataUri(`native-budget-${index}`, {});
    encode.mockClear();
    expect(nativeAgentAvatarDataUri('native-cache-contract', {})).toBe(first);
    expect(encode).toHaveBeenCalledTimes(1);
    const oversizedKey = 'oversized-native-seed-' + 'x'.repeat(600_000);
    expect(() => nativeAgentAvatarDataUri(oversizedKey, {})).toThrow(/seed is too long/);
    expect(() => generatedAvatarDataUri('agent', oversizedKey)).toThrow(/seed is too long/);
    expect(encode).toHaveBeenCalledTimes(1);
  } finally { encode.mockRestore(); }
});

it('accepts only controlled colors in SVG templates and uses the exact shared no-theme fallback', () => {
  for (const name of ['build', 'custom-agent', '__proto__', 'constructor']) {
    for (const color of ['url(https://invalid.example)', '#123456\n', '<script>', 'red', '#abcde']) expect(nativeAgentAvatarDataUri(name, { [getAgentColor(name).var]: color })).toBeUndefined();
  }
  expect(nativeAgentPalette('build', {})).toEqual(resolveAgentAvatarColors('--status-success', () => ''));
  expect(svg(nativeAgentAvatarDataUri('build', { '--status-success': '#AbC' })!)).toContain('fill="#aabbcc"');
});
