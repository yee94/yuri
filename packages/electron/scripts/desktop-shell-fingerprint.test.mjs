import { describe, expect, test } from 'vitest';
import { desktopFingerprintLockfile } from '../../../scripts/desktop-ota-assets.mjs';

const fixture = () => ({
  lockfileVersion: 1,
  workspaces: {
    '': { dependencies: { shared: '1' } },
    'packages/electron': { dependencies: { native: '1' } },
    'packages/ui': { dependencies: { virtual: '1', shared: '1' } },
  },
  packages: {
    native: ['native@1', '', { dependencies: { transitive: '1' } }, 'native-checksum'],
    transitive: ['transitive@1', '', {}, 'transitive-checksum'],
    shared: ['shared@1', '', {}, 'shared-checksum'],
    virtual: ['virtual@1', '', { dependencies: { core: '1' } }, 'virtual-checksum'],
    core: ['core@1', '', {}, 'core-checksum'],
  },
});
const encode = (lock) => JSON.stringify(lock, null, 2);

describe('desktop shell fingerprint lock ownership', () => {
  test('UI-only direct and transitive upgrades retain the native release fingerprint bytes', () => {
    const before = fixture(), after = fixture();
    after.workspaces['packages/ui'].dependencies.virtual = '2';
    after.packages.virtual = ['virtual@2', '', { dependencies: { core: '2' } }, 'new-virtual'];
    after.packages.core = ['core@2', '', {}, 'new-core'];
    expect(desktopFingerprintLockfile(encode(after), encode(before))).toBe(encode(before));
  });

  test.each(['native', 'transitive', 'shared'])('installer-owned %s changes still require a new fingerprint', (name) => {
    const before = fixture(), after = fixture();
    after.packages[name][3] = 'changed';
    expect(desktopFingerprintLockfile(encode(after), encode(before))).toBe(encode(after));
  });

  test('a newly shared UI dependency becomes installer-owned immediately', () => {
    const before = fixture(), after = fixture();
    after.packages.native[2].dependencies.virtual = '2';
    after.packages.virtual[0] = 'virtual@2';
    expect(desktopFingerprintLockfile(encode(after), encode(before))).toBe(encode(after));
  });

  test('unknown packages, malformed locks and lock format changes cannot inherit compatibility', () => {
    const before = fixture(), after = fixture();
    after.packages.unknown = ['unknown@1', '', {}, 'unknown'];
    expect(desktopFingerprintLockfile(encode(after), encode(before))).toBe(encode(after));
    after.lockfileVersion = 2;
    expect(desktopFingerprintLockfile(encode(after), encode(before))).toBe(encode(after));
    expect(() => desktopFingerprintLockfile('{broken', encode(before))).toThrow();
  });

  test('adding and removing UI-only packages retains compatibility', () => {
    const before = fixture(), after = fixture();
    after.packages.virtual[2].dependencies = { replacement: '1' };
    delete after.packages.core;
    after.packages.replacement = ['replacement@1', '', {}, 'new'];
    expect(desktopFingerprintLockfile(encode(after), encode(before))).toBe(encode(before));
  });

  test.each(['optionalDependencies', 'peerDependencies'])('shared %s are protected across aliases and nested resolutions', (kind) => {
    const before = fixture();
    before.packages.native[2][kind] = { 'core-alias': 'npm:core@1' };
    before.packages['native/core-alias'] = ['core@1', '', {}, 'alias-core'];
    const after = structuredClone(before);
    after.packages['native/core-alias'][3] = 'changed';
    expect(desktopFingerprintLockfile(encode(after), encode(before))).toBe(encode(after));
  });
});
