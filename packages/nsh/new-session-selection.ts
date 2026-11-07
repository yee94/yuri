import { signal } from 'nsh';
import { isPrimaryMode } from '../ui/src/components/chat/mobileControlsUtils';
import { pickerPreferences } from './chat-models-helpers';
import { query, type request } from './runtime';
import { list, record, text, unwrap, type Row } from './model';

/** One present picker owns its reads. No session reads or selection mutations. */
export function createNewSessionCatalog(directory: string, current: () => boolean, send: typeof request) {
  const providers = signal<Row[]>([]), agents = signal<Row[]>([]), preferences = signal<Row>({});
  const busy = signal(false), error = signal(''), partial = signal(false), resolved = signal(false);
  let alive = true, serial = 0;
  async function load(mode: 'model' | 'agent') {
    if (!alive || !current()) return;
    const ticket = ++serial; busy.set(true); error.set('');
    try {
      if (mode === 'agent') {
        const response = unwrap(await send(`/api/agent?location%5Bdirectory%5D=${encodeURIComponent(directory)}`));
        if (!alive || ticket !== serial || !current()) return;
        if (!Array.isArray(response)) throw new Error('new-session-invalid-agent-catalog');
        agents.set(list(response).filter(agent => agent.hidden !== true && text(agent.name) && isPrimaryMode(typeof agent.mode === 'string' ? agent.mode : undefined)));
      } else {
        const [response, settings] = await Promise.all([send(`/api/config/catalog/providers?${query(directory)}`), send('/api/config/settings')]);
        if (!alive || ticket !== serial || !current()) return;
        const body = record(response), saved = pickerPreferences(settings);
        if (body.schemaVersion !== 1 || body.ok === false || !Array.isArray(body.providers) || !saved) throw new Error('new-session-invalid-model-catalog');
        providers.set(list(body.providers)); preferences.set(saved); partial.set(body.partial === true);
      }
      resolved.set(true);
    } catch (failure) { if (alive && ticket === serial && current()) error.set(failure instanceof Error ? failure.message : 'new-session-catalog-failed'); }
    finally { if (alive && ticket === serial) busy.set(false); }
  }
  const dispose = () => { alive = false; serial++; };
  return { providers, agents, preferences, busy, error, partial, resolved, load, dispose };
}
