export type NotificationAdmissionKind = 'completion' | 'subtask' | 'error' | 'question' | 'permission' | 'schedule' | 'assistant' | 'goal';
export type NotificationAdmissionTarget = { kind: 'session' | 'assistant' | 'schedule'; id: string };
export type NotificationAdmissionSource =
  | { type: 'session'; sessionID: string; directory: string; parentID: string | null; boundaryID: string }
  | { type: 'assistant'; assistantID: string; turnID: string; status: 'complete' | 'error'; publication: 'published' }
  | { type: 'schedule'; projectID: string; taskID: string; runID: string; trigger: 'scheduled'; resultOwner: 'unowned'; status: 'success' | 'error' };
export type NotificationAdmission = { v: 1; kind: NotificationAdmissionKind; eventID: string; target: NotificationAdmissionTarget; source: NotificationAdmissionSource };
export function notificationAdmission(input: unknown): NotificationAdmission | null;
export function createNotificationAdmission(kind: NotificationAdmissionKind, target: NotificationAdmissionTarget, source: NotificationAdmissionSource): NotificationAdmission | null;
