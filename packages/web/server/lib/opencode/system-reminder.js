// Mirrors packages/ui/src/lib/systemReminder.ts: injected context travels inside
// the user prompt text, and every reader of authored text removes it.
const SYSTEM_REMINDER_OPEN = '<system-reminder>';
const SYSTEM_REMINDER_BLOCK = /[ \t]*<system-reminder>[\s\S]*?<\/system-reminder>[ \t]*/g;
const SYSTEM_REMINDER_UNCLOSED = /[ \t]*<system-reminder>[\s\S]*$/;

export const stripSystemReminders = (text) => {
  if (typeof text !== 'string' || !text.includes(SYSTEM_REMINDER_OPEN)) return text;
  return text.replace(SYSTEM_REMINDER_BLOCK, '').replace(SYSTEM_REMINDER_UNCLOSED, '').trim();
};
