import React from 'react';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { historyPreviewLimit, historySources, importJobProgress, isImportJobFinished, type HistorySource, type ImportSession } from '@/lib/historyImport';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { cancelImport, startSourceImport, useImportJobQuery, useImportSourcesQuery, useImportStatesQuery } from '@/queries/historyImportQueries';
import claudeLogo from '@/assets/brand/history-import/claude-code.svg';
import codexLogo from '@/assets/brand/history-import/codex.svg';
import cursorLogo from '@/assets/model-icons/cursor.svg';
import deepseekLogo from '@/assets/model-icons/deepseek.svg';
import opencodeLogo from '@/assets/provider-logos/opencode.svg';
import './history-import.css';

const logos = { claude: claudeLogo, codex: codexLogo, cursor: cursorLogo, dsh: deepseekLogo, opencode: opencodeLogo };

export function HistoryImportStep({ onBusy, directory = null, onPrimaryChange, onComplete }: {
  onBusy: (busy: boolean) => void;
  directory?: string | null;
  onPrimaryChange?: (action: { disabled: boolean; background?: boolean }) => void;
  onComplete?: () => void;
}) {
  const { t, locale } = useI18n();
  const transport = getRuntimeTransportIdentity(); const generation = getRuntimeGeneration();
  const [sources, setSources] = React.useState<HistorySource[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const job = useImportJobQuery();
  const running = job.data?.state === 'running';
  const scan = useImportSourcesQuery(job.isSuccess && !running);
  const imported = useImportStatesQuery(scan.data?.id, directory, `${job.data?.id ?? ''}:${job.data?.state ?? ''}`, !running && !scan.isFetching && !scan.isError);
  const controller = React.useRef<AbortController | null>(null);
  const flight = React.useRef(false);
  const accepted = React.useRef<string | null>(null);
  const heading = React.useRef<HTMLHeadingElement | null>(null);
  const notifyBusy = useEvent(onBusy);
  const notifyPrimary = useEvent((action: { disabled: boolean; background?: boolean }) => onPrimaryChange?.(action));
  const selectSource = useEvent((source: HistorySource, checked: boolean) => setSources((value) => checked
    ? value.includes(source) ? value : [...value, source]
    : value.filter((id) => id !== source)));
  React.useEffect(() => {
    const lifetime = new AbortController(); controller.current = lifetime;
    return () => { lifetime.abort(); notifyBusy(false); };
  }, [transport, generation, notifyBusy]);

  const previewGroups = React.useMemo(() => {
    const groups = historySources.map((source) => ({ ...source, sessions: [] as ImportSession[] }));
    for (const session of scan.data?.sessions ?? []) {
      const group = groups.find((source) => source.id === session.source);
      if (group && group.sessions.length < historyPreviewLimit) group.sessions.push(session);
    }
    return groups.filter((group) => group.sessions.length);
  }, [scan.data]);
  const finished = Boolean(accepted.current && job.data?.id === accepted.current && isImportJobFinished(job.data));
  const disabled = busy || (!running && !finished && (scan.isFetching || !scan.data || scan.isError || job.isError));
  React.useEffect(() => { notifyPrimary({ disabled, background: running }); }, [disabled, running, notifyPrimary]);
  const current = () => !controller.current?.signal.aborted && transport === getRuntimeTransportIdentity() && generation === getRuntimeGeneration();
  const operation = async (run: (signal: AbortSignal) => Promise<void>) => {
    if (flight.current || !controller.current) return;
    flight.current = true; setBusy(true); notifyBusy(true); setError(null);
    try { await run(controller.current.signal); }
    catch (cause) { if (current()) setError(cause instanceof Error && /^[a-z_]+$/.test(cause.message) ? cause.message : 'import_failed'); }
    finally { flight.current = false; if (current()) { setBusy(false); notifyBusy(false); } }
  };
  const submit = () => operation(async (signal) => {
    if (disabled) return;
    if (running || finished) { if (current()) onComplete?.(); return; }
    if (!sources.length) { if (current()) onComplete?.(); return; }
    const result = await startSourceImport(sources, directory, signal, transport, generation);
    if (!current()) return;
    accepted.current = result.id;
    heading.current?.scrollIntoView({ block: 'start' });
  });
  const queryError = scan.error ?? job.error;
  const failed = error || (queryError instanceof Error && /^[a-z_]+$/.test(queryError.message) ? queryError.message : scan.isError || job.isError ? 'import_failed' : null);
  const dateFormatter = React.useMemo(() => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }), [locale]);
  const progress = job.data ? importJobProgress(job.data) : null;
  const numberFormatter = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const sourceCount = (source: HistorySource, id?: string) => {
    const count = scan.data?.counts?.[source];
    const value = count?.value;
    if (value == null || scan.isError) return null;
    const formatted = numberFormatter.format(value);
    const label = t(count?.approximate ? 'historyImport.estimatedCount' : 'historyImport.sourceCount', { count: formatted });
    return <span id={id} data-history-count={source} className="yuri-import-source-count" title={label} aria-label={label}>
      {scan.isFetching ? <Icon name="loader-4" className="size-3 animate-spin" aria-label={t('historyImport.scanning')} /> : `${count?.approximate ? '≈ ' : ''}${formatted}`}
    </span>;
  };
  return <form id="yuri-tour-import" className="yuri-history-import" data-history-import onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <h2 ref={heading} className="yuri-import-heading">{t('historyImport.heading')}</h2>
    <p className="yuri-import-subtitle">{t('historyImport.deduplication')}</p>
    {job.data && !isImportJobFinished(job.data) && (running || accepted.current === job.data.id) && <div className="yuri-import-job" role="status">
      <Icon name={running ? 'loader-4' : 'error-warning'} className={cn('size-4', running && 'animate-spin')} />
      <span>{t(running && progress ? `historyImport.phase.${progress.phase}` : `historyImport.state.${job.data.state}`)}</span>
      {progress && progress.total > 0 && <span className="tabular-nums">{progress.completed} / {progress.total}</span>}
      {running && <Button variant="ghost" size="icon" disabled={busy} aria-label={t('historyImport.cancel')} title={t('historyImport.cancel')} onClick={() => void operation(async (signal) => { await cancelImport(job.data!.id, signal, transport); if (current()) await job.refetch(); })}><Icon name="stop" className="size-4" /></Button>}
      {running && progress && <progress value={progress.total ? progress.completed : undefined} max={progress.total || 1} aria-label={t('historyImport.progress')} />}
      {job.data.progress?.code && <p role="alert">{t('historyImport.failed')} <code>{job.data.progress.code}</code></p>}
      {job.data.results.some((result) => result.status === 'failed' || result.project === 'failed' || result.index === 'failed') && <p role="alert">{t('historyImport.failed')}
        {[...new Set(job.data.results.filter((result) => result.status === 'failed' && result.code).map((result) => result.code))].map((code) => <code key={code}> {code}</code>)}
      </p>}
    </div>}
    <div className="yuri-import-source-grid" aria-label={t('historyImport.sources')}>
      {historySources.map((source) => {
        const installed = scan.data?.installations?.[source.id];
        const installationLabel = t(installed === true ? 'historyImport.installed' : installed === false ? 'historyImport.notDetected' : 'historyImport.installationUnknown');
        const countDescription = scan.data?.counts?.[source.id]?.value != null && !scan.isError ? ` history-import-count-${source.id}` : '';
        return <Button key={source.id} variant="ghost" data-history-source={source.id} className={cn('yuri-import-source-card', (source.id === 'cursor' || source.id === 'opencode') && 'yuri-import-source-cursor')}
          disabled={busy || running} aria-pressed={sources.includes(source.id)} aria-label={source.name} aria-describedby={`history-import-installed-${source.id}${countDescription}`}
          onClick={() => selectSource(source.id, !sources.includes(source.id))}>
          <span className="yuri-import-logo-wrap"><img src={logos[source.id]} alt="" draggable={false} className="yuri-import-source-logo" />
            <span id={`history-import-installed-${source.id}`} role="img" aria-label={installationLabel} title={installationLabel} data-installed={installed === true ? 'true' : installed === false ? 'false' : 'unknown'} className="yuri-import-installation" />
          </span>
          <span className="yuri-import-source-name">{source.name}</span>
          {sourceCount(source.id, `history-import-count-${source.id}`)}
          <span className="yuri-import-source-check" aria-hidden="true"><Icon name="check" className="size-3" /></span>
        </Button>;
      })}
    </div>

    {failed && <div role="alert" className="yuri-tour-feedback"><p>{t(failed === 'history_import_unsupported' ? 'historyImport.unsupported' : 'historyImport.failed')} <code>{failed}</code></p>
      {(scan.isError || job.isError) && <Button variant="ghost" size="xs" disabled={scan.isFetching || job.isFetching} onClick={() => { void Promise.all([scan.refetch(), job.refetch()]); }}>{t('settings.plugins.status.retry')}</Button>}
    </div>}
    {scan.data && !scan.isFetching && !scan.isError && !scan.data.sessions.length && !scan.data.errors.length && <p className="yuri-tour-feedback">{t('historyImport.empty')}</p>}
    {previewGroups.length > 0 && <section aria-label={t('historyImport.sessions')}>
      <div className="yuri-import-list-heading">{t('historyImport.sessions')}</div>
      <div className="yuri-import-preview-groups">{previewGroups.map((group) => <section key={group.id} aria-label={group.name} data-source-selected={sources.includes(group.id)}>
        <div className="yuri-import-preview-heading"><h3>{group.name}</h3>{sourceCount(group.id)}<Checkbox checked={sources.includes(group.id)} disabled={busy || running} ariaLabel={group.name} onChange={(checked) => selectSource(group.id, checked)} /></div>
        <ul className="yuri-import-session-grid">
        {group.sessions.map((session) => <li key={session.key} data-history-session={session.key} className={cn('yuri-import-session-card', (session.source === 'cursor' || session.source === 'opencode') && 'yuri-import-source-cursor')} title={session.title}>
          <img src={logos[session.source]} alt="" draggable={false} className="yuri-import-session-logo" />
          <span className="yuri-import-session-copy"><span className="yuri-import-session-heading"><span className="yuri-import-session-title">{session.title}</span>
              {!imported.isError && imported.data?.states[session.key] === 'imported' && <span className="yuri-import-session-imported" data-history-imported>{t('historyImport.alreadyImported')}</span>}
              {session.updated && session.updated > 0 ? <time dateTime={new Date(session.updated).toISOString()}>{dateFormatter.format(session.updated)}</time> : null}
            </span>
            {session.excerpt && <span className="yuri-import-session-excerpt">{session.excerpt}</span>}
          </span>
        </li>)}
        </ul>
      </section>)}</div>
    </section>}
  </form>;
}
