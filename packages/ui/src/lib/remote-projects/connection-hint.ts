import type { I18nKey } from '@/lib/i18n';
import type { RemoteHost } from './types';

/** Presentation only: no timers, transport demand or locally inferred upgrade state. */
export function remoteConnectionHint(host: RemoteHost | undefined): { key: I18nKey; pending: boolean } | null {
  if (host?.state === 'connected') return null;
  if (!host || host.state === 'connecting') {
    const phase = host?.preparationPhase;
    return { key: phase && phase !== 'connecting' ? `remoteProjects.preparation.${phase}` : 'remoteProjects.state.connecting', pending: true };
  }
  return { key: `remoteProjects.state.${host.state}`, pending: false };
}
