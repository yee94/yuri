import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { registerContactAttachmentRoutes } from './routes.js';
import { createAssistantsService } from './service.js';
import { registerCommonRequestMiddleware } from '../opencode/core-routes.js';

const closers = [];
afterEach(async () => { while (closers.length) await closers.pop()(); });
const bytes = Buffer.from('{"synthetic":"original"}');
const headers = { 'content-type': 'application/json', 'x-content-sha256': createHash('sha256').update(bytes).digest('hex'), 'x-content-size': String(bytes.length), 'x-attachment-filename': 'payload.json', accept: 'application/vnd.yuri.contact-upload+json' };
const stream = () => ({ async *[Symbol.asyncIterator]() { yield bytes; } });
function fixture(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'contact-routes-'));
  closers.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const service = createAssistantsService({
    dbPath: path.join(directory, 'assistants.sqlite'), dataDir: directory,
    getAllowedRoots: () => [directory], listProjects: async () => [],
    buildOpenCodeUrl: () => { throw new Error('No Host access permitted'); },
    getOpenCodeAuthHeaders: () => ({}), clientFactory: () => { throw new Error('No engine access permitted'); },
    runContactTurn: async () => ({ text: 'synthetic completion', bubbles: ['synthetic completion'] }),
    ...overrides,
  });
  closers.push(() => service.close());
  const assistant = service.createAssistant({ name: 'Synthetic', providerID: 'synthetic', modelID: 'synthetic' });
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  registerContactAttachmentRoutes(app, service);
  const prefix = `/api/yuri/assistants/${assistant.id}/contact/attachments`;
  // IncomingMessage + ServerResponse run the real Express router/body middleware without a socket or listener.
  const request = (method, url, input = {}) => new Promise((resolve, reject) => {
    const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
    const req = new IncomingMessage(socket);
    req.method = method; req.url = url;
    const body = input.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(input.body) ? input.body : Buffer.from(JSON.stringify(input.body));
    req.headers = { ...(input.body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(body.length) }), ...input.headers };
    const res = new ServerResponse(req);
    res.end = function(chunk) {
      const buffer = Buffer.from(chunk || '');
      const contentType = String(this.getHeader('content-type') || '');
      const value = contentType.includes('application/json') && buffer.length ? JSON.parse(buffer.toString()) : buffer;
      resolve({ status: this.statusCode, headers: this.getHeaders(), body: value, bytes: buffer });
      socket.destroy();
      return this;
    };
    app.handle(req, res, error => error ? reject(error) : resolve({ status: 404 }));
    req.push(body); req.push(null);
  });
  return { directory, service, assistant, prefix, request };
}

