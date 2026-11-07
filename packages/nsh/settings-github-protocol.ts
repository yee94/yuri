/** Import-free Host wire contract. Never retain arbitrary response/error fields. */
export type GitSettingsRequest = (path: string, method?: string, body?: unknown) => Promise<unknown>;
export type GitHubUser = { login: string; name?: string; email?: string; avatarUrl?: string };
export type GitHubAccount = { id: string; source: 'oauth' | 'gh-cli'; current: boolean; user: GitHubUser; scope?: string };
export type GitHubStatus = { connected: boolean; user?: GitHubUser; scope?: string; accounts: GitHubAccount[]; capabilities?: { exactAccountRemoval: boolean; deviceFlowCancellation: boolean }; ghCli?: { available: boolean; disabled: boolean; active: boolean; user?: GitHubUser } };
export type GitHubFlow = { deviceCode: string; userCode: string; url: string; expiresIn: number; interval: number; cancellable: boolean };
export type GitHubSelection = { source: 'oauth' | 'gh-cli'; accountId: string };
export const gitHubSelection = (account: GitHubAccount): GitHubSelection => ({ source: account.source, accountId: account.id });
export const gitHubCurrentSelection = (status: GitHubStatus): GitHubSelection | null => { const account = status.accounts.find(account => account.current); return account ? gitHubSelection(account) : null; };
export function gitObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Git settings response');
  return value as Record<string, unknown>;
}
export function gitString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid Git settings string');
  return value;
}
function user(value: unknown): GitHubUser {
  const row = gitObject(value);
  // Public GitHub avatar metadata only; never route arbitrary/token-bearing URLs to Image.
  const avatarUrl = typeof row.avatarUrl === 'string' && /^https:\/\/avatars\.githubusercontent\.com\/u\/\d+(?:\?(?:v|s)=\d+(?:&(?:v|s)=\d+)*)?$/.test(row.avatarUrl) ? row.avatarUrl : undefined;
  return { login: gitString(row.login), ...(typeof row.name === 'string' ? { name: row.name } : {}), ...(typeof row.email === 'string' ? { email: row.email } : {}), ...(avatarUrl ? { avatarUrl } : {}) };
}
export const gitHubAccountKey = (value: Pick<GitHubAccount, 'id' | 'source'>) => JSON.stringify([value.source, value.id]);
export function gitHubStatus(value: unknown): GitHubStatus {
  const row = gitObject(value);
  if (typeof row.connected !== 'boolean' || !Array.isArray(row.accounts)) throw new Error('Invalid GitHub status');
  const accounts = row.accounts.map(value => {
    const item = gitObject(value);
    if (item.source !== undefined && item.source !== 'oauth' && item.source !== 'gh-cli' || item.current !== undefined && typeof item.current !== 'boolean') throw new Error('Invalid GitHub account');
    return { id: gitString(item.id), source: item.source ?? 'oauth', current: item.current === true, user: user(item.user), ...(typeof item.scope === 'string' ? { scope: item.scope } : {}) } as GitHubAccount;
  });
  if (new Set(accounts.map(gitHubAccountKey)).size !== accounts.length || accounts.filter(account => account.current).length > 1) throw new Error('Ambiguous GitHub accounts');
  let ghCli: GitHubStatus['ghCli'];
  if (row.ghCli != null) {
    const cli = gitObject(row.ghCli);
    if (typeof cli.available !== 'boolean' || typeof cli.disabled !== 'boolean' || typeof cli.active !== 'boolean') throw new Error('Invalid GitHub CLI status');
    ghCli = { available: cli.available, disabled: cli.disabled, active: cli.active, ...(cli.user != null ? { user: user(cli.user) } : {}) };
  }
  let capabilities: GitHubStatus['capabilities'];
  if (row.capabilities !== undefined) { const value = gitObject(row.capabilities); if (typeof value.exactAccountRemoval !== 'boolean' || typeof value.deviceFlowCancellation !== 'boolean') throw new Error('Invalid GitHub capabilities'); capabilities = { exactAccountRemoval: value.exactAccountRemoval, deviceFlowCancellation: value.deviceFlowCancellation }; }
  return { connected: row.connected, accounts, ...(row.user != null ? { user: user(row.user) } : {}), ...(typeof row.scope === 'string' ? { scope: row.scope } : {}), ...(ghCli ? { ghCli } : {}), ...(capabilities ? { capabilities } : {}) };
}
export function gitHubFlow(value: unknown): GitHubFlow {
  const row = gitObject(value);
  // Open the non-complete URI only: codes and tokens never become URL parameters.
  const url = gitString(row.verificationUri);
  if (!/^https:\/\/github\.com\/login\/device\/?$/.test(url)) throw new Error('Unsafe GitHub verification URL');
  if (typeof row.expiresIn !== 'number' || !Number.isFinite(row.expiresIn) || row.expiresIn <= 0 || row.expiresIn > 1800 || typeof row.interval !== 'number' || !Number.isFinite(row.interval) || row.interval <= 0 || row.interval > 300) throw new Error('Invalid GitHub flow timing');
  return { deviceCode: gitString(row.deviceCode), userCode: gitString(row.userCode), url, expiresIn: row.expiresIn, interval: Math.max(1, row.interval), cancellable: row.cancellable === true };
}
export function gitHubComplete(value: unknown): 'connected' | 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied' {
  const row = gitObject(value);
  if (row.connected === true) { user(row.user); return 'connected'; }
  if (row.connected !== false || !['authorization_pending', 'slow_down', 'expired_token', 'access_denied'].includes(String(row.status))) throw new Error('Invalid GitHub completion');
  return row.status as 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied';
}
export function gitSettingsResponse(value: unknown): unknown {
  const response = gitObject(value);
  if (typeof response.status !== 'number' || response.status < 200 || response.status >= 300) {
    const body = response.body && typeof response.body === 'object' ? response.body as Record<string, unknown> : {};
    const rejection = { github_account_changed: 409, github_account_not_found: 404, github_invalid_selection: 400, github_cli_managed_externally: 400, github_auth_busy: 409 };
    const code = typeof body.code === 'string' && Object.hasOwn(rejection, body.code) && rejection[body.code as keyof typeof rejection] === response.status ? body.code : undefined;
    throw Object.assign(new Error('Git settings request failed'), { ...(code ? { code, status: response.status } : {}) });
  }
  return response.body;
}
export function gitHubRemovalRejected(value: unknown): boolean {
  return value instanceof Error && Object.hasOwn(value, 'code') && ['github_account_changed', 'github_account_not_found', 'github_invalid_selection', 'github_cli_managed_externally', 'github_auth_busy'].includes(String((value as Error & { code: string }).code));
}
