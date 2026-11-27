import React from 'react';
import { useRemoteOperationError } from '@/lib/remote-projects/operation-errors';
import { useQuery } from '@tanstack/react-query';
import { useEvent } from '@reactuses/core';
import { useHostRuntime, useRemoteSessionDemand } from '@/contexts/HostRuntimeProvider';
import { useSessionNavigationStore } from '@/stores/useSessionNavigationStore';
import { locationKey } from '@/lib/remote-projects/location';
import { useRemoteHostSummaries } from '@/queries/remoteProjectQueries';
import { providerCatalogQueryOptions } from '@/queries/configCatalogQueries';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { getTranscriptRepository, transcriptScope, refreshTranscriptFromAuthority, subscribeTranscriptRepositoryBinding, getTranscriptRepositoryBindingRevision } from '@/sync/transcript-repository-runtime';
import type { Message, Part } from '@/lib/opencode/v2-types';
import { ContextWindowCard } from './ContextWindowCard';
import { buildContextParts } from './contextWindowMap';

import { deriveMessageRole } from '@/components/chat/message/messageRole';
import { projectTurnRecords } from '@/components/chat/lib/turns/projectTurnRecords';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { computeCacheHitRate } from '@/stores/utils/tokenUtils';
import { useSessions, useSessionMessageRecords } from '@/sync/sync-context';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { TimeFormatPreference } from '@/stores/useUIStore';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import {
  type AssistantTpsInput,
  computeAssistantTps,
  computeAssistantTpsByStep,
  formatAssistantTps,
} from '@/components/chat/message/assistantTps';

type SessionMessage = { info: Message; parts: Part[] };

type ProviderModelLike = {
  id?: string;
  name?: string;
  limit?: { context?: number };
};

type ProviderLike = {
  id?: string;
  name?: string;
  models?: ProviderModelLike[];
};

type TokenBreakdown = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

const EMPTY_BREAKDOWN: TokenBreakdown = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
};

const toNonNegativeNumber = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
};

const extractTokenBreakdown = (message: SessionMessage): TokenBreakdown => {
  const tokenCandidate = (message.info as { tokens?: unknown }).tokens;
  const source =
    tokenCandidate !== undefined
      ? tokenCandidate
      : (message.parts.find((part) => (part as { tokens?: unknown }).tokens !== undefined) as { tokens?: unknown } | undefined)?.tokens;

  if (typeof source === 'number') {
    return {
      ...EMPTY_BREAKDOWN,
      total: toNonNegativeNumber(source),
    };
  }

  if (!source || typeof source !== 'object') {
    return EMPTY_BREAKDOWN;
  }

  const breakdown = source as {
    input?: unknown;
    output?: unknown;
    reasoning?: unknown;
    cache?: { read?: unknown; write?: unknown };
  };

  const input = toNonNegativeNumber(breakdown.input);
  const output = toNonNegativeNumber(breakdown.output);
  const reasoning = toNonNegativeNumber(breakdown.reasoning);
  const cacheRead = toNonNegativeNumber(breakdown.cache?.read);
  const cacheWrite = toNonNegativeNumber(breakdown.cache?.write);

  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total: input + output + reasoning + cacheRead + cacheWrite,
  };
};

const formatNumber = (value: number): string => value.toLocaleString(getCurrentIntlLocale());