describe('production contact attachment HTTP contract without networking', () => {
  it('captures authority from contact/messages, routes receipt JSON separately from raw content and validates modern PUT', async () => {
    const f = fixture();
    const generation = f.service.contactMessages(f.assistant.id, { limit: 1 }).generation;
    expect(generation).toBe(0);
    const missing = await f.request('GET', `${f.prefix}/uploads/u1?generation=0`);
    expect(missing).toMatchObject({ status: 404, body: { state: 'not_found', generation: 0, currentGeneration: 0, descriptor: null } });
    expect(missing.headers['cache-control']).toBe('private, no-store');
    expect((await f.request('GET', `${f.prefix}/uploads/u1`)).status).toBe(400);
    for (const query of ['generation=false', 'generation=0&generation=0', 'generation=1.5', 'generation=9007199254740992', 'generation=']) {
      expect((await f.request('PUT', `${f.prefix}/u1?${query}`, { headers, body: bytes })).status).toBe(400);
    }
    expect((await f.request('PUT', `${f.prefix}/u1`, { headers, body: bytes })).status).toBe(400);
    const put = await f.request('PUT', `${f.prefix}/u1?generation=${generation}`, { headers, body: bytes });
    expect(put).toMatchObject({ status: 201, body: { type: 'file', generation: 0, size: bytes.length, mime: 'application/json' } });
    const receipt = await f.request('GET', `${f.prefix}/uploads/u1?generation=0`);
    expect(receipt).toMatchObject({ status: 200, body: { state: 'committed', descriptor: put.body, generation: 0, currentGeneration: 0 } });
    const content = await f.request('GET', `${f.prefix}/${put.body.attachmentID}`);
    expect(content.status).toBe(200);
    expect(content.bytes).toEqual(bytes);
    expect(content.headers.etag).toContain(headers['x-content-sha256']);
    expect((await f.request('GET', `${f.prefix}/u1`)).status).toBe(404);
    expect((await f.request('DELETE', `${f.prefix}/${put.body.attachmentID}`, { body: { generation: 0, descriptor: put.body } })).status).toBe(404);
    const retired = await f.request('DELETE', `${f.prefix}/uploads/u1`, { body: { generation: 0, descriptor: put.body } });
    expect(retired).toMatchObject({ status: 200, body: { state: 'retired', descriptor: put.body, newAdmissionAllowed: false, ownershipRetained: true, bytesDeleted: false } });
    expect((await f.request('GET', `${f.prefix}/${put.body.attachmentID}`)).bytes).toEqual(bytes);
    expect((await f.request('PUT', `${f.prefix}/u1?generation=0`, { headers, body: bytes }))).toMatchObject({ status: 409, body: { error: 'attachment_retired' } });
  });

  it('preserves old PUTs, rejects stale new intent, validates DELETE CAS and prevents not-found uploads from reviving', async () => {
    const f = fixture();
    const oldHeaders = { ...headers }; delete oldHeaders.accept;
    f.service.resetContact(f.assistant.id);
    expect(await f.request('PUT', `${f.prefix}/old`, { headers: oldHeaders, body: bytes })).toMatchObject({ status: 201, body: { generation: 1 } });
    expect(await f.request('PUT', `${f.prefix}/new?generation=0`, { headers, body: bytes })).toMatchObject({ status: 409, body: { error: 'contact_generation_conflict' } });
    for (const body of [{ generation: false, descriptor: null }, { generation: [1], descriptor: null }, { generation: '1', descriptor: null }, { generation: 1 }, { generation: 1, descriptor: false }, { generation: 1, descriptor: null, sha256: headers['x-content-sha256'] }]) {
      expect((await f.request('DELETE', `${f.prefix}/uploads/new`, { body })).status).toBe(400);
    }
    expect(await f.request('DELETE', `${f.prefix}/uploads/new`, { body: { generation: 0, descriptor: null } })).toMatchObject({ status: 200, body: { state: 'retired', generation: 0, currentGeneration: 1, descriptor: null, bytesDeleted: false } });
    expect(await f.request('PUT', `${f.prefix}/new?generation=1`, { headers, body: bytes })).toMatchObject({ status: 409, body: { error: 'contact_generation_conflict' } });
    expect(await f.request('GET', `${f.prefix}/uploads/new?generation=0`)).toMatchObject({ status: 200, body: { state: 'retired' } });
    expect(await f.request('GET', `${f.prefix}/uploads/new?generation=1`)).toMatchObject({ status: 409, body: { error: 'contact_generation_conflict' } });
  });

  it('already-admitted turns retain references and replay receipts while new intents cannot admit retired attachments', async () => {
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    closers.push(() => finish());
    const f = fixture({ runContactTurn: async () => { await done; return { text: 'done', bubbles: ['done'] }; } });
    const descriptor = await f.service.putAssistantContactAttachment(f.assistant.id, 'claimed', { expectedGeneration: 0, stream: stream(), headers });
    for (const generation of [false, null, [0], '0', -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(f.service.send(f.assistant.id, { messageID: 'invalid-generation', parts: [{ ...descriptor, generation }] })).rejects.toMatchObject({ code: 'validation_error' });
    }
    const input = { messageID: 'claimed-message', parts: [{ type: 'text', text: 'keep original reference' }, descriptor] };
    expect(await f.service.send(f.assistant.id, input)).toMatchObject({ admitted: true });
    expect(f.service.retireAssistantContactAttachment(f.assistant.id, 'claimed', { generation: 0, descriptor })).toMatchObject({ ownershipRetained: true, bytesDeleted: false });
    expect(await f.service.send(f.assistant.id, input)).toMatchObject({ admitted: true, replayed: true });
    await expect(f.service.send(f.assistant.id, { ...input, messageID: 'new-intent' })).rejects.toMatchObject({ code: 'not_found' });
    expect((await f.service.getAssistantContactAttachment(f.assistant.id, descriptor.attachmentID)).buffer).toEqual(bytes);
    finish();
    expect(await f.service.whenContactTurnSettled(input.messageID)).toMatchObject({ status: 'complete' });
  });

  it('peer new admission also rejects retired attachment references without breaking an admitted peer replay', async () => {
    const f = fixture();
    const sender = f.service.createAssistant({ name: 'Sender', providerID: 'synthetic', modelID: 'synthetic' });
    const descriptor = await f.service.putAssistantContactAttachment(f.assistant.id, 'peer-upload', { expectedGeneration: 0, stream: stream(), headers });
    const input = { toAssistantID: f.assistant.id, messageID: 'peer-reference', parts: [descriptor] };
    expect(await f.service.deliverPeerMessage(sender.id, input)).toMatchObject({ admitted: true });
    f.service.retireAssistantContactAttachment(f.assistant.id, 'peer-upload', { generation: 0, descriptor });
    expect(await f.service.deliverPeerMessage(sender.id, input)).toMatchObject({ admitted: true, replayed: true });
    expect(() => f.service.deliverPeerMessage(sender.id, { ...input, messageID: 'peer-new-intent' })).toThrow(expect.objectContaining({ code: 'not_found' }));
    await f.service.whenContactTurnSettled(input.messageID);
  });

  it('retirement while admission awaits the project catalog is rechecked inside the admission transaction', async () => {
    let entered, release;
    const atCatalog = new Promise(resolve => { entered = resolve; });
    const catalog = new Promise(resolve => { release = resolve; });
    closers.push(() => release([]));
    const f = fixture({ listProjects: async () => { entered(); return catalog; } });
    const before = f.service.contactMessages(f.assistant.id).messages;
    const descriptor = await f.service.putAssistantContactAttachment(f.assistant.id, 'race', { expectedGeneration: 0, stream: stream(), headers });
    const send = f.service.send(f.assistant.id, { messageID: 'race-message', parts: [descriptor] });
    await atCatalog;
    f.service.retireAssistantContactAttachment(f.assistant.id, 'race', { generation: 0, descriptor });
    release([]);
    await expect(send).rejects.toMatchObject({ code: 'not_found' });
    expect(f.service.contactMessages(f.assistant.id).messages).toEqual(before);
  });

  it('exposes inflight over the production receipt route and fences DELETE before body completion', async () => {
    const f = fixture();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const flight = f.service.putAssistantContactAttachment(f.assistant.id, 'pending', {
      expectedGeneration: 0, headers, stream: { async *[Symbol.asyncIterator]() { await gate; yield bytes; } },
    });
    expect(await f.request('GET', `${f.prefix}/uploads/pending?generation=0`)).toMatchObject({ status: 200, body: { state: 'inflight', descriptor: null, generation: 0, currentGeneration: 0 } });
    expect(await f.request('PUT', `${f.prefix}/pending?generation=0`, { headers, body: bytes })).toMatchObject({ status: 409, body: { error: 'attachment_upload_inflight' } });
    expect(await f.request('DELETE', `${f.prefix}/uploads/pending`, { body: { generation: 0, descriptor: null } })).toMatchObject({ status: 200, body: { state: 'retired', descriptor: null } });
    release();
    await expect(flight).rejects.toMatchObject({ code: 'attachment_retired' });
    expect(await f.request('GET', `${f.prefix}/uploads/pending?generation=0`)).toMatchObject({ status: 200, body: { state: 'retired', descriptor: null } });
  });
});
