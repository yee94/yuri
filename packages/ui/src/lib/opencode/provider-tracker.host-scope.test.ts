import { expect, test, vi } from 'vitest';
import { assertProviderCircuitClosed, recordProviderError, recordProviderSuccess, shouldRetry } from './provider-tracker';

test('one Remote Host provider outage does not block identical providers on siblings or local', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    for (let i = 0; i < 3; i += 1) recordProviderError('host-isolation-provider', 503, 'hub-a/host-a');
    expect(() => assertProviderCircuitClosed('host-isolation-provider', 'hub-a/host-a')).toThrow();
    expect(() => assertProviderCircuitClosed('host-isolation-provider', 'hub-a/host-b')).not.toThrow();
    expect(() => assertProviderCircuitClosed('host-isolation-provider', 'hub-b/host-a')).not.toThrow();
    expect(() => assertProviderCircuitClosed('host-isolation-provider')).not.toThrow();
    expect(shouldRetry('host-isolation-provider', 503, 0, 'hub-a/host-a')).toBe(false);
    expect(shouldRetry('host-isolation-provider', 503, 0, 'hub-a/host-b')).toBe(true);
    recordProviderSuccess('host-isolation-provider', 'hub-a/host-b');
    expect(() => assertProviderCircuitClosed('host-isolation-provider', 'hub-a/host-a')).toThrow();
  } finally { warn.mockRestore(); }
});