const formatMoney = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return new Intl.NumberFormat(getCurrentIntlLocale(), { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(0);
  return new Intl.NumberFormat(getCurrentIntlLocale(), {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value < 0.01 ? 4 : 2,
    maximumFractionDigits: value < 0.01 ? 4 : 2,
  }).format(value);
};

const formatDateTime = (timestamp: number | null, timeFormatPreference: TimeFormatPreference): string => {
  if (!timestamp || !Number.isFinite(timestamp)) return '-';
  return formatDateTimeForPreference(timestamp, timeFormatPreference, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

const resolveProviderAndModel = (
  providers: ProviderLike[],
  providerID: string,
  modelID: string,
): { providerName: string; modelName: string; contextLimit: number | null } => {
  const provider = providers.find((entry) => entry.id === providerID);
  const model = provider?.models?.find((entry) => entry.id === modelID);

  return {
    providerName: provider?.name || providerID || '-',
    modelName: model?.name || modelID || '-',
    contextLimit: typeof model?.limit?.context === 'number' ? model.limit.context : null,
  };
};

export const ContextPanelContent: React.FC<{ active?: boolean }> = ({ active = true }) => {
  const host = useHostRuntime();
  return host?.entry.location.hostId ? <RemoteContextPanelContent key={host.entry.key} active={active} /> : <LocalContextPanelContent />;
};

const LocalContextPanelContent: React.FC = () => {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const sessions = useSessions();
  const sessionMessages = useSessionMessageRecords(currentSessionId ?? '');
  const providers = useConfigStore((state) => state.providers);
  return <ContextPanelContentView currentSessionId={currentSessionId} sessions={sessions} sessionMessages={sessionMessages} providers={providers} />;
};

const RemoteContextPanelContent: React.FC<{ active: boolean }> = ({ active }) => {
  const host = useHostRuntime()!;
  const { t } = useI18n();
  const entry = host.entry;
  const selected = useSessionNavigationStore((state) => state.remoteSession);
  const currentSessionId = selected && locationKey(selected.location) === entry.key ? selected.sessionId : null;
  const revision = React.useSyncExternalStore(subscribeTranscriptRepositoryBinding, getTranscriptRepositoryBindingRevision, getTranscriptRepositoryBindingRevision);
  const binding = React.useMemo(() => {
    const bound = getTranscriptRepository(entry.location);
    return { revision, repository: bound, scope: bound && currentSessionId ? transcriptScope(entry.location, currentSessionId) : null };
  }, [entry.location, currentSessionId, revision]);
  const { repository, scope } = binding;
  const subscribe = React.useMemo(() => (notify: () => void) => active && repository && scope ? repository.subscribe(scope, notify) : () => {}, [active, repository, scope]);
  const read = React.useMemo(() => () => active && repository && scope ? repository.getTranscript(scope) : null, [active, repository, scope]);
  const transcript = React.useSyncExternalStore(subscribe, read, read);
  const [error, setError] = React.useState<string | null>(null);
  const report = useEvent((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  const refresh = useEvent(async () => {
    if (repository && scope && currentSessionId) {
      entry.sdk();
      await refreshTranscriptFromAuthority(entry.location, currentSessionId, { background: true });
      entry.sdk();
    }
    setError(null);
  });
  useRemoteSessionDemand(active ? currentSessionId : null, refresh, report);
  const summaries = useRemoteHostSummaries(host.registry, entry.location.hostId, active && !!currentSessionId);
  const providerQuery = useQuery({ ...providerCatalogQueryOptions(entry.location.directory, getRuntimeTransportIdentity(), entry), enabled: active && !!currentSessionId }, queryClient);
  const providers = React.useMemo(() => providerQuery.data?.providers.map((provider) => ({ ...provider, models: Object.values(provider.models) })) ?? [], [providerQuery.data]);
  const sessions = React.useMemo(() => summaries.data?.directories.find((item) => locationKey({ ...entry.location, directory: item.directory }) === entry.key)?.sessions ?? [], [summaries.data, entry]);
  const sessionMessages = React.useMemo(() => transcript?.messageOrder.flatMap((id) => transcript.messagesByID[id]
    ? [{ info: transcript.messagesByID[id], parts: Array.from(transcript.partsByMessageID[id] ?? []) }]
    : []) ?? [], [transcript]);
  const failure = error ?? providerQuery.error?.message ?? summaries.error?.message;
  useRemoteOperationError(host.registry, entry.location.hostId!, active ? failure : null, async () => {
    await Promise.all([refresh(), providerQuery.refetch(), summaries.refetch()]).catch(report);
  });
  return <div className="flex h-full min-h-0 flex-col" data-remote-context-location={entry.key}>
    {currentSessionId && !transcript && !failure ? <div role="status" className="px-4 py-2 typography-meta text-muted-foreground">{t('common.loading')}</div> : null}
    <div className="min-h-0 flex-1"><ContextPanelContentView currentSessionId={currentSessionId} sessions={sessions} sessionMessages={sessionMessages} providers={providers} /></div>
  </div>;
};

type ContextPanelContentViewProps = {
  currentSessionId: string | null;
  sessions: Array<{ id: string; title?: string; time?: { created?: number } }>;
  sessionMessages: SessionMessage[];
  providers: ProviderLike[];
};

const ContextPanelContentView: React.FC<ContextPanelContentViewProps> = ({ currentSessionId, sessions, sessionMessages, providers }) => {
  const { t } = useI18n();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const showAssistantTps = useUIStore((state) => state.showAssistantTps);

  const viewModel = React.useMemo(() => {
    const currentSession = currentSessionId ? sessions.find((session) => session.id === currentSessionId) ?? null : null;

    const assistantMessages = sessionMessages.filter((entry) => deriveMessageRole(entry.info).role === 'assistant');
    const userMessages = sessionMessages.filter((entry) => deriveMessageRole(entry.info).isUser);
    const turnProjection = showAssistantTps ? projectTurnRecords(sessionMessages) : null;

    let contextMessage: SessionMessage | null = null;
    for (let i = assistantMessages.length - 1; i >= 0; i -= 1) {
      const message = assistantMessages[i];
      if (extractTokenBreakdown(message).total > 0) {
        contextMessage = message;
        break;
      }
    }

    const tokenBreakdown = contextMessage ? extractTokenBreakdown(contextMessage) : EMPTY_BREAKDOWN;

    // Cache hit rate for the last assistant message. `input` is the non-cached portion
    // (total input - cache.read - cache.write per SDK's session.ts:getUsage),
    // so hit rate = cache.read / (input + cache.read + cache.write).
    const cacheHitRate = computeCacheHitRate({
      input: tokenBreakdown.input,
      cache: { read: tokenBreakdown.cacheRead, write: tokenBreakdown.cacheWrite },
    });

    const totalAssistantCost = assistantMessages.reduce((sum, message) => {
      const cost = toNonNegativeNumber((message.info as { cost?: unknown }).cost);
      return sum + cost;
    }, 0);

    const sessionTpsSteps: AssistantTpsInput[] = [];
    for (const turn of turnProjection?.turns ?? []) {
      const turnSteps = turn.assistantMessages.map(({ info }) => ({
        createdAt: info.time.created,
        streamedAt: info.time.streamed,
        outputTokens: info.tokens?.output,
        reasoningTokens: info.tokens?.reasoning,
      }));
      const turnRates = computeAssistantTpsByStep(turnSteps);

      const turnRate = turnRates[turnRates.length - 1] ?? null;
      // Interrupted and failed turns often omit time.completed. Include them
      // when the streamed clocks already produce a rate; skip a live continuation.
      if (turn.completionDisposition !== 'active' && turnRate !== null) {
        sessionTpsSteps.push(...turnSteps);
      }
    }
    const sessionTps = computeAssistantTps(sessionTpsSteps);
    const sessionTpsLabel = sessionTps !== null ? formatAssistantTps(sessionTps) : null;

    const latestAssistantInfo = (contextMessage?.info ?? null) as (Message & { providerID?: string; modelID?: string }) | null;
    const providerModel = resolveProviderAndModel(
      providers as ProviderLike[],
      latestAssistantInfo?.providerID || '',
      latestAssistantInfo?.modelID || '',
    );

    const contextLimit = providerModel.contextLimit;
    const systemPrompt = ([...sessionMessages].reverse().find(
      (entry) => deriveMessageRole(entry.info).isUser && typeof (entry.info as { system?: unknown }).system === 'string',
    )?.info as { system?: string } | undefined)?.system || '';

    const requestTotals: number[] = [];
    for (const message of assistantMessages) {
      const breakdown = extractTokenBreakdown(message);
      const prompt = breakdown.input + breakdown.cacheRead + breakdown.cacheWrite;
      if (prompt > 0) requestTotals.push(prompt);
    }
    const promptTokens = tokenBreakdown.input + tokenBreakdown.cacheRead + tokenBreakdown.cacheWrite;
    // What the next request will carry: the last prompt plus the answer it got.
    const windowUsed = promptTokens > 0 ? promptTokens + tokenBreakdown.output : 0;
    const windowParts = buildContextParts(sessionMessages, { used: windowUsed, firstRequestInput: requestTotals[0] ?? 0, systemPrompt });
    const windowCache = cacheHitRate.hasInput ? { read: tokenBreakdown.cacheRead, total: promptTokens } : null;

    const firstMessageTs = sessionMessages[0]?.info?.time?.created;
    const lastMessageTs = sessionMessages.length > 0
      ? sessionMessages[sessionMessages.length - 1]?.info?.time?.created
      : null;

    return {
      sessionTitle: currentSession?.title || t('contextSidebar.session.untitled'),
      messagesCount: sessionMessages.length,
      userMessagesCount: userMessages.length,
      assistantMessagesCount: assistantMessages.length,
      createdAt: (currentSession?.time?.created ?? firstMessageTs ?? null) as number | null,
      lastActivityAt: (lastMessageTs ?? currentSession?.time?.created ?? null) as number | null,
      providerModel,
      tokenBreakdown,
      cacheHitRate,
      totalAssistantCost,
      sessionTpsLabel: sessionTpsLabel && sessionTpsLabel.length > 0 ? sessionTpsLabel : null,
      contextLimit,
      window: { used: windowUsed, parts: windowParts, requestTotals, cache: windowCache },
    };
  }, [currentSessionId, providers, sessionMessages, sessions, showAssistantTps, t]);

  if (!currentSessionId) {
    return (
        <div className="flex h-full items-center justify-center p-6 text-center typography-ui-label text-muted-foreground">
        {t('contextSidebar.empty.openSession')}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-[52rem] px-5 py-6">

        {/* ── Session header ── */}
        <div className="mb-6">
          <h2 className="typography-ui-header font-semibold text-foreground truncate">{viewModel.sessionTitle}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 typography-micro text-muted-foreground/70">
            <span>{viewModel.providerModel.providerName} / {viewModel.providerModel.modelName}</span>
            {viewModel.createdAt && (
              <>
                <span>&middot;</span>
                <span>{formatDateTime(viewModel.createdAt, timeFormatPreference)}</span>
              </>
            )}
          </div>
        </div>

        {viewModel.window.used > 0 ? (
          <ContextWindowCard
            used={viewModel.window.used}
            limit={viewModel.contextLimit}
            parts={viewModel.window.parts}
            requestTotals={viewModel.window.requestTotals}
            cache={viewModel.window.cache}
          />
        ) : null}

        {/* ── Stat grid ── */}
        <div className="mb-5 space-y-2">
          <div className="grid grid-cols-3 gap-2">
            {([
              { label: t('contextSidebar.stats.messages'), value: formatNumber(viewModel.messagesCount) },
              { label: t('contextSidebar.stats.user'), value: formatNumber(viewModel.userMessagesCount) },
              { label: t('contextSidebar.stats.assistant'), value: formatNumber(viewModel.assistantMessagesCount) },
            ] as const).map((item) => (
              <div key={item.label} className="rounded-lg bg-[var(--surface-elevated)]/70 px-3 py-2.5">
                <div className="typography-micro text-muted-foreground/70">{item.label}</div>
                <div className="mt-0.5 typography-ui-label tabular-nums text-foreground">{item.value}</div>
              </div>
            ))}
          </div>
          <div className={cn('grid gap-2', showAssistantTps ? 'grid-cols-2' : 'grid-cols-1')}>
            <div className="rounded-lg bg-[var(--surface-elevated)]/70 px-3 py-2.5">
              <div className="typography-micro text-muted-foreground/70">{t('contextSidebar.stats.cost')}</div>
              <div className="mt-0.5 typography-ui-label tabular-nums text-foreground">
                {formatMoney(viewModel.totalAssistantCost)}
              </div>
            </div>
            {showAssistantTps ? (
              <div className="rounded-lg bg-[var(--surface-elevated)]/70 px-3 py-2.5">
                <div className="typography-micro text-muted-foreground/70">{t('contextSidebar.stats.sessionTps')}</div>
                <div className="mt-0.5 typography-ui-label tabular-nums text-foreground">
                  {viewModel.sessionTpsLabel ?? '—'}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};
