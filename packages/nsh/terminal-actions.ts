/** Structural projection of yuriConfig.YuriProjectAction; no browser configuration transport is imported. */
export type TerminalAction = { id: string; name: string; command: string; icon?: string | null; platforms?: ('macos' | 'linux' | 'windows')[];
  autoOpenUrl?: boolean; openUrl?: string; desktopOpenSshForward?: string };
/** Same newline/control normalization as ProjectActionsButton.runAction. Runs only after a user's explicit action. */
export function terminalActionInput(action: TerminalAction): string | null {
  if (!action.id || action.id.length > 128 || !action.name || action.name.length > 256 || !action.command.trim() || action.command.length > 16_000) return null;
  const normalized = action.command.trim().replace(/\r\n|\r/g, '\n');
  let result = '';
  for (let index = 0; index < normalized.length; index++) {
    const code = normalized.charCodeAt(index);
    if (!(code <= 8 || code === 11 || code === 12 || code >= 14 && code <= 31 || code === 127)) result += normalized[index];
  }
  return result ? `${result}\r` : null;
}
