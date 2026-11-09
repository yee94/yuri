import { resourcePath } from './resources-model';

type DirectoryRead = (path: string) => Promise<unknown>;
function listing(value: unknown): { path: string; entries: unknown[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('new-session-directory-unavailable');
  const row = value as Record<string, unknown>;
  if (row.ok === false || row.success === false || row.failed === true || row.partial === true || row.complete === false
    || typeof row.path !== 'string' || !row.path || row.path.trim() !== row.path || !Array.isArray(row.entries)) throw new Error('new-session-directory-unavailable');
  resourcePath(row.path);
  return { path: row.path, entries: row.entries };
}

/** Resolve only an explicitly selected directory, before any draft construction.
 * Return the Host's exact canonical bytes, not a locally normalized grant target. */
export async function resolveNewSessionWriterDirectory(options: { directory: string; read: DirectoryRead; current(): boolean }): Promise<string> {
  const { directory, read } = options;
  const assertCurrent = () => { if (!options.current()) throw new Error('new-session-directory-stale'); };
  assertCurrent();
  if (typeof directory !== 'string' || !directory || directory.trim() !== directory) throw new Error('new-session-directory-required');
  resourcePath(directory);
  const observed = listing(await read(`/api/fs/list?path=${encodeURIComponent(directory)}`));
  assertCurrent();
  const canonical = resourcePath(observed.path);
  // fs/routes.js deliberately returns an empty listing for a missing plans
  // directory. It is not proof that there is a directory to acquire/edit.
  if (canonical.endsWith('/.opencode/plans')) {
    const parent = canonical.slice(0, canonical.lastIndexOf('/'));
    const proof = listing(await read(`/api/fs/list?path=${encodeURIComponent(parent)}`));
    assertCurrent();
    if (resourcePath(proof.path) !== parent) throw new Error('new-session-directory-mismatch');
    const matches = proof.entries.filter(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('new-session-directory-unavailable');
      const row = entry as Record<string, unknown>;
      if (typeof row.path !== 'string' || typeof row.isDirectory !== 'boolean') throw new Error('new-session-directory-unavailable');
      return resourcePath(row.path) === canonical;
    }) as Array<{ isDirectory: boolean }>;
    if (matches.length !== 1 || !matches[0].isDirectory) throw new Error('new-session-directory-not-found');
  }
  assertCurrent();
  return observed.path;
}
