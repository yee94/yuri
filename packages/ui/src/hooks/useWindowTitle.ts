import React from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { isDesktopLocalOriginActive, isDesktopShell } from '@/lib/desktop';
import { desktopHostsGet, getDesktopHostApiUrl, locationMatchesHost, redactSensitiveUrl } from '@/lib/desktopHosts';
import { setDesktopWindowTitle } from '@/lib/desktopNative';
import { getRuntimeApiBaseUrl, getRuntimeKey, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useI18n } from '@/lib/i18n';

const APP_TITLE = 'Yuri';

const getWindowRuntimeIdentity = () => `${getRuntimeKey()}\0${getRuntimeTransportIdentity()}`;

const windowHostsOptions = (identity: string) => queryOptions({
  queryKey: ['desktop-window-hosts', identity],
  queryFn: async ({ signal }) => {
    const config = await desktopHostsGet();
    signal.throwIfAborted();
    return config.hosts;
  },
});

const getProjectNameFromPath = (path: string): string => {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? '';
};

const buildWindowTitle = (projectLabel: string | null, instanceLabel: string | null): string => {
  const parts = [projectLabel, instanceLabel, APP_TITLE].filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
  return parts.join(' | ');
};

export const useWindowTitle = () => {
  const { t } = useI18n();
  const projectLabel = useProjectsStore((state) => {
    if (!state.activeProjectId) {
      return null;
    }
    const project = state.projects.find((entry) => entry.id === state.activeProjectId);
    return project ? getProjectNameFromPath(project.path) || null : null;
  });

  const identity = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getWindowRuntimeIdentity, getWindowRuntimeIdentity);
  const remote = isDesktopShell() && !isDesktopLocalOriginActive();
  const { data: hosts } = useQuery({ ...windowHostsOptions(identity), enabled: remote });
  const runtimeKey = getRuntimeKey();
  const hostId = runtimeKey.startsWith('host:') ? runtimeKey.slice(5) : null;
  const apiUrl = getRuntimeApiBaseUrl();
  const host = hosts?.find(entry => hostId ? entry.id === hostId : Boolean(apiUrl && locationMatchesHost(apiUrl, getDesktopHostApiUrl(entry))));
  const instanceLabel = remote ? (host?.label?.trim() ? redactSensitiveUrl(host.label.trim()) : t('desktopHostSwitcher.title')) : null;

  const title = React.useMemo(() => buildWindowTitle(projectLabel, instanceLabel), [projectLabel, instanceLabel]);

  React.useEffect(() => {
    if (typeof document !== 'undefined') {
      document.title = title;
    }

    if (!isDesktopShell()) {
      return;
    }

    const applyTitle = async () => {
      try {
        await setDesktopWindowTitle(title);
      } catch {
        return;
      }
    };

    void applyTitle();
  }, [title]);
};
