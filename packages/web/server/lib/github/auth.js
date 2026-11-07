import fs from 'fs';
import path from 'path';
import os from 'os';

const YURI_DATA_DIR = process.env.YURI_DATA_DIR
  ? path.resolve(process.env.YURI_DATA_DIR)
  : path.join(os.homedir(), '.config', 'yuri');

const STORAGE_DIR = YURI_DATA_DIR;
const STORAGE_FILE = path.join(STORAGE_DIR, 'github-auth.json');
const SETTINGS_FILE = path.join(YURI_DATA_DIR, 'settings.json');
const AUTH_WRITE_LOCK = path.join(YURI_DATA_DIR, '.github-auth.lock');

const DEFAULT_GITHUB_SCOPES = 'repo read:org workflow read:user user:email';
export const GH_CLI_ACCOUNT_ID = 'gh-cli';

function ensureStorageDir() {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

function authFailure(code, status = 500) {
  return Object.assign(new Error(code), { code, status });
}

// All auth/selection writers cooperate on this short, synchronous admission lock.
// Fail closed on contention, including a crash-left lock; never guess and steal it.
function withAuthWrite(work) {
  ensureStorageDir();
  let fd;
  try { fd = fs.openSync(AUTH_WRITE_LOCK, 'wx', 0o600); }
  catch (error) { throw authFailure(error?.code === 'EEXIST' ? 'github_auth_busy' : 'github_auth_storage_failed', error?.code === 'EEXIST' ? 409 : 500); }
  let release = true;
  try { return work(); }
  catch (error) { if (error?.code === 'github_auth_storage_uncertain') release = false; throw error; }
  finally { fs.closeSync(fd); if (release) fs.unlinkSync(AUTH_WRITE_LOCK); }
}

function readJsonFile(strict = false) {
  ensureStorageDir();
  if (!fs.existsSync(STORAGE_FILE)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(STORAGE_FILE, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed && !strict) {
      return null;
    }
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') {
      if (strict) throw authFailure('github_auth_storage_failed');
      return null;
    }
    return parsed;
  } catch (error) {
    if (strict) throw authFailure('github_auth_storage_failed');
    console.error('Failed to read GitHub auth file:', error);
    return null;
  }
}

