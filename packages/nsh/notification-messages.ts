/** Key manifest only. All text lives in the canonical ten *.settings.ts dictionaries. */
export const notificationMessageKeys = [
  'status', 'notDetermined', 'denied', 'authorized', 'provisional', 'ephemeral', 'unknown',
  'request', 'openSettings', 'scheduled', 'backgroundGap', 'alertDisabled', 'policy', 'readFailed', 'saveUnconfirmed', 'syncPending',
].map(key => `settings.notifications.native.${key}`);
