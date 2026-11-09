/** Synthetic forwarding oracle only. This does not implement Native authority,
 * authorization, credentials, transport or a production lease issuer. */
export function createSettingsFixtureScope(hostID) {
  let selected = hostID, revision = 1, lists = 0, admitted = 0, rejected = 0;
  const entries = [hostID, `${hostID}-other`].map((id, index) => ({ id, label: `Synthetic ${index ? 'B' : 'A'}`, url: `https://settings-${index ? 'b' : 'a'}.invalid`, authorizationID: `synthetic-auth-${index ? 'B' : 'A'}`, transportID: index ? 'synthetic-transport-B' : 'synthetic-transport-A', lastUsedAt: 0 }));
  const scope = () => ({ hostID: selected, lease: `synthetic-settings-lease-${revision}` });
  const keys = (value, expected) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) throw new Error('Invalid synthetic scope payload');
  };
  return {
    snapshot(input) { keys(input, []); lists++; return { connections: entries.map(entry => ({ ...entry })), selected, runtimeScope: scope() }; },
    control(input) {
      keys(input, ['mode']);
      if (!['renew', 'other', 'return'].includes(input.mode)) throw new Error('Invalid synthetic scope transition');
      if (input.mode !== 'renew') selected = input.mode === 'other' ? `${hostID}-other` : hostID;
      revision++; return true;
    },
    admit(input) {
      try {
        keys(input, ['path', 'method', 'expectedHost', ...(input.body === undefined ? [] : ['body'])]);
        keys(input.expectedHost, ['hostID', 'lease']);
        const expected = scope();
        if (input.expectedHost.hostID !== expected.hostID || input.expectedHost.lease !== expected.lease) throw new Error('Stale synthetic scope forwarding');
        admitted++;
      } catch (error) { rejected++; throw error; }
    },
    audit() { return { lists, admitted, rejected, selected, runtimeScope: scope() }; },
  };
}
