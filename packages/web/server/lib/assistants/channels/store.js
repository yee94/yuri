import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);

const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  return error;
};

/**
 * Private SQLite state for Host-owned enterprise message channels.
 *
 * All platform secrets, routing targets and pending text live here. This store is
 * never exposed through settings/snapshot DTOs, contact transcripts or model
 * context. A single database is shared by every provider so the process lease and
 * account ownership checks are atomic across providers.
 */
export function createAssistantChannelStore(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const filename = path.join(directory, 'channel.sqlite');
  // Private directory protects the journal/WAL too. Do not use the shared
  // settings response, contact transcript or model context as a credential store.
  const db = new (require('better-sqlite3'))(filename);
  fs.chmodSync(filename, 0o600);
  db.pragma('busy_timeout = 5000');
  db.pragma('secure_delete = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel (
      assistant_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      epoch TEXT NOT NULL,
      client_id TEXT NOT NULL,
      client_secret TEXT NOT NULL DEFAULT '',
      owner_id TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'en',
      target TEXT NOT NULL DEFAULT '',
      generation INTEGER NOT NULL DEFAULT 0,
      ordinal INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'disconnected',
      error TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (assistant_id, provider),
      UNIQUE (provider, client_id)
    );
    CREATE TABLE IF NOT EXISTS inbox (
      id TEXT PRIMARY KEY,
      epoch TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT '',
      target TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(epoch, state);
    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT NOT NULL UNIQUE,
      epoch TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      sequence INTEGER PRIMARY KEY AUTOINCREMENT
    );
    CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(epoch, state, sequence);
    CREATE TABLE IF NOT EXISTS lease (
      id INTEGER PRIMARY KEY CHECK(id=1),
      owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  const inboxColumns = db.prepare("SELECT name FROM pragma_table_info('inbox')").all();
  if (!inboxColumns.some((column) => column.name === 'target')) db.exec("ALTER TABLE inbox ADD COLUMN target TEXT NOT NULL DEFAULT ''");
  if (!db.prepare("SELECT name FROM pragma_table_info('outbox')").all().some((column) => column.name === 'image')) {
    db.exec("ALTER TABLE outbox ADD COLUMN image TEXT NOT NULL DEFAULT ''");
  }

  const get = (assistantID, provider) => db.prepare(
    'SELECT * FROM channel WHERE assistant_id=? AND provider=?',
  ).get(assistantID, provider) ?? null;
  const patch = (epoch, values) => {
    const allowed = new Set(['target', 'generation', 'ordinal', 'status', 'error', 'updated_at']);
    const keys = Object.keys(values).filter((key) => allowed.has(key));
    if (!keys.length) return;
    db.prepare(`UPDATE channel SET ${keys.map((key) => `${key}=?`).join(',')} WHERE epoch=?`)
      .run(...keys.map((key) => values[key]), epoch);
  };
  const enqueue = (epoch, id, text, target = '', image = '') => db.prepare(
    'INSERT OR IGNORE INTO outbox(id,epoch,target,text,image) VALUES (?,?,?,?,?)',
  ).run(id, epoch, target, text, image);
  const dropChannelQueues = (epoch) => {
    db.prepare('DELETE FROM inbox WHERE epoch=?').run(epoch);
    db.prepare('DELETE FROM outbox WHERE epoch=?').run(epoch);
  };

  return {
    get,
    patch,
    listByAssistant: (assistantID) => db.prepare(
      'SELECT * FROM channel WHERE assistant_id=? ORDER BY provider',
    ).all(assistantID),
    listAll: () => db.prepare('SELECT * FROM channel ORDER BY assistant_id, provider').all(),
    bind: db.transaction((value) => {
      const account = db.prepare('SELECT assistant_id FROM channel WHERE provider=? AND client_id=?')
        .get(value.provider, value.client_id);
      if (account && account.assistant_id !== value.assistant_id) throw fail('account_in_use');
      const existing = get(value.assistant_id, value.provider);
      const epoch = randomUUID();
      if (existing) {
        const sameIdentity = existing.client_id === value.client_id && existing.owner_id === value.owner_id;
        if (sameIdentity) {
          // Keep durable dedup receipts and pending output across a credential or
          // language update; only rotate the generation/epoch fence.
          db.prepare('UPDATE inbox SET epoch=? WHERE epoch=?').run(epoch, existing.epoch);
          db.prepare('UPDATE outbox SET epoch=? WHERE epoch=?').run(epoch, existing.epoch);
        } else {
          // A different account or owner must not inherit the previous owner's
          // unprocessed inbound messages or queued replies.
          dropChannelQueues(existing.epoch);
        }
        db.prepare(`UPDATE channel SET epoch=?, client_id=?, client_secret=?, owner_id=?, language=?,
          target=?, generation=?, ordinal=?, status='connecting', error=NULL, updated_at=?
          WHERE assistant_id=? AND provider=?`).run(
          epoch, value.client_id, value.client_secret, value.owner_id, value.language,
          sameIdentity ? existing.target : '', value.generation, value.ordinal,
          value.updated_at, value.assistant_id, value.provider,
        );
      } else {
        db.prepare(`INSERT INTO channel(assistant_id,provider,epoch,client_id,client_secret,owner_id,
          language,target,generation,ordinal,status,error,updated_at)
          VALUES (@assistant_id,@provider,@epoch,@client_id,@client_secret,@owner_id,@language,
          '',@generation,@ordinal,'connecting',NULL,@updated_at)`).run({ ...value, epoch });
      }
      return get(value.assistant_id, value.provider);
    }),
    transfer: db.transaction(({ sourceAssistantID, assistantID, provider, revision, generation, ordinal, updatedAt }) => {
      const source = get(sourceAssistantID, provider);
      if (!source || source.epoch !== revision || get(assistantID, provider)) throw fail('binding_changed');
      const epoch = randomUUID();
      // Preserve dedup identities, never migrate the old Bot's work or replies.
      db.prepare("UPDATE inbox SET epoch=?,state='done',text='',payload='',target='' WHERE epoch=?").run(epoch, source.epoch);
      db.prepare('DELETE FROM outbox WHERE epoch=?').run(source.epoch);
      db.prepare(`UPDATE channel SET assistant_id=?,epoch=?,generation=?,ordinal=?,updated_at=?,status='connecting',error=NULL
        WHERE epoch=?`).run(assistantID, epoch, generation, ordinal, updatedAt, source.epoch);
      return get(assistantID, provider);
    }),
    accept: db.transaction((binding, messages) => {
      const current = get(binding.assistant_id, binding.provider);
      if (!current || current.epoch !== binding.epoch) return false;
      let inserted = false;
      let insertedTarget = '';
      for (const message of messages) {
        const result = db.prepare(
          'INSERT OR IGNORE INTO inbox(id,epoch,text,payload,target) VALUES (?,?,?,?,?)',
        ).run(message.id, binding.epoch, message.text, message.payload || '', message.target || '');
        if (result.changes) {
          inserted = true;
          if (message.target) insertedTarget = message.target;
        }
      }
      if (inserted && insertedTarget) {
        // A replayed platform message must not silently rewrite reply routing.
        db.prepare('UPDATE channel SET target=? WHERE epoch=?').run(insertedTarget, binding.epoch);
      }
      return inserted;
    }),
    pending: (epoch) => db.prepare(
      "SELECT * FROM inbox WHERE epoch=? AND state='pending' ORDER BY rowid LIMIT 20",
    ).all(epoch),
    backlog: (epoch) => db.prepare(
      "SELECT COUNT(*) AS count FROM inbox WHERE epoch=? AND state IN ('pending','admitted')",
    ).get(epoch).count,
    hasReceipt: (id) => Boolean(db.prepare('SELECT 1 FROM inbox WHERE id=? LIMIT 1').get(id)),
    receipt: (id, epoch) => typeof id === 'string' ? db.prepare('SELECT id,target FROM inbox WHERE id=? AND epoch=?').get(id, epoch) : undefined,
    markInbox: (id, state) => db.prepare('UPDATE inbox SET state=? WHERE id=?').run(state, id),
    finishTurn: (id) => db.prepare(
      "UPDATE inbox SET state='done',text='',payload='' WHERE id=?",
    ).run(id),
    recover: db.transaction((epoch, text) => {
      for (const row of db.prepare("SELECT id,target FROM inbox WHERE epoch=? AND state='admitted'").all(epoch)) {
        enqueue(epoch, `${row.id}:interrupted`, text, row.target);
        db.prepare("UPDATE inbox SET state='done',text='',payload='' WHERE id=?").run(row.id);
      }
      // A process exit during send cannot prove whether the platform accepted it.
      db.prepare("UPDATE outbox SET state='unknown' WHERE epoch=? AND state='sending'").run(epoch);
    }),
    recoverSending: (epoch) => db.prepare(
      "UPDATE outbox SET state='unknown' WHERE epoch=? AND state='sending'",
    ).run(epoch),
    collect: db.transaction((binding, page, deliveries, updatedAt) => {
      const current = get(binding.assistant_id, binding.provider);
      if (!current || current.epoch !== binding.epoch) return;
      // Transcript wipe starts a new generation; previous output must never be
      // delivered from the old transcript.
      if (current.generation !== page.generation) {
        db.prepare('DELETE FROM outbox WHERE epoch=?').run(binding.epoch);
      }
      for (const delivery of deliveries) {
        enqueue(binding.epoch, delivery.id, delivery.text, delivery.target ?? current.target ?? '', delivery.image ? JSON.stringify(delivery.image) : '');
      }
      db.prepare('UPDATE channel SET generation=?,ordinal=?,updated_at=? WHERE epoch=?')
        .run(page.generation, page.ordinal, updatedAt, binding.epoch);
    }),
    nextDelivery: (epoch) => db.prepare(
      "SELECT * FROM outbox WHERE epoch=? AND state='pending' ORDER BY sequence LIMIT 1",
    ).get(epoch),
    markDelivery: (id, state) => db.prepare('UPDATE outbox SET state=? WHERE id=?').run(state, id),
    sent: (id) => db.prepare("UPDATE outbox SET state='sent',text='',target='',image='' WHERE id=?").run(id),
    failDelivery: (id, maxAttempts = 3) => {
      const row = db.prepare('SELECT attempts FROM outbox WHERE id=?').get(id);
      if (!row) return;
      const attempts = row.attempts + 1;
      db.prepare('UPDATE outbox SET attempts=?,state=? WHERE id=?')
        .run(attempts, attempts >= maxAttempts ? 'blocked' : 'pending', id);
    },
    hasUnknown: (epoch) => Boolean(db.prepare(
      "SELECT 1 FROM outbox WHERE epoch=? AND state='unknown' LIMIT 1",
    ).get(epoch)),
    hasBlocked: (epoch) => Boolean(db.prepare(
      "SELECT 1 FROM outbox WHERE epoch=? AND state='blocked' LIMIT 1",
    ).get(epoch)),
    retry: (epoch) => db.prepare(
      "UPDATE outbox SET state='pending',attempts=0 WHERE epoch=? AND state='blocked'",
    ).run(epoch),
    unlink: db.transaction((assistantID, provider) => {
      const binding = get(assistantID, provider);
      if (!binding) return;
      dropChannelQueues(binding.epoch);
      db.prepare('DELETE FROM channel WHERE assistant_id=? AND provider=?').run(assistantID, provider);
    }),
    forget: db.transaction((assistantID) => {
      for (const row of db.prepare('SELECT epoch FROM channel WHERE assistant_id=?').all(assistantID)) {
        dropChannelQueues(row.epoch);
      }
      db.prepare('DELETE FROM channel WHERE assistant_id=?').run(assistantID);
    }),
    acquire: (owner, now) => Boolean(db.prepare(`INSERT INTO lease(id,owner,expires_at) VALUES (1,?,?)
      ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
      WHERE lease.owner=excluded.owner OR lease.expires_at<=?`).run(owner, now + 60_000, now).changes),
    owns: (owner, now) => Boolean(db.prepare(
      'SELECT 1 FROM lease WHERE id=1 AND owner=? AND expires_at>?',
    ).get(owner, now)),
    release: (owner) => db.prepare('DELETE FROM lease WHERE owner=?').run(owner),
    close: () => db.close(),
  };
}
