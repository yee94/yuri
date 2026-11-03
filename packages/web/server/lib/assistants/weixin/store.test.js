import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { createWeixinStore } from './store.js';

const Database = createRequire(import.meta.url)('better-sqlite3');
const cleanup = [];
afterEach(() => { while (cleanup.length) cleanup.pop()(); });
const directory = () => {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'yuri-weixin-store-'));
  cleanup.push(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
};
const bind = (store, assistant_id = 'bot') => store.bind({ assistant_id, account_id: 'account', peer_id: 'owner', token: 'fake-token',
  base_url: 'https://ilinkai.weixin.qq.com', language: 'zh-CN', generation: 0, ordinal: 0, updated_at: 1 });

describe('WeChat structured receipt persistence', () => {
  it('adds the payload column to an existing text-only database without losing cursor, receipts or binding', () => {
    const dir = directory();
    let store = createWeixinStore(dir);
    const binding = bind(store);
    store.accept(binding, 'old-cursor', [{ id: 'legacy', text: 'old message', context: 'old-context' }]);
    store.close();
    const db = new Database(path.join(dir, 'channel.sqlite'));
    db.exec('ALTER TABLE inbox DROP COLUMN payload');
    db.close();
    store = createWeixinStore(dir);
    cleanup.push(() => store.close());
    expect(store.pending(binding.epoch)).toEqual([expect.objectContaining({ id: 'legacy', text: 'old message', payload: '' })]);
    expect(store.get('bot')).toMatchObject({ epoch: binding.epoch, cursor: 'old-cursor', context_token: 'old-context' });
    store.accept(binding, 'new-cursor', [{ id: 'legacy', text: 'duplicate', payload: 'duplicate' }]);
    expect(store.pending(binding.epoch)[0].text).toBe('old message');
  });

  it('round-trips pending rich receipts across restart; completed/crash-recovered and transferred receipts clear private payloads', () => {
    const dir = directory();
    let store = createWeixinStore(dir);
    const binding = bind(store);
    const payload = '{"version":1,"media":[{"aes_key":"fake-private-key"}],"items":[]}';
    store.accept(binding, 'cursor', ['pending', 'admitted', 'done'].map((id) => ({ id, text: '', payload })));
    store.markInbox('admitted', 'admitted');
    store.finishTurn('done');
    store.close();
    store = createWeixinStore(dir);
    cleanup.push(() => store.close());
    expect(store.pending(binding.epoch)).toEqual([expect.objectContaining({ id: 'pending', payload })]);
    store.recover(binding.epoch, 'interrupted');
    const db = new Database(path.join(dir, 'channel.sqlite'));
    cleanup.push(() => db.close());
    expect(db.prepare("SELECT payload FROM inbox WHERE id IN ('done','admitted')").all()).toEqual([{ payload: '' }, { payload: '' }]);
    const moved = store.transfer({ sourceAssistantID: 'bot', expectedEpoch: binding.epoch, assistantID: 'other', generation: 0, ordinal: 0, language: 'en', updatedAt: 2 });
    expect(store.pending(moved.epoch)).toEqual([]);
    expect(db.prepare('SELECT payload,text,state FROM inbox').all()).toEqual(Array.from({ length: 3 }, () => ({ payload: '', text: '', state: 'done' })));
    store.unlink('other');
    expect(db.prepare('SELECT COUNT(*) AS count FROM inbox').get().count).toBe(0);
  });

  it('rolls back receipt payloads, context and cursor together when one receipt insert fails', () => {
    const dir = directory();
    const store = createWeixinStore(dir);
    cleanup.push(() => store.close());
    const binding = bind(store);
    const db = new Database(path.join(dir, 'channel.sqlite'));
    cleanup.push(() => db.close());
    db.exec("CREATE TRIGGER reject_bad BEFORE INSERT ON inbox WHEN NEW.id='bad' BEGIN SELECT RAISE(ABORT,'test failure'); END");
    expect(() => store.accept(binding, 'must-not-commit', [{ id: 'ok', text: 'good', payload: 'good', context: 'new-context' }, { id: 'bad', text: '', payload: 'bad' }])).toThrow();
    expect(store.pending(binding.epoch)).toEqual([]);
    expect(store.get('bot')).toMatchObject({ cursor: '', context_token: '' });
  });
});
