import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useEvent } from '@reactuses/core';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { refreshOpenCodeConfiguration } from '@/stores/useAgentsStore';
import { copyTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/url';
import type { ModelMetadata } from '@/types';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { opencodeClient } from '@/lib/opencode/client';
import { filterMethodsWithIndex } from './providerAvailability';
import { getRuntimeGeneration, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { providerConnectionQueryOptions } from './providerConnectionQueries';
import { providerSourceQueryOptions } from './providerSourceQueries';
import { createProviderOAuthFlow } from './providerOAuth';
import { consoleAccountConnected, findSignInIntegration, methodsForSignIn, signInIntegrationIdForOAuth } from './providerSignIn';
import { ProviderModelEditor } from './ProviderModelEditor';
import type { CustomProviderModelDraft } from './CustomProviderModelDialog';
import { QuotaCredentials } from './QuotaCredentials';
import { CustomProviderForm } from './CustomProviderForm';
import { ProviderAuthFields } from './ProviderAuthFields';
import { ProviderModelRow } from './ProviderModelRow';
import { ProviderChoices } from './ProviderChoices';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { SettingsGroup, SettingsRow } from '@/components/sections/shared/SettingsGroup';

type ProviderSettingsSectionProps = {
  itemId?: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  rows?: boolean;
  children: React.ReactNode;
};

const ProviderSettingsSection = ({
  itemId,
  label,
  description,
  action,
  rows = false,
  children,
}: ProviderSettingsSectionProps) => (
  <div data-settings-item={itemId}>
    <SettingsGroup
      className="yuri-settings-detail-group [&_[data-settings-action-header]]:flex-wrap [&_[data-settings-action-header]>div:first-child]:flex-none [&_[data-settings-action-header]>div:last-child]:max-w-full"
      label={label}
      actions={action}
      description={description}
    >
      {rows ? children : <div className="yuri-settings-group-row">{children}</div>}
    </SettingsGroup>
  </div>
);

const formatCompactNumber = (value: number) => new Intl.NumberFormat(getCurrentIntlLocale(), {
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
}).format(value);

const formatTokens = (value?: number | null) => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }
  if (value === 0) {
    return '0';
  }
  const formatted = formatCompactNumber(value);
  return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
};

const ADD_PROVIDER_ID = '__add_provider__';
const CUSTOM_PROVIDER_ID = '__custom_provider__';

interface AuthMethod {
  type?: string;
  name?: string;
  label?: string;
  description?: string;
  help?: string;
  method?: number;
  [key: string]: unknown;
}

const normalizeAuthType = (method: AuthMethod) => {
  const raw = typeof method.type === 'string' ? method.type : '';
  const label = `${method.name ?? ''} ${method.label ?? ''}`.toLowerCase();
  const merged = `${raw} ${label}`.toLowerCase();
  if (merged.includes('oauth')) return 'oauth';
  if (merged.includes('api')) return 'api';
  return raw.toLowerCase();
};

type IntegrationMethodLike = {
  id?: string;
  type?: string;
  label?: string;
  name?: string;
};

type IntegrationLike = {
  id?: string;
  name?: string;
  methods?: IntegrationMethodLike[];
  connections?: Array<{ type?: string; id?: string }>;
};

type ProviderLike = {
  id?: string;
  integrationID?: string;
  name?: string;
};

// eslint-disable-next-line react-refresh/only-export-components -- tests import these helpers
export const resolveIntegrationId = (
  providerId: string,
  providers: ProviderLike[],
  integrations: IntegrationLike[],
): string => {
  const provider = providers.find((entry) => entry.id === providerId);
  if (typeof provider?.integrationID === 'string' && provider.integrationID) {
    return provider.integrationID;
  }
  if (integrations.some((entry) => entry.id === providerId)) {
    return providerId;
  }
  return providerId;
};

// eslint-disable-next-line react-refresh/only-export-components -- tests import these helpers
export const buildAuthMethodsFromIntegrations = (
  providers: ProviderLike[],
  integrations: IntegrationLike[],
): { methodsByProvider: Record<string, AuthMethod[]>; integrationIdByProvider: Record<string, string> } => {
  const methodsByProvider: Record<string, AuthMethod[]> = {};
  const integrationIdByProvider: Record<string, string> = {};
  const integrationById = new Map(
    integrations
      .filter((entry): entry is IntegrationLike & { id: string } => typeof entry.id === 'string' && entry.id.length > 0)
      .map((entry) => [entry.id, entry]),
  );

  const assign = (providerId: string, integration: IntegrationLike) => {
    integrationIdByProvider[providerId] = integration.id ?? providerId;
    methodsByProvider[providerId] = (integration.methods ?? []).map((method) => ({
      type: method.type,
      id: method.id,
      name: method.label ?? method.name,
      label: method.label ?? method.name,
    }));
  };

  for (const provider of providers) {
    if (typeof provider.id !== 'string' || !provider.id) continue;
    const integrationId = resolveIntegrationId(provider.id, providers, integrations);
    const integration = integrationById.get(integrationId);
    if (integration) assign(provider.id, integration);
  }
  for (const integration of integrations) {
    if (typeof integration.id !== 'string' || !integration.id) continue;
    if (methodsByProvider[integration.id]) continue;
    assign(integration.id, integration);
  }

  return { methodsByProvider, integrationIdByProvider };
};

