/** Dedicated synthetic bridges; never infer authority from the requested URL. */
export function interactionConnection(hostID, lease) {
  return { selected: hostID, runtimeScope: { hostID, lease }, connections: [{ id: hostID, authorizationID: 'synthetic-interaction-authorization', label: 'Synthetic interaction Host', url: 'https://host.example', lastUsedAt: 0 }] };
}

export function requireInteractionScope(input, scope) {
  if (!input || typeof input.path !== 'string' || input.expectedHost?.hostID !== scope.hostID || input.expectedHost?.lease !== scope.lease) throw new Error('Synthetic interaction Host rejected request scope');
}
