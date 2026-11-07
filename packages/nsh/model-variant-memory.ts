import { Storage } from 'nsh';
import { list, record, text, type Row } from './model';
import { modelKey, type ModelRef } from './chat-models-helpers';

type MemoryScope = { hostID: string; directory: string; sessionID: string };
const lanes = new Map<string, Promise<unknown>>();
const storageKey = (scope: MemoryScope) => `model-variants-v1:${scope.hostID}`;
const sessionKey = (scope: MemoryScope) => JSON.stringify([scope.directory, scope.sessionID]);

export function variantMemoryUpdate(rows: Row[], session: string, agent: string, ref: ModelRef): Row[] {
  const prior = record(rows.find(row => row.session === session)?.agents);
  const models = { ...record(prior[agent]) }, key = modelKey(ref);
  if (ref.variant) models[key] = ref.variant; else delete models[key];
  const agents = { ...prior };
  if (Object.keys(models).length) agents[agent] = models; else delete agents[agent];
  const rest = rows.filter(row => row.session !== session);
  return (Object.keys(agents).length ? [...rest, { session, agents }] : rest).slice(-150);
}

/** Device-local session → Agent → model preference; never a selection authority. */
export function openModelVariantMemory(scope: MemoryScope | null) {
  const readRows = async () => {
    if (!scope) return [];
    const raw = await Storage.getItem(storageKey(scope));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('invalid-model-variant-memory');
    return list(parsed);
  };
  return {
    async read(): Promise<Row> {
      if (!scope) return {};
      await lanes.get(storageKey(scope));
      return record((await readRows()).find(row => row.session === sessionKey(scope))?.agents);
    },
    async save(agent: string, ref: ModelRef, current: () => boolean): Promise<Row> {
      if (!scope || !agent) return {};
      const key = storageKey(scope), previous = lanes.get(key) ?? Promise.resolve();
      const flight = previous.catch(() => {}).then(async () => {
        const rows = await readRows();
        if (!current()) return {};
        const next = variantMemoryUpdate(rows, sessionKey(scope), agent, ref);
        await Storage.setItem(key, JSON.stringify(next));
        return record(next.find(row => row.session === sessionKey(scope))?.agents);
      });
      lanes.set(key, flight);
      try { return await flight; }
      finally { if (lanes.get(key) === flight) lanes.delete(key); }
    },
  };
}

export function rememberedModelVariant(memory: Row, agent: string, ref: ModelRef): string | undefined {
  return text(record(memory[agent])[modelKey(ref)]) || undefined;
}
