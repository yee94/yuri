/** Synthetic identities for isolated fixture bridges, never production credentials. */
export function changesFixtureConnection(hostID, lease) {
  return { selected: hostID, runtimeScope: { hostID, lease }, connections: [{ id: hostID, label: 'Changes fixture Host', url: 'https://host.example', lastUsedAt: 1 }] };
}

export function verifyChangesFixtureScope(input, scope) {
  if (!input || typeof input.path !== 'string' || typeof input.method !== 'string') throw new Error('Invalid Changes fixture request');
  if (input.expectedHost?.hostID !== scope.hostID || input.expectedHost?.lease !== scope.lease) throw new Error('Missing or stale Changes fixture scope');
}
