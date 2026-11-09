import { describe, expect, it } from 'vitest';
import { sessionCatalogFrom } from './session-catalog';
import type { Session } from './model';
import { dict as en } from '../ui/src/lib/i18n/messages/en';
import { dict as zhCN } from '../ui/src/lib/i18n/messages/zh-CN';
import { dict as zhTW } from '../ui/src/lib/i18n/messages/zh-TW';
import { dict as ja } from '../ui/src/lib/i18n/messages/ja';
import { dict as ko } from '../ui/src/lib/i18n/messages/ko';
import { dict as fr } from '../ui/src/lib/i18n/messages/fr';
import { dict as es } from '../ui/src/lib/i18n/messages/es';
import { dict as pl } from '../ui/src/lib/i18n/messages/pl';
import { dict as ptBR } from '../ui/src/lib/i18n/messages/pt-BR';
import { dict as uk } from '../ui/src/lib/i18n/messages/uk';

const prior = (id: string, directory = '/repo', updated = 10): Session => ({ id, title: id, directory, updated });
const row = (id: string, updated = 20) => ({ id, title: id, time: { updated } });
const snapshot = (directories: unknown[], sync: object = {}) => ({ available: true, directories, sync });

describe('per-directory session-index display adoption', () => {
  it('replaces complete directories including successful empty, without retaining a phantom failed scope', () => {
    const value = sessionCatalogFrom(snapshot([{ directory: '/repo', sessions: [] }]), [prior('old'), prior('removed-directory', '/removed')]);
    expect(value).toEqual({ sessions: [], complete: true, issues: undefined });
  });
  it('seeds failed cold directories but prior confirmed rows win over failed entry seeds', () => {
    const value = sessionCatalogFrom(snapshot([{ directory: '/repo', sessions: [row('old'), row('seed')] }], { failedDirectories: ['/repo'] }), [prior('old')]);
    expect(value.complete).toBe(false);
    expect(value.sessions.find(row => row.id === 'old')?.updated).toBe(10);
    expect(value.sessions.some(row => row.id === 'seed')).toBe(true);
  });
  it('one malformed directory preserves its prior rows while an unrelated complete directory adopts', () => {
    const value = sessionCatalogFrom(snapshot([{ directory: '/repo', sessions: null }, { directory: '/good', sessions: [row('new')] }]), [prior('keep')]);
    expect(value.issues?.failedDirectories).toEqual(['/repo']);
    expect(value.sessions.map(row => row.id)).toEqual(['new', 'keep']);
  });
  it('pending and active snapshots cannot clear unknown directories, while completed directories can clear', () => {
    const value = sessionCatalogFrom(snapshot([{ directory: '/repo', sessions: [] }, { directory: '/done', sessions: [] }], { active: true, completedDirectories: ['/done'], pendingDirectories: ['/repo'] }), [prior('keep'), prior('clear', '/done'), prior('not-listed', '/other')]);
    expect(value.sessions.map(row => row.id)).toEqual(['keep', 'not-listed']);
    expect(value.complete).toBe(false);
  });
  it('a bounded complete head retains only known older tail and replaces entries within its boundary', () => {
    const value = sessionCatalogFrom(snapshot([{ directory: '/repo', sessions: [row('new', 30), row('head', 20)], hasMore: true }]), [prior('head', '/repo', 25), prior('removed-within-head', '/repo', 22), prior('tail', '/repo', 5)]);
    expect(value.sessions.map(row => row.id)).toEqual(['new', 'head', 'tail']);
    expect(value.complete).toBe(true);
  });
  it('normalizes failed/pending path identity and rejects ambiguous or unscopable wire', () => {
    const value = sessionCatalogFrom(snapshot([{ directory: 'c:\\Repo', sessions: [] }], { failedDirectories: ['C:/Repo/'] }), [prior('keep', 'C:/Repo')]);
    expect(value.sessions.map(row => row.id)).toEqual(['keep']);
    for (const body of [{ available: false, directories: [] }, snapshot([{ directory: '', sessions: [] }]), snapshot([], { failedDirectories: 'unknown' }), snapshot([{ directory: '/repo', sessions: [] }, { directory: '/repo/', sessions: [] }])]) {
      expect(() => sessionCatalogFrom(body, [])).toThrow();
    }
  });
  it('global partial flags never yield completeness or erase unproven previous scopes', () => {
    const value = sessionCatalogFrom({ ...snapshot([{ directory: '/repo', sessions: [] }]), partial: true }, [prior('keep')]);
    expect(value.sessions.map(row => row.id)).toEqual(['keep']);
    expect(value.complete).toBe(false);
  });
  it('an unexplained completed/total deficit cannot clear an unproven directory even after sync becomes inactive', () => {
    const value = sessionCatalogFrom(snapshot([{ directory: '/repo', sessions: [] }, { directory: '/done', sessions: [] }], { active: false, completed: 1, total: 2, completedDirectories: ['/done'] }), [prior('keep'), prior('clear', '/done')]);
    expect(value.sessions.map(row => row.id)).toEqual(['keep']);
    expect(value.complete).toBe(false);
  });
  it('localizes the partial-display notice for all shipped languages without English placeholders', () => {
    for (const dictionary of [zhCN, zhTW, ja, ko, fr, es, pl, ptBR, uk]) {
      expect(dictionary['mobile.sessions.catalogPartial']).toBeTruthy();
      expect(dictionary['mobile.sessions.catalogPartial']).not.toBe(en['mobile.sessions.catalogPartial']);
    }
  });
});
