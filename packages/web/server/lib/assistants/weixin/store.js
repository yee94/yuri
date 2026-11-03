import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);

export function createWeixinStore(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const filename = path.join(directory, 'channel.sqlite');
  // Private directory protects the journal too. Do not use the shared settings
  // response, contact transcript or model context as a credential store.
  const db = new (require('better-sqlite3'))(filename);
  fs.chmodSync(filename, 0o600);
  db.pragma('busy_timeout = 5000');
  db.pragma('secure_delete = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS binding (
      assistant_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, account_id TEXT NOT NULL UNIQUE,
      peer_id TEXT NOT NULL, token TEXT NOT NULL, base_url TEXT NOT NULL,
      language TEXT NOT NULL, cursor TEXT NOT NULL DEFAULT '', context_token TEXT NOT NULL DEFAULT '',
      generation INTEGER NOT NULL, ordinal INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'connected',
      error TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inbox (
      id TEXT PRIMARY KEY, epoch TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(epoch, state);
    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT NOT NULL UNIQUE, epoch TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
      sequence INTEGER PRIMARY KEY AUTOINCREMENT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(epoch, state, sequence);
    CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);`);
  if (!db.prepare('PRAGMA table_info(inbox)').all().some((column) => column.name === 'payload')) {
    db.exec("ALTER TABLE inbox ADD COLUMN payload TEXT NOT NULL DEFAULT ''");
  }
  const get = (assistantID) => db.prepare('SELECT * FROM binding WHERE assistant_id=?').get(assistantID) ?? null;
  const patch = (epoch, values) => {
    const allowed = new Set(['cursor', 'context_token', 'generation', 'ordinal', 'status', 'error', 'updated_at']);
    const keys = Object.keys(values).filter((key) => allowed.has(key));
    if (!keys.length) return;
    db.prepare(`UPDATE binding SET ${keys.map((key) => `${key}=?`).join(',')} WHERE epoch=?`).run(...keys.map((key) => values[key]), epoch);
  };
  const enqueue = (epoch, id, text) => db.prepare('INSERT OR IGNORE INTO outbox(id,epoch,text) VALUES (?,?,?)').run(id, epoch, text);
  const unlink = db.transaction((assistantID) => {
    const binding = get(assistantID);
    if (!binding) return;
    db.prepare('DELETE FROM inbox WHERE epoch=?').run(binding.epoch);
    db.prepare('DELETE FROM outbox WHERE epoch=?').run(binding.epoch);
    db.prepare('DELETE FROM binding WHERE assistant_id=?').run(assistantID);
  });
  return {
    get, patch, enqueue, unlink,
    list: () => db.prepare('SELECT * FROM binding ORDER BY assistant_id').all(),
    bind: db.transaction((value) => {
      const existing = db.prepare('SELECT assistant_id FROM binding WHERE account_id=?').get(value.account_id);
      if (existing && existing.assistant_id !== value.assistant_id) { const error = new Error('account_in_use'); error.code = 'account_in_use'; throw error; }
      unlink(value.assistant_id);
      db.prepare(`INSERT INTO binding(assistant_id,epoch,account_id,peer_id,token,base_url,language,generation,ordinal,updated_at)
        VALUES (@assistant_id,@epoch,@account_id,@peer_id,@token,@base_url,@language,@generation,@ordinal,@updated_at)`)
        .run({ ...value, epoch: randomUUID() });
      return get(value.assistant_id);
    }),
    transfer: db.transaction(({ sourceAssistantID, expectedEpoch, assistantID, generation, ordinal, language, updatedAt }) => {
      const source = get(sourceAssistantID);
      if (!source || source.epoch !== expectedEpoch || source.status === 'expired' || get(assistantID)) {
        const error = new Error('binding_changed'); error.code = 'binding_changed'; throw error;
      }
      const epoch = randomUUID();
      // Keep receipt IDs across moves so a replay cannot execute tools in the new Bot.
      db.prepare("UPDATE inbox SET epoch=?,state='done',text='',payload='' WHERE epoch=?").run(epoch, source.epoch);
      db.prepare('DELETE FROM outbox WHERE epoch=?').run(source.epoch);
      db.prepare(`UPDATE binding SET assistant_id=?,epoch=?,generation=?,ordinal=?,language=?,updated_at=?,status='connected',error=NULL WHERE epoch=?`)
        .run(assistantID, epoch, generation, ordinal, language, updatedAt, source.epoch);
      return get(assistantID);
    }),
    accept: db.transaction((binding, cursor, messages) => {
      if (get(binding.assistant_id)?.epoch !== binding.epoch) return;
      for (const message of messages) {
        db.prepare('INSERT OR IGNORE INTO inbox(id,epoch,text,payload) VALUES (?,?,?,?)').run(message.id, binding.epoch, message.text, message.payload || '');
        if (message.context) patch(binding.epoch, { context_token: message.context });
      }
      patch(binding.epoch, { cursor });
    }),
    pending: (epoch) => db.prepare("SELECT * FROM inbox WHERE epoch=? AND state='pending' ORDER BY rowid LIMIT 20").all(epoch),
    hasReceipt: (id, epoch) => typeof id === 'string' && Boolean(db.prepare('SELECT 1 FROM inbox WHERE id=? AND epoch=?').get(id, epoch)),
    backlog: (epoch) => db.prepare("SELECT COUNT(*) AS count FROM inbox WHERE epoch=? AND state IN ('pending','admitted')").get(epoch).count,
    markInbox: (id, state) => db.prepare('UPDATE inbox SET state=? WHERE id=?').run(state, id),
    finishTurn: (id) => db.prepare("UPDATE inbox SET state='done',text='',payload='' WHERE id=?").run(id),
    recover: db.transaction((epoch, text) => {
      for (const row of db.prepare("SELECT id FROM inbox WHERE epoch=? AND state='admitted'").all(epoch)) {
        enqueue(epoch, `${row.id}:interrupted`, text);
        db.prepare("UPDATE inbox SET state='done',text='',payload='' WHERE id=?").run(row.id);
      }
      // A process exit during HTTP send cannot prove whether Weixin accepted it.
      db.prepare("UPDATE outbox SET state='unknown' WHERE epoch=? AND state='sending'").run(epoch);
    }),
    collect: db.transaction((binding, page, deliveries) => {
      if (get(binding.assistant_id)?.epoch !== binding.epoch) return;
      if (binding.generation !== page.generation) db.prepare('DELETE FROM outbox WHERE epoch=?').run(binding.epoch);
      for (const delivery of deliveries) enqueue(binding.epoch, delivery.id, delivery.text);
      patch(binding.epoch, { generation: page.generation, ordinal: page.ordinal });
    }),
    nextDelivery: (epoch) => db.prepare("SELECT * FROM outbox WHERE epoch=? AND state!='sent' ORDER BY sequence LIMIT 1").get(epoch),
    markDelivery: (id, state) => db.prepare('UPDATE outbox SET state=? WHERE id=?').run(state, id),
    sent: (id) => db.prepare("UPDATE outbox SET state='sent',text='' WHERE id=?").run(id),
    retry: (epoch) => db.prepare("UPDATE outbox SET state='pending' WHERE epoch=? AND state IN ('unknown','blocked')").run(epoch),
    unblock: (epoch) => db.prepare("UPDATE outbox SET state='pending' WHERE epoch=? AND state='blocked'").run(epoch),
    hasUnknown: (epoch) => Boolean(db.prepare("SELECT 1 FROM outbox WHERE epoch=? AND state='unknown' LIMIT 1").get(epoch)),
    acquire: (owner, now) => Boolean(db.prepare(`INSERT INTO lease(id,owner,expires_at) VALUES (1,?,?)
      ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
      WHERE lease.owner=excluded.owner OR lease.expires_at<=?`).run(owner, now + 60_000, now).changes),
    owns: (owner, now) => Boolean(db.prepare('SELECT 1 FROM lease WHERE id=1 AND owner=? AND expires_at>?').get(owner, now)),
    release: (owner) => db.prepare('DELETE FROM lease WHERE owner=?').run(owner),
    close: () => db.close(),
  };
}
