import { contextUsageFixtureSnapshot } from '../context-usage-fixture-data';
/** Strict, read-only canonical snapshot provider. No network, credentials or model writes. */
export function createHost() {
  return { call(name: string, input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('Invalid context fixture input');
    if (name === 'contextUsage.fixture.snapshot') return contextUsageFixtureSnapshot();
    if (name === 'contextUsage.fixture.empty') return { ...contextUsageFixtureSnapshot(), messages: [] };
    throw new Error('Unexpected context fixture call: ' + name);
  } };
}
