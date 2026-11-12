import type { FilesAPI } from './types';
import type { HostRuntimeEntry } from '@/lib/remote-projects/registry';
import { captureProjectScope } from './project-scope';
import { directFileResource, readRuntimeFile, readRuntimeFileBlob } from '@/lib/runtime-file-resource';
import { toAbsoluteFilePath } from '@/lib/path-utils';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';

type FileReadOptions = NonNullable<Parameters<NonNullable<FilesAPI['readFile']>>[1]>;

/** Host-scoped filesystem adapter. No native Hub filesystem/IDE fallback is exposed. */
export const createProjectFilesAPI = (entry: HostRuntimeEntry): FilesAPI => {
  const scope = captureProjectScope(entry);
  const headers = { 'x-opencode-directory': entry.location.directory };
  const readOptions = (path: string, options?: FileReadOptions) => ({
    query: { path, ...(options?.fingerprint ? { fingerprint: 'true' } : {}),
      ...(options?.allowOutsideWorkspace ? { allowOutsideWorkspace: 'true' } : {}),
      ...(options?.outsideFileGrant ? { outsideFileGrant: options.outsideFileGrant } : {}) },
    headers: { 'x-opencode-directory': options?.directory ?? entry.location.directory },
  });
  const write = <T>(route: string, body: unknown) => scope.json<T>(`/api/fs/${route}`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return {
    listDirectory: (path, options) => scope.json('/api/fs/list', {
      headers, query: { path, ...(options?.respectGitignore === undefined ? {} : { respectGitignore: String(options.respectGitignore) }) },
    }),
    async search(payload, options) {
      scope.assertCurrent(options?.signal);
      const response = await entry.sdk().file.find({
        query: payload.query, location: { directory: payload.directory }, limit: payload.maxResults, type: 'file',
      }, { signal: options?.signal });
      scope.assertCurrent(options?.signal);
      if (!Array.isArray(response.data)) throw new Error('File search returned no data');
      return response.data.map((file) => ({ path: toAbsoluteFilePath(payload.directory, file.path), preview: [file.path] }));
    },
    createDirectory: (path) => write('mkdir', { path }),
    statFile: (path, options) => scope.json('/api/fs/stat', readOptions(path, options)),
    async readFile(path, options) {
      const response = options?.optional
        ? await scope.fetch('/api/fs/read', { ...readOptions(path, options), query: { ...readOptions(path, options).query, optional: 'true' }, cache: 'no-store' })
        : await readRuntimeFile({ ...options, path, scope: entry });
      if (!response.ok) throw new Error(`File read failed (${response.status})`);
      const content = await response.text();
      scope.assertCurrent();
      const exists = options?.optional ? response.headers.get('x-yuri-file-exists') : 'true';
      if (exists !== 'true' && exists !== 'false') throw new Error('Optional file read requires an existence response header');
      return { path, content, exists: exists === 'true' };
    },
    writeFile: (path, content) => write('write', { path, content }),
    delete: (path) => write('delete', { path }),
    rename: (oldPath, newPath) => write('rename', { oldPath, newPath }),
    async downloadFile(path) {
      scope.assertCurrent();
      let url: string;
      const relay = isRelayModeActive();
      if (relay) url = URL.createObjectURL(await readRuntimeFileBlob({ path, scope: entry }));
      else {
        await refreshRuntimeUrlAuthToken();
        scope.assertCurrent();
        url = directFileResource('/api/fs/raw', { path, directory: entry.location.directory, download: 'true' }, entry).url;
      }
      try {
        scope.assertCurrent();
        const anchor = document.createElement('a');
        anchor.href = url; anchor.download = path.split(/[\\/]/).pop() || 'file';
        document.body.append(anchor); anchor.click(); anchor.remove();
      } finally { if (relay) setTimeout(() => URL.revokeObjectURL(url), 1000); }
    },
  };
};
