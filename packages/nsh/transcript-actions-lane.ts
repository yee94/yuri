import { signal } from 'nsh';

type Owner = { kind: 'send' | 'history'; token: object };
type Lane = { source: ReturnType<typeof signal<Owner | null>>; users: number };
const lanes = new Map<string, Lane>();

/** One synchronous ownership gate per runtime/session, shared by mounted pages. */
export function openNativeHistoryLane(key: string) {
  const lane = lanes.get(key) ?? { source: signal<Owner | null>(null), users: 0 };
  lanes.set(key, lane); lane.users++;
  let historyOwner: Owner | undefined, closed = false;
  const collect = () => { if (!lane.users && !lane.source() && lanes.get(key) === lane) lanes.delete(key); };
  const release = (owner: Owner) => { if (lane.source() === owner) lane.source.set(null); collect(); };
  function setHistory(value: boolean) {
    if (!value) { if (historyOwner) release(historyOwner); historyOwner = undefined; return; }
    if (closed || lane.source()) throw new Error('Session history/send operation is pending');
    historyOwner = { kind: 'history', token: {} }; lane.source.set(historyOwner);
  }
  const historyBusy = Object.assign(() => lane.source()?.kind === 'history', { set: setHistory, update: (work: (value: boolean) => boolean) => setHistory(work(lane.source()?.kind === 'history')) });
  return {
    historyBusy,
    acquireSend() {
      if (closed || lane.source()) return null;
      const owner: Owner = { kind: 'send', token: {} }; lane.source.set(owner);
      return () => release(owner);
    },
    close() { if (closed) return; closed = true; lane.users--; collect(); },
  };
}
