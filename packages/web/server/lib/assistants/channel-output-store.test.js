import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { createAssistantChannelStore } from './channels/store.js';
import { createWeixinStore } from './weixin/store.js';

const Database = createRequire(import.meta.url)('better-sqlite3');
describe.each(['weixin', 'enterprise'])('%s durable image outbox', (kind) => {
  it('migrates text-only queues and preserves image snapshots through restart/unknown recovery', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuri-image-outbox-'));
    const filename = path.join(directory, 'channel.sqlite');
    const legacy = new Database(filename);
    legacy.exec(`CREATE TABLE outbox(id TEXT NOT NULL UNIQUE,epoch TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',sequence INTEGER PRIMARY KEY AUTOINCREMENT${kind === 'enterprise' ? ",target TEXT NOT NULL DEFAULT '',attempts INTEGER NOT NULL DEFAULT 0" : ''});`);
    legacy.close();
    const create = kind === 'weixin' ? createWeixinStore : createAssistantChannelStore;
    let store = create(directory);
    try {
      const binding = store.bind(kind === 'weixin'
        ? { assistant_id: 'bot', account_id: 'account', peer_id: 'owner', token: 'test', base_url: 'https://ilinkai.weixin.qq.com', language: 'en', generation: 0, ordinal: 0, updated_at: 1 }
        : { assistant_id: 'bot', provider: 'feishu', client_id: 'client', client_secret: 'test', owner_id: 'owner', language: 'en', generation: 0, ordinal: 0, updated_at: 1 });
      const image = { attachmentID: 'att_snapshot', mime: 'image/png', size: 68 };
      store.collect(binding, { generation: 0, ordinal: 1 }, [{ id: 'image', text: '', image }, { id: 'later', text: 'later' }], 1);
      expect(JSON.parse(store.nextDelivery(binding.epoch).image)).toEqual(image);
      store.close();
      store = create(directory);
      expect(JSON.parse(store.nextDelivery(binding.epoch).image)).toEqual(image);
      store.markDelivery('image', 'sending');
      store.close();
      store = create(directory);
      store.recover(binding.epoch, 'interrupted');
      expect(store.hasUnknown(binding.epoch)).toBe(true);
      expect(store.nextDelivery(binding.epoch).id).toBe('later');
      store.sent('later');
      expect(store.nextDelivery(binding.epoch)).toBeUndefined();
      store.collect(store.get('bot', 'feishu'), { generation: 1, ordinal: 0 }, [], 2);
      expect(store.hasUnknown(binding.epoch)).toBe(false);
    } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