function writeJsonFile(payload) {
  ensureStorageDir();

  // Atomic write so multiple Yuri instances can safely share the same file.
  const tmpFile = `${STORAGE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
  try {
    fs.chmodSync(tmpFile, 0o600);
  } catch {
    // best-effort
  }

  fs.renameSync(tmpFile, STORAGE_FILE);
  try {
    fs.chmodSync(STORAGE_FILE, 0o600);
  } catch {
    // best-effort
  }
}

function resolveAccountId({ user, accessToken, accountId }) {
  if (typeof accountId === 'string' && accountId.trim()) {
    return accountId.trim();
  }
  if (user && typeof user.login === 'string' && user.login.trim()) {
    return user.login.trim();
  }
  if (user && typeof user.id === 'number') {
    return String(user.id);
  }
  if (typeof accessToken === 'string' && accessToken.trim()) {
    return `token:${accessToken.slice(0, 8)}`;
  }
  return '';
}

function normalizeAuthEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const accessToken = typeof entry.accessToken === 'string' ? entry.accessToken : '';
  if (!accessToken) return null;
  const user = entry.user && typeof entry.user === 'object'
    ? {
      login: typeof entry.user.login === 'string' ? entry.user.login : null,
      avatarUrl: typeof entry.user.avatarUrl === 'string' ? entry.user.avatarUrl : null,
      id: typeof entry.user.id === 'number' ? entry.user.id : null,
      name: typeof entry.user.name === 'string' ? entry.user.name : null,
      email: typeof entry.user.email === 'string' ? entry.user.email : null,
    }
    : null;

  const accountId = resolveAccountId({
    user,
    accessToken,
    accountId: typeof entry.accountId === 'string' ? entry.accountId : '',
  });

  return {
    accessToken,
    scope: typeof entry.scope === 'string' ? entry.scope : '',
    tokenType: typeof entry.tokenType === 'string' ? entry.tokenType : 'bearer',
    createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : null,
    user,
    current: Boolean(entry.current),
    accountId,
  };
}

function normalizeAuthList(raw) {
  const list = (Array.isArray(raw) ? raw : [raw])
    .map((entry) => normalizeAuthEntry(entry))
    .filter(Boolean);

  if (!list.length) {
    return { list: [], changed: false };
  }

  let changed = false;
  let currentFound = false;
  list.forEach((entry) => {
    if (entry.current && !currentFound) {
      currentFound = true;
    } else if (entry.current && currentFound) {
      entry.current = false;
      changed = true;
    }
  });

  if (!currentFound && list[0]) {
    list[0].current = true;
    changed = true;
  }

  list.forEach((entry) => {
    if (!entry.accountId) {
      entry.accountId = resolveAccountId(entry);
      changed = true;
    }
  });

  return { list, changed };
}

function readAuthState(strict = true) {
  const data = readJsonFile(strict);
  if (!data) {
    return { list: [], explicit: false, selection: null };
  }
  const explicit = !Array.isArray(data) && data.version === 2;
  if (explicit && !Array.isArray(data.accounts) || !Array.isArray(data) && Object.hasOwn(data, 'version') && !explicit) throw authFailure('github_auth_storage_failed');
  const entries = explicit ? data.accounts : Array.isArray(data) ? data : [data];
  const { list } = normalizeAuthList(entries);
  if (strict && (entries.length !== list.length || entries.filter(entry => entry.current).length > 1 || new Set(list.map(entry => entry.accountId)).size !== list.length)) throw authFailure('github_auth_storage_failed');
  let selection = null;
  if (explicit) {
    try { selection = data.selection === null ? null : exactSelection(data.selection); }
    catch { throw authFailure('github_auth_storage_failed'); }
    if (selection?.source === 'oauth' && !list.some(entry => entry.accountId === selection.accountId)) throw authFailure('github_auth_storage_failed');
    if (selection?.source === 'gh-cli' && selection.accountId !== GH_CLI_ACCOUNT_ID) throw authFailure('github_auth_storage_failed');
  }
  return { list, explicit, selection };
}

function currentSelection(state, settings) {
  if (state.explicit) return state.selection;
  if (settings.ghCliActive && !settings.ghCliDisabled) return { source: 'gh-cli', accountId: GH_CLI_ACCOUNT_ID };
  const oauth = state.list.find(entry => entry.current);
  return oauth ? { source: 'oauth', accountId: oauth.accountId } : null;
}

function readSettingsFile(strict = false) {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const value = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) { if (strict) throw authFailure('github_auth_storage_failed'); return {}; }
      return value;
    }
  } catch {
    if (strict) throw authFailure('github_auth_storage_failed');
    // ignore
  }
  return {};
}

function writeSettingsFile(settings) {
  ensureStorageDir();
  const tmpFile = `${SETTINGS_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(settings, null, 2), 'utf8');
  try {
    fs.chmodSync(tmpFile, 0o600);
  } catch {
    // best-effort
  }
  fs.renameSync(tmpFile, SETTINGS_FILE);
  try {
    fs.chmodSync(SETTINGS_FILE, 0o600);
  } catch {
    // best-effort
  }
}

function commitAuthAndSettings(list, settings, selection) {
  const previousAuth = readJsonFile(true), previousSettings = readSettingsFile(true);
  const hadSettings = fs.existsSync(SETTINGS_FILE);
  try {
    // Selection and accounts share one atomic auth-file replacement. Settings are only the legacy CLI mirror.
    writeJsonFile({ version: 2, accounts: list, selection });
    writeSettingsFile(settings);
  } catch {
    try {
      if (previousAuth === null) { if (fs.existsSync(STORAGE_FILE)) fs.unlinkSync(STORAGE_FILE); }
      else writeJsonFile(previousAuth);
      if (hadSettings) writeSettingsFile(previousSettings);
      else if (fs.existsSync(SETTINGS_FILE)) fs.unlinkSync(SETTINGS_FILE);
    } catch {
      throw authFailure('github_auth_storage_uncertain');
    }
    throw authFailure('github_auth_storage_failed');
  }
}

export function isGitHubAuthDisconnected() {
  if (fs.existsSync(AUTH_WRITE_LOCK)) throw authFailure('github_auth_busy', 409);
  const state = readAuthState();
  return state.explicit && state.selection === null;
}

export function getGitHubAuth() {
  if (isGitHubAuthDisconnected()) return null;
  const state = readAuthState(), list = state.list;
  if (state.explicit) return state.selection?.source === 'oauth' ? list.find(entry => entry.accountId === state.selection.accountId) ?? null : null;
  if (!list.length) {
    return null;
  }
  const current = list.find((entry) => entry.current) || list[0];
  if (!current?.accessToken) {
    return null;
  }
  return current;
}

