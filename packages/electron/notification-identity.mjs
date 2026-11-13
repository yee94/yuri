/** Different windows of the same physical instance share one notification claim. */
export function nativeNotificationIdentity(payload, ownerId = 'local') {
  const instance = typeof payload?.instanceId === 'string' ? payload.instanceId : '';
  const tag = typeof payload?.tag === 'string' ? payload.tag.trim() : '';
  const fallback = [payload?.sessionId, payload?.kind, payload?.title, payload?.body]
    .filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()).join('|');
  const event = instance && payload?.sessionId
    ? [payload.sessionId, payload.kind || tag || payload.title || 'notification'].join(':') : tag || fallback;
  return event ? `${instance || ownerId}:${event}` : '';
}
