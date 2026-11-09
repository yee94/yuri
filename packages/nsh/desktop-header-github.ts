import { signal, untracked } from 'nsh';
import { createDesktopHeaderGitHubSource, type DesktopHeaderGitHubGuard } from './desktop-header-github-core';

/** Once per root captured Host/directory; injection into Settings is mandatory, never an implicit singleton. */
export function createNativeDesktopHeaderGitHubSource(options: Parameters<typeof createDesktopHeaderGitHubSource>[0]) {
  const revision = signal(0);
  const source = createDesktopHeaderGitHubSource({ ...options, changed: state => {
    untracked(() => revision.set(revision() + 1)); options.changed?.(state);
  } });
  return { ...source,
    state() { revision(); return source.state(); },
    header(guard: DesktopHeaderGitHubGuard) {
      const port = source.header(guard);
      return { ...port, state() { revision(); return port.state(); }, available() { revision(); return port.available(); }, visible() { revision(); return port.visible(); } };
    },
  };
}
