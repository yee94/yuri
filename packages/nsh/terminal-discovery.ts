import type { TerminalAction } from './terminal-actions';
export const terminalAutoDiscoverID = '__yuri_auto_discover_preview__';
export type TerminalDiscoveryFile = 'package.json' | 'bun.lock' | 'bun.lockb' | 'pnpm-lock.yaml' | 'yarn.lock' | 'package-lock.json' | 'index.html';
/** Retains detectDevServer.ts precedence; I/O is injected native same-Host reads.
 * A read failure throws. Only an authoritative optional-file absence is null. */
export async function discoverTerminalAction(input: {
  directory: string; actions: readonly TerminalAction[]; name: string;
  read: (file: TerminalDiscoveryFile) => Promise<string | null>; freePort: () => Promise<number | null>;
}): Promise<TerminalAction | null> {
  const existing = input.actions.find(action => ['dev', 'start', 'preview', 'serve'].some(word => `${action.name} ${action.command}`.toLowerCase().includes(word)));
  if (existing) return { ...existing, id: terminalAutoDiscoverID, name: input.name, autoOpenUrl: true };
  const text = await input.read('package.json');
  let pkg: { scripts?: unknown; packageManager?: unknown } = {};
  if (text !== null) { const parsed: unknown = JSON.parse(text); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) pkg = parsed; }
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts) ? pkg.scripts as Record<string, unknown> : {};
  let script: string | undefined;
  for (const pattern of [/^dev(:.*)?$/i, /^start(:.*)?$/i, /^preview(:.*)?$/i, /^serve(:.*)?$/i, /^develop(:.*)?$/i]) {
    script = Object.keys(scripts).find(name => pattern.test(name)); if (script) break;
  }
  if (script) {
    let manager = typeof pkg.packageManager === 'string' ? /^(bun|pnpm|yarn|npm)@/i.exec(pkg.packageManager)?.[1].toLowerCase() : undefined;
    if (!manager) for (const [file, name] of [['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['package-lock.json', 'npm']] as const) {
      const content = await input.read(file); if (content?.trim()) { manager = name; break; }
    }
    const command = manager === 'bun' ? 'bun run --shell=bun' : manager === 'pnpm' ? 'pnpm' : manager === 'yarn' ? 'yarn' : 'npm run';
    return { id: terminalAutoDiscoverID, name: input.name, command: `${command} ${script}`, icon: 'search', autoOpenUrl: true };
  }
  const index = await input.read('index.html');
  if (!index?.trim()) return null;
  const port = await input.freePort();
  const resolved = port === null ? 8000 : port;
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > 65535) throw new Error('invalid_preview_port');
  return { id: terminalAutoDiscoverID, name: input.name, command: `python3 -m http.server ${resolved}`, icon: 'search', autoOpenUrl: true, openUrl: `http://127.0.0.1:${resolved}/` };
}