/** A single captured selection for Octokit; never mix a later CLI preference with an earlier OAuth record. */
export function getGitHubAuthContext() {
  if (fs.existsSync(AUTH_WRITE_LOCK)) throw authFailure('github_auth_busy', 409);
  const state = readAuthState(), settings = readSettingsFile(true);
  const selection = currentSelection(state, settings);
  const auth = state.explicit ? selection?.source === 'oauth' ? state.list.find(entry => entry.accountId === selection.accountId) ?? null : null : state.list.find(entry => entry.current) ?? null;
  if (fs.existsSync(AUTH_WRITE_LOCK)) throw authFailure('github_auth_busy', 409);
  return { explicit: state.explicit, selection, auth, ghCliActive: !settings.ghCliDisabled && selection?.source === 'gh-cli', ghCliDisabled: Boolean(settings.ghCliDisabled) };
}

export function getGitHubAuthAccounts() {
  isGitHubAuthDisconnected();
  const state = readAuthState(), list = state.list;
  return list
    .filter((entry) => entry?.user && entry.accountId)
    .map((entry) => ({
      id: entry.accountId,
      user: entry.user,
      scope: entry.scope || '',
      current: state.explicit ? state.selection?.source === 'oauth' && state.selection.accountId === entry.accountId : Boolean(entry.current),
      source: 'oauth',
    }));
}

export function setGitHubAuth({ accessToken, scope, tokenType, user, accountId }) {
  if (!accessToken || typeof accessToken !== 'string') {
    throw new Error('accessToken is required');
  }
  const normalizedUser = user && typeof user === 'object'
    ? {
      login: typeof user.login === 'string' ? user.login : undefined,
      avatarUrl: typeof user.avatarUrl === 'string' ? user.avatarUrl : undefined,
      id: typeof user.id === 'number' ? user.id : undefined,
      name: typeof user.name === 'string' ? user.name : undefined,
      email: typeof user.email === 'string' ? user.email : undefined,
    }
    : undefined;

  const resolvedAccountId = resolveAccountId({
    user: normalizedUser,
    accountId,
  });
  if (!resolvedAccountId) throw authFailure('github_account_identity_required', 400);

  return withAuthWrite(() => {
    const list = readAuthState().list;
    const existingIndex = list.findIndex((entry) => entry.accountId === resolvedAccountId);
    const nextEntry = {
      accessToken,
      scope: typeof scope === 'string' ? scope : '',
      tokenType: typeof tokenType === 'string' ? tokenType : 'bearer',
      createdAt: Date.now(),
      user: normalizedUser || null,
      current: true,
      accountId: resolvedAccountId,
    };

    if (existingIndex >= 0) {
      list[existingIndex] = nextEntry;
    } else {
      list.push(nextEntry);
    }

    list.forEach((entry, index) => {
      entry.current = index === (existingIndex >= 0 ? existingIndex : list.length - 1);
    });
    const settings = readSettingsFile(true);
    commitAuthAndSettings(list, { ...settings, ghCliActive: false }, { source: 'oauth', accountId: resolvedAccountId });
    return nextEntry;
  });
}

export function activateGitHubAuth(accountId) {
  if (typeof accountId !== 'string' || !accountId.trim()) {
    return false;
  }
  return withAuthWrite(() => {
    const list = readAuthState().list;
    const index = list.findIndex((entry) => entry.accountId === accountId.trim());
    if (index === -1) {
      return false;
    }
    list.forEach((entry, idx) => {
      entry.current = idx === index;
    });
    const settings = readSettingsFile(true);
    commitAuthAndSettings(list, { ...settings, ghCliActive: false }, { source: 'oauth', accountId: list[index].accountId });
    return true;
  });
}

export function clearGitHubAuth() {
  try {
    return withAuthWrite(() => {
      const list = readAuthState().list;
      if (!list.length) {
        return true;
      }
      const remaining = list.filter((entry) => !entry.current);
      remaining.forEach((entry, index) => {
        entry.current = index === 0;
      });
      const settings = readSettingsFile(true);
      if (remaining.length) commitAuthAndSettings(remaining, settings, settings.ghCliActive && !settings.ghCliDisabled ? { source: 'gh-cli', accountId: GH_CLI_ACCOUNT_ID } : { source: 'oauth', accountId: remaining[0].accountId });
      else {
        // Body-less legacy DELETE retains its original implicit CLI fallback when no OAuth accounts remain.
        if (fs.existsSync(STORAGE_FILE)) fs.unlinkSync(STORAGE_FILE);
      }
      return true;
    });
  } catch (error) {
    console.error('Failed to clear GitHub auth file:', error);
    return false;
  }
}

function exactSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'accountId,source' || !['oauth', 'gh-cli'].includes(value.source) || typeof value.accountId !== 'string' || !value.accountId.trim()) throw authFailure('github_invalid_selection', 400);
  return { source: value.source, accountId: value.accountId };
}

/** Exact delete never activates a target, and never silently chooses a replacement. */
export function removeGitHubAuth(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(input, 'selection') || Object.keys(input).some(key => !['selection', 'expectedCurrent'].includes(key))) throw authFailure('github_invalid_selection', 400);
  const selection = exactSelection(input.selection);
  const expected = Object.hasOwn(input, 'expectedCurrent') ? input.expectedCurrent === null ? null : exactSelection(input.expectedCurrent) : undefined;
  if (selection.source !== 'oauth') throw authFailure('github_cli_managed_externally', 400);
  return withAuthWrite(() => {
    const state = readAuthState(), list = state.list, settings = readSettingsFile(true);
    const current = currentSelection(state, settings);
    if (expected !== undefined && (current?.source !== expected?.source || current?.accountId !== expected?.accountId)) throw authFailure('github_account_changed', 409);
    if (!list.some(entry => entry.accountId === selection.accountId)) throw authFailure('github_account_not_found', 404);
    const disconnect = current?.source === 'oauth' && current.accountId === selection.accountId;
    const remaining = list.filter(entry => entry.accountId !== selection.accountId);
    commitAuthAndSettings(remaining, disconnect ? { ...settings, ghCliActive: false } : settings, disconnect ? null : current);
    return { success: true, removed: true, selection, disconnected: disconnect };
  });
}

export function getGitHubClientId() {
  const raw = process.env.YURI_GITHUB_CLIENT_ID;
  const clientId = typeof raw === 'string' ? raw.trim() : '';
  if (clientId) return clientId;

  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      const stored = typeof parsed?.githubClientId === 'string' ? parsed.githubClientId.trim() : '';
      if (stored) return stored;
    }
  } catch {
    // ignore
  }

  return '';
}

export function getGitHubScopes() {
  const raw = process.env.YURI_GITHUB_SCOPES;
  const fromEnv = typeof raw === 'string' ? raw.trim() : '';
  if (fromEnv) return fromEnv;

  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      const stored = typeof parsed?.githubScopes === 'string' ? parsed.githubScopes.trim() : '';
      if (stored) return stored;
    }
  } catch {
    // ignore
  }

  return DEFAULT_GITHUB_SCOPES;
}

export const GITHUB_AUTH_FILE = STORAGE_FILE;

export function isGhCliDisabled() {
  return Boolean(readSettingsFile(true).ghCliDisabled);
}

export function setGhCliDisabled(disabled) {
  return withAuthWrite(() => {
    const settings = readSettingsFile(true);
    const state = readAuthState(), current = currentSelection(state, settings);
    settings.ghCliDisabled = Boolean(disabled);
    if (settings.ghCliDisabled) {
      settings.ghCliActive = false;
    }
    const selection = settings.ghCliDisabled && current?.source === 'gh-cli' ? null : current;
    commitAuthAndSettings(state.list, settings, selection);
  });
}

export function isGhCliActive() {
  if (isGitHubAuthDisconnected()) return false;
  const settings = readSettingsFile(true);
  const state = readAuthState();
  return !settings.ghCliDisabled && (state.explicit ? state.selection?.source === 'gh-cli' : Boolean(settings.ghCliActive));
}

export function setGhCliActive(active) {
  return withAuthWrite(() => {
    const settings = readSettingsFile(true);
    const state = readAuthState(), current = currentSelection(state, settings);
    settings.ghCliActive = Boolean(active) && !settings.ghCliDisabled;
    const selection = settings.ghCliActive ? { source: 'gh-cli', accountId: GH_CLI_ACCOUNT_ID } : current?.source === 'gh-cli' ? null : current;
    commitAuthAndSettings(state.list, settings, selection);
  });
}
