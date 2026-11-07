import { messageFrom, type Message } from '../../model';

export const PAGE_SIZE = 20;
export const TOTAL_PAGES = 20;
export const TOTAL_MESSAGES = PAGE_SIZE * TOTAL_PAGES;
export const marker = (ordinal: number) => `history-marker-${String(ordinal).padStart(4, '0')}`;
export const ordinalOf = (message: Message) => Number(message.id.slice('fixture-'.length));
export const rowHeight = (message: Message) => 86 + ordinalOf(message) % 4 * 16;

function message(ordinal: number): Message {
  const id = `fixture-${String(ordinal).padStart(4, '0')}`;
  return messageFrom({
    id, ordinal, type: ordinal % 2 ? 'user' : 'assistant', finish: 'stop',
    parts: [{ id: `${id}-text`, type: 'text', text: `中性记录 ${ordinal}\n${['整理条目并核对顺序。', '保留记录以便稍后查看。', '本条内容不包含外部链接。'][ordinal % 3]}` }],
    time: { created: 1_700_000_000_000 + ordinal * 1000, completed: 1_700_000_000_000 + ordinal * 1000 + 500 },
  })!;
}

export function fixturePage(page: number): Message[] {
  if (!Number.isInteger(page) || page < 1 || page > TOTAL_PAGES) throw new Error('Invalid fixture page');
  const first = TOTAL_MESSAGES - page * PAGE_SIZE + 1;
  return Array.from({ length: PAGE_SIZE }, (_, index) => message(first + index));
}

export type FixtureSnapshot = {
  messages: Message[];
  page: number;
  loading: boolean;
  error: string;
  requests: number;
  automaticRequests: number;
  manualRequests: number;
  retries: number;
  adopted: number;
  failures: number;
  latestRequests: number;
  appended: number;
  growths: number;
  growthMarker: string;
  grown: string[];
  failNext: boolean;
  delayMs: number;
};

/** Synthetic data source only; production owns row projection and scroll intent. */
export function createHistoryUIKitScenario(changed: (value: FixtureSnapshot) => void = () => {}) {
  let alive = true, latestFlight = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const pending = new Set<() => void>();
  let state: FixtureSnapshot = {
    messages: fixturePage(1), page: 1, loading: false, error: '', requests: 0,
    automaticRequests: 0, manualRequests: 0, retries: 0, adopted: 0, failures: 0,
    latestRequests: 0, appended: 0, growths: 0, growthMarker: '', grown: [], failNext: false, delayMs: 900,
  };
  function publish(patch: Partial<FixtureSnapshot>) {
    if (!alive) return;
    state = { ...state, ...patch }; changed(state);
  }
  function later(ms: number, action: () => void) {
    const timer = setTimeout(() => { timers.delete(timer); if (alive) action(); }, ms);
    timers.add(timer);
  }
  function loadOlder(automatic = false): Promise<void> {
    if (!alive || state.loading || state.page === TOTAL_PAGES || automatic && state.error) return Promise.resolve();
    const page = state.page + 1, fail = state.failNext;
    publish({ loading: true, failNext: false, requests: state.requests + 1,
      automaticRequests: state.automaticRequests + Number(automatic), manualRequests: state.manualRequests + Number(!automatic),
      retries: state.retries + Number(!automatic && !!state.error), error: '' });
    return new Promise(resolve => {
      pending.add(resolve);
      later(state.delayMs, () => {
        if (fail) publish({ loading: false, failures: state.failures + 1, error: `夹具第 ${page} 页注入失败，请手动重试` });
        else publish({ loading: false, page, adopted: state.adopted + 1, messages: [...fixturePage(page), ...state.messages] });
        pending.delete(resolve); resolve();
      });
    });
  }
  async function loadLatest() {
    if (!alive || state.loading || latestFlight) return;
    latestFlight = true;
    publish({ latestRequests: state.latestRequests + 1 });
    later(state.delayMs, () => { latestFlight = false; });
  }
  return {
    snapshot: () => state,
    loadOlder, loadLatest,
    failNext: () => publish({ failNext: !state.failNext }),
    toggleDelay: () => publish({ delayMs: state.delayMs === 900 ? 1800 : 900 }),
    appendTail() {
      if (!alive) return;
      publish({ appended: state.appended + 1, messages: [...state.messages, message(TOTAL_MESSAGES + state.appended + 1)] });
    },
    growLater() {
      const target = state.messages.find(item => !state.grown.includes(item.id));
      if (!target || !alive) return;
      publish({ growthMarker: marker(ordinalOf(target)) });
      later(1800, () => {
        if (state.grown.includes(target.id)) return;
        publish({ grown: [...state.grown, target.id], growths: state.growths + 1 });
      });
    },
    dispose() {
      alive = false;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const resolve of pending) resolve();
      pending.clear();
    },
  };
}

export function fixtureCounters(state: FixtureSnapshot) {
  return {
    page: state.page, pages: TOTAL_PAGES, rows: state.messages.length, requests: state.requests,
    auto: state.automaticRequests, manual: state.manualRequests, retries: state.retries,
    adopted: state.adopted, failures: state.failures, error: state.error, loading: state.loading,
    latest: state.latestRequests, appended: state.appended, growths: state.growths,
    growthMarker: state.growthMarker, failNext: state.failNext, delayMs: state.delayMs,
  };
}
