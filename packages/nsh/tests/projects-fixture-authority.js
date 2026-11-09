/** Exact synthetic authority shared only by Projects fixtures, never by the production Host. */
export function projectsFixtureAuthority(hostID) {
  const runtimeScope = { hostID, lease: 'projects-fixture-lease' };
  return {
    snapshot: () => ({ connections: [{ id: hostID, label: 'Projects fixture', url: 'https://fixture.invalid', authorizationID: 'projects-fixture-authorization', lastUsedAt: 0 }], selected: hostID, runtimeScope: { ...runtimeScope } }),
    accept(input) {
      const scope = input?.expectedHost;
      if (!scope || Object.keys(scope).length !== 2 || scope.hostID !== runtimeScope.hostID || scope.lease !== runtimeScope.lease) throw new Error('Missing exact Projects fixture lease');
    },
  };
}
