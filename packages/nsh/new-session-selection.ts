import { signal } from 'nsh';
import { isPrimaryMode } from '../ui/src/components/chat/mobileControlsUtils';
import { pickerPreferences } from './chat-models-helpers';
import { query, type request } from './runtime';
import { list, record, text, unwrap, type Row } from './model';
import { createNativeCatalogCache, nativeCatalogCache } from './catalog-cache';

/** One present picker owns its reads. No session reads or selection mutations. */
export function createNewSessionCatalog(directory: string, current: () => boolean, send: typeof request, scope?: string) {
  type Providers = { providers: Row[]; partial: boolean; complete: boolean };
  const cache = scope ? nativeCatalogCache : createNativeCatalogCache();
  const key = (domain: string) => JSON.stringify([scope ?? null, domain === 'preferences' ? null : directory, domain]);
  const seed = cache.peek<Providers>(key('providers')), saved = cache.peek<Row>(key('preferences')), agentSeed = cache.peek<Row[]>(key('agents'));
  const providers = signal<Row[]>(seed?.providers ?? []), agents = signal<Row[]>(agentSeed ?? []), preferences = signal<Row>(saved ?? {});
  const populated = (rows: Row[]) => rows.some(provider => Object.keys(record(provider.models)).length > 0);
  const providersReady = signal(!!seed && populated(seed.providers)), preferencesReady = signal(!!saved), agentsReady = signal(!!agentSeed?.length);
  const busy = signal(false), refreshing = signal(false), error = signal(''), partial = signal(seed?.partial ?? false), resolved = signal(false);
  let alive = true, serial = 0;
  const ready = (mode: 'model' | 'agent') => mode === 'model' ? providersReady() && preferencesReady() : agentsReady();
  function setPreferences(value: Row) {
    // Never retain the full settings response (it can contain unrelated secrets).
    const picked: Row = {};
    for (const name of ['favoriteModels', 'recentModels', 'hiddenModels', 'providerOrder', 'defaultVariant']) if (value[name] !== undefined) picked[name] = value[name];
    cache.write(key('preferences'), picked); preferences.set(picked); preferencesReady.set(true);
  }
  async function load(mode: 'model' | 'agent') {
    if (!alive || !current()) return;
    const ticket = ++serial, valid = () => alive && ticket === serial && current();
    resolved.set(ready(mode)); busy.set(!ready(mode)); refreshing.set(true); error.set('');
    const failures: string[] = [];
    const apply = async <T>(domain: string, read: (previous: T | undefined) => Promise<T>, publish: (value: T) => void) => {
      try {
        const value = await cache.refresh(key(domain), read);
        if (valid()) { publish(value); resolved.set(ready(mode)); busy.set(!ready(mode)); }
      } catch (failure) { if (valid()) { failures.push(failure instanceof Error ? failure.message : 'new-session-catalog-failed'); error.set([...new Set(failures)].join('\n')); } }
    };
    if (mode === 'agent') await apply<Row[]>('agents', async () => {
      const value = await send(`/api/agent?location%5Bdirectory%5D=${encodeURIComponent(directory)}`), envelope = record(value), response = unwrap(value);
      if (!Array.isArray(response) || envelope.ok === false || envelope.failed === true || envelope.partial === true || envelope.complete === false) throw new Error('new-session-invalid-agent-catalog');
      return list(response).filter(agent => agent.hidden !== true && text(agent.name) && isPrimaryMode(typeof agent.mode === 'string' ? agent.mode : undefined));
    }, value => { agents.set(value); agentsReady.set(true); });
    else await Promise.all([
      apply<Providers>('providers', async previous => {
        const body = record(await send(`/api/config/catalog/providers?${query(directory)}`));
        if (body.schemaVersion !== 1 || body.ok === false || body.failed === true || !Array.isArray(body.providers)) throw new Error('new-session-invalid-model-catalog');
        const partial = body.partial === true || body.complete === false;
        const retainComplete = partial && previous?.complete && populated(previous.providers);
        return { providers: retainComplete ? previous.providers : list(body.providers), partial, complete: !partial || retainComplete === true };
      }, value => { providers.set(value.providers); partial.set(value.partial); providersReady.set(true); }),
      apply<Row>('preferences', async () => {
        const value = pickerPreferences(await send('/api/config/settings'));
        if (!value || value.failed === true || value.partial === true || value.complete === false) throw new Error('new-session-invalid-settings');
        return Object.fromEntries(['favoriteModels', 'recentModels', 'hiddenModels', 'providerOrder', 'defaultVariant'].filter(name => value[name] !== undefined).map(name => [name, value[name]]));
      }, value => { preferences.set(value); preferencesReady.set(true); }),
    ]);
    if (valid()) { busy.set(false); refreshing.set(false); }
  }
  const dispose = () => { alive = false; serial++; };
  return { providers, agents, preferences, providersReady, preferencesReady, agentsReady, setPreferences, busy, refreshing, error, partial, resolved, load, dispose };
}