export const ProvidersPage: React.FC<{ initialConnectionId?: string }> = ({ initialConnectionId }) => {
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeGeneration, getRuntimeGeneration);
  const directory = useDirectoryStore((state) => state.currentDirectory);
  return <ProvidersPageContent key={`${generation}:${directory}:${initialConnectionId ?? ''}`} initialConnectionId={initialConnectionId} />;
};

const ProvidersPageContent: React.FC<{ initialConnectionId?: string }> = ({ initialConnectionId }) => {
  const { t } = useI18n();
  const providers = useConfigStore((state) => state.providers);
  const selectedProviderId = useConfigStore((state) => state.selectedProviderId);
  const setSelectedProvider = useConfigStore((state) => state.setSelectedProvider);
  const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
  const hiddenModels = useUIStore((state) => state.hiddenModels);
  const toggleHiddenModel = useUIStore((state) => state.toggleHiddenModel);
  const showAllModels = useUIStore((state) => state.showAllModels);
  const hideAllModels = useUIStore((state) => state.hideAllModels);

  const connectionQuery = useQuery(providerConnectionQueryOptions());
  const sourceQuery = useQuery(providerSourceQueryOptions());
  const { methodsByProvider: authMethodsByProvider, integrationIdByProvider } = React.useMemo(() =>
    buildAuthMethodsFromIntegrations(connectionQuery.data?.providers ?? [], connectionQuery.data?.integrations ?? []),
  [connectionQuery.data]);
  const authLoading = connectionQuery.isPending;
  React.useEffect(() => {
    if (connectionQuery.isError) toast.error(t('settings.providers.page.toast.authMethodsLoadFailed'));
  }, [connectionQuery.isError, t]);
  const [apiKeyInputs, setApiKeyInputs] = React.useState<Record<string, string>>({});
  const [authBusyKey, setAuthBusyKey] = React.useState<string | null>(null);
  const [modelQuery, setModelQuery] = React.useState('');
  const [editingModel, setEditingModel] = React.useState<{ providerId: string; model: CustomProviderModelDraft; inputModalities: readonly string[] } | null>(null);
  const [removedModel, setRemovedModel] = React.useState<{ providerId: string; modelId: string } | null>(null);
  const [showProviderChoices, setShowProviderChoices] = React.useState(!initialConnectionId && selectedProviderId === ADD_PROVIDER_ID);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [pendingOAuth, setPendingOAuth] = React.useState<{ providerId: string; methodIndex: number; methodID: string; attemptID: string; mode: 'auto' | 'code' } | null>(null);
  const [oauthCodes, setOauthCodes] = React.useState<Record<string, string>>({});
  const [oauthDetails, setOauthDetails] = React.useState<Record<string, { url?: string; instructions?: string; userCode?: string; mode: 'auto' | 'code' }>>({});
  const availableLoading = connectionQuery.isPending;
  const availableError = connectionQuery.isError ? t('settings.providers.page.state.unableToLoadProviderList') : null;
  const [candidateProviderId, setCandidateProviderId] = React.useState(initialConnectionId ?? CUSTOM_PROVIDER_ID);
  const [providerSearchQuery, setProviderSearchQuery] = React.useState('');
  const [showAuthPanel, setShowAuthPanel] = React.useState(false);
  const isAddMode = selectedProviderId === ADD_PROVIDER_ID || selectedProviderId === CUSTOM_PROVIDER_ID;
  const mutationLifetime = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    const controller = new AbortController();
    mutationLifetime.current = controller;
    return () => controller.abort();
  }, []);
  const captureMutationScope = useEvent(() => {
    const controller = mutationLifetime.current;
    if (!controller || controller.signal.aborted) return null;
    const directory = opencodeClient.getDirectory();
    const generation = getRuntimeGeneration();
    return {
      directory,
      location: directory ? { directory } : undefined,
      transportIdentity: getRuntimeTransportIdentity(),
      signal: controller.signal,
      isCurrent: () => mutationLifetime.current === controller
        && !controller.signal.aborted
        && getRuntimeGeneration() === generation
        && opencodeClient.getDirectory() === directory,
    };
  });
  const oauthFlow = React.useRef<ReturnType<typeof createProviderOAuthFlow> | null>(null);
  const clearOAuth = useEvent(() => {
    oauthFlow.current?.cancel();
    oauthFlow.current = null;
    setPendingOAuth(null);
    setOauthDetails({});
    setOauthCodes({});
    setAuthBusyKey(null);
  });
  React.useEffect(() => {
    clearOAuth();
    return () => { oauthFlow.current?.cancel(); oauthFlow.current = null; };
  }, [selectedProviderId, candidateProviderId, clearOAuth]);

  React.useEffect(() => {
    if (!selectedProviderId) {
      setSelectedProvider(ADD_PROVIDER_ID);
    }
  }, [providers, selectedProviderId, setSelectedProvider]);

  const unconnectedProviders = React.useMemo(
    () =>
      (connectionQuery.data?.integrations ?? [])
        .filter((integration) => !integration.id.startsWith('mcp_') && integration.connections.length === 0)
        .sort((a, b) => {
          const labelA = (a.name || a.id).toLowerCase();
          const labelB = (b.name || b.id).toLowerCase();
          return labelA.localeCompare(labelB);
        }),
    [connectionQuery.data]
  );

  React.useEffect(() => {
    if (selectedProviderId !== ADD_PROVIDER_ID && selectedProviderId !== CUSTOM_PROVIDER_ID) {
      return;
    }

    if (connectionQuery.isSuccess && candidateProviderId !== CUSTOM_PROVIDER_ID && !unconnectedProviders.some((provider) => provider.id === candidateProviderId)) {
      setCandidateProviderId(CUSTOM_PROVIDER_ID);
      setShowProviderChoices(true);
    }
  }, [selectedProviderId, candidateProviderId, unconnectedProviders, connectionQuery.isSuccess]);

  React.useEffect(() => {
    setModelQuery('');
    setEditingModel(null);
    setApiKeyInputs({});
    setRemovedModel(null);
    setDeleteOpen(false);
    if (selectedProviderId === ADD_PROVIDER_ID || selectedProviderId === CUSTOM_PROVIDER_ID) {
      setCandidateProviderId(initialConnectionId ?? CUSTOM_PROVIDER_ID);
      setShowProviderChoices(!initialConnectionId && selectedProviderId === ADD_PROVIDER_ID);
      setShowAuthPanel(true);
      return;
    }

    setShowAuthPanel(false);
  }, [selectedProviderId, initialConnectionId]);

  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);
  const selectedSources = selectedProviderId ? sourceQuery.data?.[selectedProviderId] : undefined;
  const selectedIntegration = connectionQuery.data?.integrations.find((entry) => entry.id === integrationIdByProvider[selectedProviderId]);
  const hasEnvironmentConnection = selectedIntegration?.connections.some((connection) => connection.type === 'env') === true;
  const hasRemovableProviderData = Boolean(selectedSources?.files.length)
    || selectedIntegration?.connections.some((connection) => connection.type === 'credential' && Boolean(connection.id)) === true;
  const deleteMetadataPending = sourceQuery.isPending || connectionQuery.isPending;
  const deleteMetadataFailed = sourceQuery.isError || connectionQuery.isError;
  const deleteUnavailableHint = hasEnvironmentConnection ? t('settings.providers.delete.environmentHint')
    : !hasRemovableProviderData ? t('settings.providers.delete.runtimeHint') : null;
  const canDeleteProvider = !deleteMetadataPending && !deleteMetadataFailed && !deleteUnavailableHint;
  const deleteHint = deleteMetadataFailed ? t('settings.providers.page.toast.providerSourcesLoadFailed')
    : deleteMetadataPending ? t('settings.providers.page.state.loading') : deleteUnavailableHint;
  const accountConnected = consoleAccountConnected(selectedIntegration)
    || (selectedProviderId === 'opencode-go' && consoleAccountConnected(findSignInIntegration('opencode-go', connectionQuery.data?.integrations)))
    || selectedSources?.auth.type === 'external';
  const authenticationLabel = accountConnected ? 'settings.providers.auth.account'
    : selectedSources?.auth.type === 'api' || selectedIntegration?.connections.some((connection) => connection.type === 'credential' && connection.method === 'key')
      ? 'settings.providers.page.auth.apiKeyLabel'
      : selectedIntegration?.connections.some((connection) => connection.type === 'env') ? 'settings.providers.auth.environment' : 'settings.providers.auth.managed';
  const quotaProvider = selectedProviderId === 'opencode' || selectedProviderId === 'opencode-go' ? 'opencode-go'
    : selectedProviderId === 'ollama' || selectedProviderId === 'ollama-cloud' ? 'ollama-cloud' : selectedProviderId === 'cursor' ? 'cursor' : null;

  const handleSaveApiKey = useEvent(async (providerId: string) => {
    const apiKey = apiKeyInputs[providerId]?.trim() ?? '';
    if (!apiKey) {
      toast.error(t('settings.providers.page.toast.apiKeyRequired'));
      return;
    }

    const scope = captureMutationScope();
    if (!scope) return;
    const busyKey = `api:${providerId}`;
    setAuthBusyKey(busyKey);

    try {
      const integrationID = integrationIdByProvider[providerId] || providerId;
      await opencodeClient.getSdkClient().integration.connect.key({
        integrationID,
        key: apiKey,
        location: scope.location,
      }, { signal: scope.signal });
      if (!scope.isCurrent()) return;

      setApiKeyInputs((prev) => ({ ...prev, [providerId]: '' }));
      await refreshOpenCodeConfiguration({ scopes: ['providers'], mode: 'active', queryDirectory: scope.directory, transportIdentity: scope.transportIdentity });
      if (!scope.isCurrent()) return;
      const refreshed = await connectionQuery.refetch({ throwOnError: true });
      if (!scope.isCurrent()) return;
      void sourceQuery.refetch();
      const connected = refreshed.data?.providers.find((provider) =>
        provider.id === providerId || provider.integrationID === integrationID);
      if (connected) setSelectedProvider(connected.id);
      toast.success(t('settings.providers.page.toast.apiKeySaved'));
    } catch {
      if (scope.isCurrent()) toast.error(t('settings.providers.page.toast.apiKeySaveFailed'));
    } finally {
      if (scope.isCurrent()) setAuthBusyKey(null);
    }
  });

  const handleOAuthStart = useEvent(async (providerId: string, methodIndex: number) => {
    clearOAuth();
    const busyKey = `oauth:${providerId}:${methodIndex}`;
    setAuthBusyKey(busyKey);
    const method = methodsForSignIn(providerId, authMethodsByProvider)[methodIndex];
    const methodID = typeof method?.id === 'string' ? method.id : '';
    if (!methodID) {
      setAuthBusyKey(null);
      toast.error(t('settings.providers.page.toast.oauthStartFailed'));
      return;
    }
    const integrationID = signInIntegrationIdForOAuth(providerId, integrationIdByProvider);
    const ownIntegrationID = integrationIdByProvider[providerId] || providerId;
    const flow = createProviderOAuthFlow({
      integrationID,
      onAttempt: ({ attemptID, mode, url, instructions }) => {
        setOauthDetails({ [`${providerId}:${methodIndex}`]: {
          url, instructions, mode, userCode: /[A-Z0-9]{4}-[A-Z0-9]{4,5}/.exec(instructions)?.[0],
        } });
        setPendingOAuth({ providerId, methodIndex, methodID, attemptID, mode });
        if (mode === 'code') setAuthBusyKey(null);
        if (url && integrationID !== 'claude-code') void openExternalUrl(url);
        toast.message(t('settings.providers.page.toast.completeOAuthInBrowser'));
      },
      onSuccess: async () => {
        setPendingOAuth(null);
        setOauthDetails({});
        setOauthCodes({});
        await refreshOpenCodeConfiguration({ scopes: ['providers'], mode: 'active' });
        if (!flow.isCurrent() || oauthFlow.current !== flow) return;
        const refreshed = await connectionQuery.refetch({ throwOnError: true });
        if (!flow.isCurrent() || oauthFlow.current !== flow) return;
        void sourceQuery.refetch();
        toast.success(t('settings.providers.page.toast.oauthCompleted'));
        // Integration IDs can differ from the activated provider ID.
        const connected = refreshed.data?.providers.find((provider) => provider.id === providerId)
          ?? (integrationID === ownIntegrationID
            ? refreshed.data?.providers.find((provider) => provider.integrationID === integrationID)
            : undefined);
        if (connected) setSelectedProvider(connected.id);
        setAuthBusyKey(null);
      },
      onError: (phase) => {
        setAuthBusyKey(null);
        setPendingOAuth(null);
        setOauthDetails({});
        setOauthCodes({});
        toast.error(t(phase === 'start' ? 'settings.providers.page.toast.oauthStartFailed' : 'settings.providers.page.toast.oauthCompleteFailed'));
      },
    });
    oauthFlow.current = flow;
    await flow.start(methodID);
  });

  const handleOAuthComplete = useEvent(async (providerId: string, methodIndex: number) => {
    const codeKey = `${providerId}:${methodIndex}`;
    const code = oauthCodes[codeKey]?.trim();
    if (!code || pendingOAuth?.mode !== 'code' || pendingOAuth.providerId !== providerId || pendingOAuth.methodIndex !== methodIndex) return;
    setAuthBusyKey(`oauth-complete:${providerId}:${methodIndex}`);
    await oauthFlow.current?.complete(code);
  });

  const handleCopyOAuthLink = async (url: string) => {
    const result = await copyTextToClipboard(url);
    if (result.ok) {
      toast.success(t('settings.providers.page.toast.oauthLinkCopied'));
      return;
    }
    toast.error(t('settings.providers.page.toast.oauthLinkCopyFailed'));
  };

  const handleCopyOAuthCode = async (code: string) => {
    const result = await copyTextToClipboard(code);
    if (result.ok) {
      toast.success(t('settings.providers.page.toast.deviceCodeCopied'));
      return;
    }
    toast.error(t('settings.providers.page.toast.deviceCodeCopyFailed'));
  };

  const handleDeleteProvider = useEvent(async (providerId: string) => {
    if (!canDeleteProvider || providerId !== selectedProviderId) return;
    const scope = captureMutationScope();
    if (!scope) return;
    const busyKey = `delete:${providerId}`;
    setAuthBusyKey(busyKey);

    try {
      const client = opencodeClient.getSdkClient();
      const integrationID = integrationIdByProvider[providerId];
      const integration = integrationID
        ? await client.integration.get({ integrationID, location: scope.location }, { signal: scope.signal })
        : undefined;
      if (!scope.isCurrent()) return;
      const connections = integration?.data.connections ?? [];
      const credentialIds = connections.flatMap((connection) => (
        connection.type === 'credential' && typeof connection.id === 'string' && connection.id
          ? [connection.id]
          : []
      ));
      if (connections.some((connection) => connection.type === 'env')
        || (credentialIds.length === 0 && !selectedSources?.files.length)) {
        toast.error(t('settings.providers.delete.unavailable'));
        void connectionQuery.refetch();
        return;
      }
      const response = await runtimeFetch(`/api/provider/${encodeURIComponent(providerId)}/auth`, {
        method: 'DELETE', signal: scope.signal,
        query: { scope: 'config', ...(scope.directory ? { directory: scope.directory } : {}) },
      });
      if (!response.ok) throw new Error('Unable to delete provider configuration');
      const result = await response.json() as { removed?: boolean };
      if (!scope.isCurrent()) return;
      // Credentials are runtime-global in OpenCode 2; IDs come from the scoped integration read.
      await Promise.all(credentialIds.map((credentialID) => client.credential.remove({ credentialID }, { signal: scope.signal })));
      if (!scope.isCurrent()) return;

      await refreshOpenCodeConfiguration({ scopes: ['providers'], mode: 'active', queryDirectory: scope.directory, transportIdentity: scope.transportIdentity });
      if (!scope.isCurrent()) return;
      const [refreshed] = await Promise.all([connectionQuery.refetch({ throwOnError: true }), sourceQuery.refetch({ throwOnError: true })]);
      if (!scope.isCurrent()) return;
      if (refreshed.data?.providers.some((provider) => provider.id === providerId)) {
        if (credentialIds.length === 0 && !result.removed) {
          toast.error(t('settings.providers.delete.unavailable'));
          return;
        }
        throw new Error('Provider is still registered after configuration and credential removal');
      }
      setDeleteOpen(false);
      setSelectedProvider(ADD_PROVIDER_ID);
      toast.success(t('settings.providers.delete.success'));
    } catch {
      if (scope.isCurrent()) toast.error(t('settings.providers.delete.failed'));
    } finally {
      if (scope.isCurrent()) setAuthBusyKey(null);
    }
  });

  const authFields = (providerId: string) => <ProviderAuthFields key={providerId} providerId={providerId}
    methods={filterMethodsWithIndex(methodsForSignIn(providerId, authMethodsByProvider), (method) => normalizeAuthType(method) === 'oauth')}
    apiKey={apiKeyInputs[providerId] ?? ''} busyKey={authBusyKey}
    apiKeyEnabled={authMethodsByProvider[providerId]?.some((method) => ['key', 'api'].includes(normalizeAuthType(method))) ?? false}
    pendingMethodIndex={pendingOAuth?.providerId === providerId ? pendingOAuth.methodIndex : undefined}
    details={oauthDetails} codes={oauthCodes}
    onKeyChange={(value) => setApiKeyInputs((prev) => ({ ...prev, [providerId]: value }))}
    onSaveKey={() => void handleSaveApiKey(providerId)} onStart={(index) => void handleOAuthStart(providerId, index)}
    onCancel={() => { clearOAuth(); setApiKeyInputs({}); }}
    onCodeChange={(key, value) => setOauthCodes((prev) => ({ ...prev, [key]: value }))}
    onComplete={(index) => void handleOAuthComplete(providerId, index)} onCopyCode={(code) => void handleCopyOAuthCode(code)}
    onOpen={(url) => void openExternalUrl(url)} onCopyLink={(url) => void handleCopyOAuthLink(url)} />;

  if (!isAddMode && providers.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <Icon name="stack" className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-body">{t('settings.providers.page.empty.noProvidersDetected')}</p>
          <p className="typography-meta mt-1 opacity-75">{t('settings.providers.page.empty.checkOpenCodeConfiguration')}</p>
        </div>
      </div>
    );
  }

  if (isAddMode) {
    return (
      <ScrollableOverlay outerClassName="h-full" className="w-full">
        <div className="yuri-settings-section-stack mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">
          {!showProviderChoices && candidateProviderId !== CUSTOM_PROVIDER_ID && <div data-settings-item="providers.connect">
            <Button variant="ghost" size="sm" onClick={() => { clearOAuth(); setApiKeyInputs({}); setShowProviderChoices(true); }}>
              <Icon name="arrow-left-s" className="size-4" />{t('settings.providers.page.connect.selectProviderTitle')}
            </Button>
          </div>}
          {showProviderChoices && <div data-settings-item="providers.connect" className="yuri-settings-section-stack">
            <ProviderChoices providers={unconnectedProviders} search={providerSearchQuery} onSearch={setProviderSearchQuery}
              loading={availableLoading} error={availableError} onSelect={(id) => { setCandidateProviderId(id); setProviderSearchQuery(''); setShowProviderChoices(false); }} />
          </div>}

          {!showProviderChoices && (candidateProviderId === CUSTOM_PROVIDER_ID ? <CustomProviderForm onCancel={() => setShowProviderChoices(true)} /> : candidateProviderId && (
            <div data-settings-item="providers.auth" className="yuri-settings-section-stack">
              <header className="yuri-provider-identity">
                <ProviderLogo providerId={candidateProviderId} className="size-10 shrink-0" />
                <div className="min-w-0">
                  <h2 className="typography-ui-header text-foreground">{unconnectedProviders.find((provider) => provider.id === candidateProviderId)?.name || candidateProviderId}</h2>
                  <p className="typography-meta text-muted-foreground">{t('settings.providers.page.auth.title')}</p>
                </div>
              </header>
              {authLoading ? (
                <p className="typography-meta text-muted-foreground">{t('settings.providers.page.auth.loadingMethods')}</p>
              ) : (
                authFields(candidateProviderId)
              )}
            </div>
          ))}
        </div>
      </ScrollableOverlay>
    );
  }

  if (!selectedProvider) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <Icon name="stack" className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-body">{t('settings.providers.page.empty.selectProviderFromSidebar')}</p>
          <p className="typography-meta mt-1 opacity-75">{t('settings.providers.page.empty.reviewDetailsAndConfigureAuth')}</p>
        </div>
      </div>
    );
  }

  const providerModels = Array.isArray(selectedProvider.models) ? selectedProvider.models : [];
  const hiddenIds = new Set(hiddenModels.filter((model) => model.providerID === selectedProvider.id).map((model) => model.modelID));
  const addedCount = providerModels.filter((model) => !hiddenIds.has(model.id)).length;

  const filteredModels = providerModels.filter((model) => {
    const name = typeof model?.name === 'string' ? model.name : '';
    const id = typeof model?.id === 'string' ? model.id : '';
    const query = modelQuery.trim().toLowerCase();
    if (query && !name.toLowerCase().includes(query) && !id.toLowerCase().includes(query)) return false;
    return true;
  }).sort((a, b) => Number(hiddenIds.has(a.id)) - Number(hiddenIds.has(b.id)));

  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full">
      <div className="yuri-settings-section-stack mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">

        {/* Header */}
        <div className="yuri-provider-identity">
          <ProviderLogo providerId={selectedProvider.id} className="size-10 shrink-0" />
          <div className="min-w-0 flex-1">
            <h2 className="typography-ui-header font-semibold text-foreground truncate">
              {selectedProvider.name || selectedProvider.id}
            </h2>
            <p className="yuri-provider-identity-meta typography-meta text-muted-foreground">
              <span className="min-w-0 break-all font-mono text-xs">{selectedProvider.id}</span>
            </p>
          </div>
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <span tabIndex={!canDeleteProvider ? 0 : -1} aria-disabled={!canDeleteProvider || Boolean(authBusyKey)}
                aria-label={t('settings.common.actions.delete')}
                className={`inline-flex shrink-0 ${!canDeleteProvider || authBusyKey ? 'cursor-not-allowed' : ''}`}>
                <Button variant="ghost" size="icon" aria-label={t('settings.common.actions.delete')}
                  disabled={Boolean(authBusyKey) || !canDeleteProvider} onClick={() => setDeleteOpen(true)}><Icon name="delete-bin" className="size-4" /></Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="end" sideOffset={6} className="max-w-[min(22rem,calc(100vw-2rem))] text-left">
              {deleteHint || t('settings.common.actions.delete')}
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Authentication */}
        <ProviderSettingsSection
          itemId="providers.auth"
          rows
          label={t('settings.providers.page.connectionDetails.title')}
        >
          <SettingsRow label={t('settings.providers.page.auth.title')}>
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
              <span className="flex items-center gap-1.5 typography-meta text-muted-foreground">
                <Icon name={accountConnected ? 'global' : 'key'} className="size-3.5 shrink-0" />
                {authLoading ? t('settings.providers.page.state.loading') : t(authenticationLabel)}
              </span>
              <Button variant="ghost" size="xs" disabled={authBusyKey?.startsWith('api:')} aria-expanded={showAuthPanel} onClick={() => { clearOAuth(); setApiKeyInputs({}); setShowAuthPanel((prev) => !prev); }}>
                {t(showAuthPanel ? 'settings.common.actions.cancel' : 'settings.providers.page.actions.reconnect')}
                <Icon name="arrow-down-s" className={showAuthPanel ? 'size-3.5 rotate-180' : 'size-3.5'} />
              </Button>
            </div>
          </SettingsRow>
         {/* Connection Details */}
         <SettingsRow
           itemId="providers.connection-details"
           label={t('settings.providers.page.connectionDetails.configuredIn')}
         >
              <div className="flex min-w-0 flex-col">
                <span className="typography-meta text-muted-foreground break-all" title={selectedSources?.files.map((file) => file.path).join('\n')}>
                  {!selectedSources ? t(sourceQuery.isError ? 'settings.providers.page.toast.providerSourcesLoadFailed' : sourceQuery.isPending ? 'settings.providers.page.state.loading' : 'settings.providers.page.connectionDetails.noActiveSource')
                    : selectedSources.origin === 'runtime' ? t('settings.providers.source.runtime')
                      : selectedSources.origin === 'builtin' ? t('settings.providers.source.builtin')
                        : selectedSources.files.map((file) => `${t(file.scope === 'project' ? 'settings.providers.page.connectionDetails.source.projectConfig' : file.scope === 'custom' ? 'settings.providers.page.connectionDetails.source.customConfig' : 'settings.providers.page.connectionDetails.source.userConfig')} / ${file.path.split(/[\\/]/).pop()}`).join(', ')}
                </span>
                {sourceQuery.isError && selectedSources && <span role="alert" className="typography-meta text-muted-foreground">{t('settings.providers.page.toast.providerSourcesLoadFailed')}</span>}
              </div>

          </SettingsRow>
          {quotaProvider && <QuotaCredentials key={quotaProvider} providerId={quotaProvider}
            providerName={quotaProvider === 'opencode-go' ? 'OpenCode Go' : quotaProvider === 'ollama-cloud' ? 'Ollama Cloud' : 'Cursor'} />}
          </ProviderSettingsSection>
          {showAuthPanel && (authLoading ? <p className="typography-meta text-muted-foreground">{t('settings.providers.page.auth.loadingMethods')}</p>
            : authFields(selectedProvider.id))}

        {/* Models */}
        <ProviderSettingsSection
          itemId="providers.models"
          rows
          label={t('settings.providers.custom.modelsCount', { count: addedCount })}
          action={(
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
              <div className="relative w-28 min-w-0 sm:w-36">
                <Icon name="search" className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
                <Input bordered value={modelQuery} onChange={(event) => setModelQuery(event.target.value)}
                  aria-label={t('settings.providers.page.models.filterPlaceholder')} placeholder={t('settings.providers.page.models.filterPlaceholder')}
                  className="!h-7 !min-h-0 !pl-7 !pr-2 !text-left !text-xs" />
              </div>
              <Button
                size="xs"
                disabled={addedCount === providerModels.length}
                onClick={() => showAllModels(selectedProvider.id)}
              >
                {t('settings.providers.custom.addAllModels')}
              </Button>
              <Button size="xs" disabled={addedCount === 0} onClick={() => {
                hideAllModels(selectedProvider.id, providerModels.map((model) => model.id));
                setRemovedModel(null);
              }}>{t('settings.providers.models.removeAll')}</Button>
            </div>
          )}
        >
            {filteredModels.length === 0 ? (
              <p className="typography-meta text-muted-foreground py-4 text-center">{t('settings.providers.page.models.noModelsMatchFilter')}</p>
            ) : (
              <div className="divide-y divide-[var(--yuri-settings-row-divider)]">
                {filteredModels.slice(0, 100).map((model) => {
                  const modelId = typeof model?.id === 'string' ? model.id : '';
                  const modelName = typeof model?.name === 'string' ? model.name : modelId;
                  const metadata = modelId ? getModelMetadata(selectedProvider.id, modelId) as ModelMetadata | undefined : undefined;
                  const isHidden = hiddenIds.has(modelId);
                  const editModel = () => setEditingModel({ providerId: selectedProvider.id,
                    inputModalities: metadata?.modalities?.input ?? ['text'], model: { key: modelId, id: modelId, name: modelName,
                      context: metadata?.limit?.context ? String(metadata.limit.context) : '',
                      output: metadata?.limit?.output ? String(metadata.limit.output) : '',
                      tools: metadata?.tool_call === true, vision: metadata?.modalities?.input?.includes('image') === true } });

                  const contextTokens = formatTokens(metadata?.limit?.context);
                  const outputTokens = formatTokens(metadata?.limit?.output);

                  const capabilityIcons: Array<{ key: string; icon: IconName; label: string }> = [];
                  if (metadata?.tool_call) capabilityIcons.push({ key: 'tools', icon: "tools", label: t('settings.providers.page.models.capability.toolCalling') });
                  if (metadata?.reasoning) capabilityIcons.push({ key: 'reasoning', icon: "brain-ai-3", label: t('settings.providers.page.models.capability.reasoning') });
                  if (metadata?.modalities?.input?.includes('image')) capabilityIcons.push({ key: 'image', icon: "file-image", label: t('settings.providers.page.models.capability.imageInput') });

                  return (
                    <ProviderModelRow key={modelId} id={modelId} name={modelName} providerId={selectedProvider.id}
                      added={!isHidden} capabilities={capabilityIcons}
                      detail={[contextTokens ? `${contextTokens} ${t('settings.providers.page.models.tokenBadge.context')}` : '', outputTokens ? `${outputTokens} ${t('settings.providers.page.models.tokenBadge.output')}` : ''].filter(Boolean).join(' · ')}
                      onSelect={isHidden ? () => toggleHiddenModel(selectedProvider.id, modelId) : editModel}
                      onEdit={editModel}
                      onToggle={() => {
                        toggleHiddenModel(selectedProvider.id, modelId);
                        setRemovedModel(isHidden ? null : { providerId: selectedProvider.id, modelId });
                      }} />
                  );
                })}
              </div>
            )}
        </ProviderSettingsSection>
        {filteredModels.length > 100 && <p className="typography-meta text-muted-foreground">{t('settings.providers.models.limit', { count: filteredModels.length })}</p>}
        {removedModel?.providerId === selectedProvider.id && hiddenIds.has(removedModel.modelId) && <div role="status" className="flex items-center justify-between gap-2 typography-meta text-muted-foreground">
          <span>{t('settings.providers.models.removed', { name: removedModel.modelId })}</span>
          <Button variant="ghost" size="xs" onClick={() => { toggleHiddenModel(removedModel.providerId, removedModel.modelId); setRemovedModel(null); }}>{t('settings.providers.models.undo')}</Button>
        </div>}
        {editingModel?.providerId === selectedProvider.id && <ProviderModelEditor key={`${selectedProvider.id}:${editingModel.model.id}`}
          {...editingModel} onClose={() => setEditingModel(null)} />}
        <Dialog open={deleteOpen} onOpenChange={(open) => { if (!authBusyKey) setDeleteOpen(open); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('settings.common.actions.delete')} {selectedProvider.name || selectedProvider.id}</DialogTitle>
              <DialogDescription>{t('settings.providers.delete.description')}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button disabled={Boolean(authBusyKey)} onClick={() => setDeleteOpen(false)}>{t('settings.common.actions.cancel')}</Button>
              <Button variant="destructive" disabled={Boolean(authBusyKey) || !canDeleteProvider} onClick={() => void handleDeleteProvider(selectedProvider.id)}>{t('settings.common.actions.delete')}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </ScrollableOverlay>
  );
};
