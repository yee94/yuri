import { messageFrom, type Message } from '../../model';

export const PAGE_SIZE = 20;
export const TOTAL_PAGES = 20;
export const TOTAL_MESSAGES = PAGE_SIZE * TOTAL_PAGES;
export const marker = (id: string) => `terminal-marker-${id}`;
export type Probe = 'page' | 'controls';
export type TerminalSnapshot = {
  messages: Message[]; page: number; cursor: string | null; more: boolean; loading: boolean;
  revision: number; requests: number; adopted: number; controlCommits: number; latest: number;
  footerEnabled: boolean; metadataEnabled: boolean; metadataIDs: string[];
  pending: Probe | null; trigger: string; delayMs: number;
};
export type Journal = {
  phase: string; jsMonotonicMs: number; revision: number; trigger: string;
  requestCursor: string | null; responseIDs: string[]; state: TerminalSnapshot;
};
const cursor = (page: number) => page < TOTAL_PAGES ? `opaque-fixture-page-${page + 1}` : null;
export function fixturePage(page: number): Message[] {
  if (!Number.isInteger(page) || page < 1 || page > TOTAL_PAGES) throw new Error('Invalid page');
  const start = TOTAL_MESSAGES - page * PAGE_SIZE + 1;
  return Array.from({ length: PAGE_SIZE }, (_, i) => {
    const ordinal = start + i, id = `record-${String(ordinal).padStart(4, '0')}`;
    return messageFrom({ id, ordinal, type: ordinal % 2 ? 'assistant' : 'user', finish: 'stop',
      parts: [{ id: `${id}-text`, type: 'text', text: `记录 ${ordinal}\n\n${Array.from({ length: 1 + ordinal % 4 }, (_, line) => `${line + 1}. 中性条目，保留完整正文与自然换行；核对编号及阅读位置。`).join('\n')}` }],
    })!;
  });
}

/** Data-only diagnostic controls. Never a product patch or a geometry oracle. */
export function createHistoryTerminalScenario(
  changed: (value: TerminalSnapshot) => void = () => {},
  journal: (event: Journal) => void = () => {},
  now: () => number = () => performance.now(),
) {
  let alive = true;
  let state: TerminalSnapshot = { messages: fixturePage(1), page: 1, cursor: cursor(1), more: true, loading: false,
    revision: 0, requests: 0, adopted: 0, controlCommits: 0, latest: 0,
    footerEnabled: true, metadataEnabled: true, metadataIDs: [], pending: null, trigger: 'seed', delayMs: 1200 };
  function emit(phase: string, requestCursor: string | null = state.cursor, responseIDs: string[] = []) {
    journal({ phase, jsMonotonicMs: now(), revision: state.revision, trigger: state.trigger, requestCursor, responseIDs, state });
  }
  function publish(patch: Partial<TerminalSnapshot>) {
    if (!alive) return;
    state = { ...state, ...patch, revision: state.revision + 1 }; changed(state);
  }
  function begin(probe: Probe, trigger: string): boolean {
    if (!alive || state.loading || probe === 'page' && (!state.more || state.page === TOTAL_PAGES)) return false;
    emit('before-request');
    publish({ loading: true, pending: probe, trigger, requests: state.requests + Number(probe === 'page') });
    emit('request'); return true;
  }
  function commit(): boolean {
    if (!alive || !state.pending) return false;
    const requestCursor = state.cursor, probe = state.pending;
    const response = probe === 'page' ? fixturePage(state.page + 1) : [];
    const page = state.page + Number(probe === 'page');
    const target = state.messages.find(message => message.role === 'assistant')!.id;
    emit('before-js-commit', requestCursor, response.map(message => message.id));
    publish({ page, cursor: probe === 'page' ? cursor(page) : state.cursor,
      messages: response.length ? [...response, ...state.messages] : state.messages,
      // The default faithful terminal path removes the footer. No reserved spacer.
      more: state.footerEnabled ? probe === 'controls' ? false : page < TOTAL_PAGES : state.more,
      metadataIDs: state.metadataEnabled && !state.metadataIDs.includes(target) ? [...state.metadataIDs, target] : state.metadataIDs,
      loading: false, pending: null, adopted: state.adopted + Number(probe === 'page'), controlCommits: state.controlCommits + Number(probe === 'controls') });
    emit('after-js-commit', requestCursor, response.map(message => message.id)); return true;
  }
  emit('seed');
  return {
    snapshot: () => state, begin, commit,
    configure(key: 'footerEnabled' | 'metadataEnabled') {
      if (!alive || state.loading) return;
      publish({ [key]: !state[key], trigger: `toggle-${key}` }); emit('configure');
    },
    latest() { if (alive && !state.loading) { publish({ latest: state.latest + 1, trigger: 'native-latest' }); emit('latest-noop'); } },
    dispose() { alive = false; },
  };
}

export function authority(state: TerminalSnapshot, rowKeys: string[]) {
  return { revision: state.revision, page: state.page, cursor: state.cursor, more: state.more, loading: state.loading,
    messageCount: state.messages.length, messageIDs: state.messages.map(message => message.id), rowCount: rowKeys.length, rowKeys,
    requests: state.requests, adopted: state.adopted, controlCommits: state.controlCommits, latest: state.latest,
    pending: state.pending, trigger: state.trigger, footerEnabled: state.footerEnabled, metadataEnabled: state.metadataEnabled,
    metadataIDs: state.metadataIDs, delayMs: state.delayMs };
}
