import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { createAssistantsService } from './service.js';

const require = createRequire(import.meta.url);
const call = (name, args) => ({ completion: { choices: [{ message: { content: '', tool_calls: [
  { id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
] } }] } });
const task = (schedule) => ({ id: 'task', name: 'Review', enabled: true, schedule, execution: { prompt: 'Review notes', providerID: 'p', modelID: 'm' } });
const cards = (service, id) => service.contactMessages(id, { limit: 50 }).messages.flatMap((message) => message.cards);
const fixture = (options = {}) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resource-reference-')));
  const client = {
    session: {
      get: vi.fn(async ({ sessionID }) => ({ id: sessionID, directory, title: 'Actual conversation', status: { type: 'busy' } })),
      create: vi.fn(async () => ({ id: 'ses_created' })),
      prompt: vi.fn(async () => ({ id: 'inbox_created', type: 'user' })),
      active: async () => ({}),
    },
    message: { list: vi.fn(async () => ({ data: [{ info: { id: 'msg', role: 'user', sessionID: 'ses_found' }, parts: [{ type: 'text', text: 'Discuss the release plan.' }] }], cursor: {} })) },
    provider: { list: async () => ({ data: [] }) }, model: { list: async () => ({ data: [] }) },
  };
  let service;
  const open = (extra = {}) => {
    service = createAssistantsService({
      dbPath: path.join(directory, 'assistants.sqlite'), dataDir: directory,
      getAllowedRoots: () => [directory], listProjects: async () => [{ id: 'project', path: directory }],
      buildOpenCodeUrl: () => 'http://upstream.invalid', getOpenCodeAuthHeaders: () => ({}),
      clientFactory: () => client, ...options, ...extra,
    });
    return service;
  };
  open();
  const host = service.createAssistant({ name: 'Host', providerID: 'p', modelID: 'm' });
  return { directory, client, host, get service() { return service; }, open,
    async send(text = 'Show the matching resources') {
      const admitted = await service.send(host.id, { messageID: `turn_${Date.now()}`, text });
      return service.whenContactTurnSettled(admitted.messageID);
    },
    close() { service.close(); fs.rmSync(directory, { recursive: true, force: true }); },
  };
};

describe('explicit resource references through the real contact Agent and SQLite', () => {
  it('looks up a conversation and tasks, references both, acknowledges persistence and survives restart without watches', async () => {
    let round = 0;
    let f;
    const complete = vi.fn(async ({ body }) => {
      round++;
      if (round === 1) return call('list_sessions', { query: 'release' });
      if (round === 2) {
        expect(body.messages.find((message) => message.name === 'list_sessions')?.content).toContain('ses_found');
        return call('read_session', { sessionID: 'ses_found' });
      }
      if (round === 3) {
        expect(body.messages.find((message) => message.name === 'read_session')?.content).toContain('release plan');
        return call('reference_resource', { cardType: 'session', sessionID: 'ses_found', projectID: 'project' });
      }
      if (round === 4) {
        expect(cards(f.service, f.host.id)).toHaveLength(1);
        expect(body.messages.find((message) => message.name === 'reference_resource')?.content).toContain('sent');
        return call('list_scheduled_tasks', {});
      }
      if (round === 5) return call('reference_resource', { cardType: 'schedule', projectID: 'project', taskID: 'task' });
      expect(cards(f.service, f.host.id)).toHaveLength(2);
      return { text: '这个会话在讨论发布计划；定时任务会检查笔记。' };
    });
    f = fixture({ createChatCompletion: complete,
      sessionIndexService: { snapshot: () => ({ directories: [{ directory: f.directory, sessions: [{ id: 'ses_found', title: 'Release', time: { updated: 1 } }] }] }) },
      listScheduledTasks: async () => [task({ kind: 'cron', cron: '0 9 * * 1', timezone: 'UTC' })],
    });
    try {
      expect(await f.send('帮我看一下定时任务并列出来，也看看发布会话是做什么的')).toMatchObject({ status: 'complete' });
      expect(complete).toHaveBeenCalledTimes(6);
      const published = cards(f.service, f.host.id);
      expect(published).toEqual([
        expect.objectContaining({ cardType: 'session', sessionID: 'ses_found', title: 'Actual conversation' }),
        expect.objectContaining({ cardType: 'schedule', taskID: 'task', projectID: 'project', cron: '0 9 * * 1' }),
      ]);
      expect(f.service.snapshot().assistants[0].assignedSessionIDs).toEqual([]);
      expect(f.client.session.create).not.toHaveBeenCalled();
      expect(f.client.session.prompt).not.toHaveBeenCalled();
      f.service.close(); f.open();
      expect(cards(f.service, f.host.id)).toEqual(published);
      expect(f.service.snapshot().assistants[0].assignedSessionIDs).toEqual([]);
    } finally { f.close(); }
  });

  it.each([
    { kind: 'cron', cron: '0 9 1 * *', timezone: 'UTC' },
    { kind: 'once', date: '2026-12-01', time: '09:00', timezone: 'UTC' },
    { kind: 'weekly', times: ['09:00', '18:00'], weekdays: [1, 3], timezone: 'UTC' },
  ])('creates then explicitly references a task with its complete $kind schedule', async (schedule) => {
    let saved;
    let round = 0;
    let f;
    f = fixture({
      upsertScheduledTask: async (_projectID, input) => { saved = { ...input, id: 'task', schedule }; return { task: saved }; },
      listScheduledTasks: async () => saved ? [saved] : [],
      createChatCompletion: async ({ body }) => {
        round++;
        if (round === 1) return call('load_tools', { domain: 'yuri.tasks' });
        if (round === 2) return call('schedule_task', { name: 'Review', prompt: 'Review notes', time: '09:00', timezone: 'UTC' });
        if (round === 3) {
          expect(cards(f.service, f.host.id)).toEqual([]);
          expect(body.messages.find((message) => message.name === 'schedule_task')?.content).toContain('reference_resource');
          return call('reference_resource', { cardType: 'schedule', projectID: 'project', taskID: 'task' });
        }
        expect(cards(f.service, f.host.id)).toHaveLength(1);
        return { text: '定时任务已创建，卡片发给你了。' };
      },
    });
    try {
      expect(await f.send('Create the requested task')).toMatchObject({ status: 'complete' });
      expect(cards(f.service, f.host.id)[0]).toMatchObject(schedule);
      expect(f.service.snapshot().assistants[0].assignedSessionIDs).toEqual([]);
    } finally { f.close(); }
  });

  it('keeps assignment watches independent and limits the result phase to explicit reference calls', async () => {
    let round = 0;
    let f;
    f = fixture({ createChatCompletion: async ({ body }) => {
      round++;
      if (round === 1) return call('assign_session', { prompt: 'Review release plan', projectPath: f.directory });
      expect(body.tools.map((tool) => tool.function.name)).toEqual(['reference_resource']);
      if (round === 2) {
        expect(cards(f.service, f.host.id)).toEqual([]);
        expect(f.service.snapshot().assistants[0].assignedSessionIDs).toEqual(['ses_created']);
        return call('assign_session', { prompt: 'Accidental duplicate', projectPath: f.directory });
      }
      if (round === 3) {
        expect(body.messages.at(-1).content).toContain('not an available tool');
        return call('reference_resource', { cardType: 'session', sessionID: 'ses_created' });
      }
      expect(body.messages.find((message) => message.name === 'reference_resource')?.content).toContain('sent');
      return { text: '已交给工作会话，卡片在这里。' };
    } });
    try {
      expect(await f.send('Open a session to review release plan')).toMatchObject({ status: 'complete' });
      expect(f.client.session.create).toHaveBeenCalledTimes(1);
      expect(f.client.session.prompt).toHaveBeenCalledTimes(1);
      expect(cards(f.service, f.host.id)).toHaveLength(1);
      expect(f.service.snapshot().assistants[0].assignedSessionIDs).toEqual(['ses_created']);
    } finally { f.close(); }
  });

  it('creates a Bot without auto-publishing, then explicitly references its stored identity', async () => {
    let round = 0;
    let f;
    f = fixture({ createChatCompletion: async ({ body }) => {
      round++;
      if (round === 1) return call('load_tools', { domain: 'yuri.assistants' });
      if (round === 2) return call('create_assistant', { name: 'Peer' });
      if (round === 3) {
        expect(cards(f.service, f.host.id)).toEqual([]);
        const result = JSON.parse(JSON.parse(body.messages.find((message) => message.name === 'create_assistant').content).content);
        return call('reference_resource', result.reference);
      }
      return { text: '新助理已创建。' };
    } });
    try {
      expect(await f.send('Create a Bot named Peer')).toMatchObject({ status: 'complete' });
      const peer = f.service.snapshot().assistants.find((assistant) => assistant.name === 'Peer');
      expect(cards(f.service, f.host.id)).toEqual([expect.objectContaining({ cardType: 'assistant', assistantID: peer.id, name: 'Peer' })]);
    } finally { f.close(); }
  });

  it('updates an existing task without an implicit card, then references the new authoritative values', async () => {
    let saved = task({ kind: 'daily', time: '09:00', timezone: 'UTC' });
    let round = 0;
    let f;
    const patch = vi.fn(async (_project, _task, changes) => { saved = { ...saved, ...changes }; return { task: saved }; });
    f = fixture({ listScheduledTasks: async () => [saved], patchScheduledTask: patch,
      createChatCompletion: async ({ body }) => {
        round++;
        if (round === 1) return call('load_tools', { domain: 'yuri.tasks' });
        if (round === 2) return call('update_scheduled_task', { projectID: 'project', taskID: 'task', name: 'Updated review' });
        if (round === 3) {
          expect(cards(f.service, f.host.id)).toEqual([]);
          const result = JSON.parse(JSON.parse(body.messages.find((message) => message.name === 'update_scheduled_task').content).content);
          return call('reference_resource', result.reference);
        }
        return { text: '任务已修改。' };
      },
    });
    try {
      expect(await f.send('Rename the existing task')).toMatchObject({ status: 'complete' });
      expect(patch).toHaveBeenCalledTimes(1);
      expect(cards(f.service, f.host.id)).toEqual([expect.objectContaining({ cardType: 'schedule', name: 'Updated review' })]);
    } finally { f.close(); }
  });

  it('keeps admitted work successful with an explicit watch-storage warning and never duplicates it', async () => {
    let db;
    let round = 0;
    let f;
    f = fixture({ createChatCompletion: async ({ body }) => {
      round++;
      if (round === 1) return call('assign_session', { projectPath: f.directory, prompt: 'Review notes' });
      expect(body.tools.map((tool) => tool.function.name)).toEqual(['reference_resource']);
      expect(body.messages.find((message) => message.name === 'assign_session')?.content).toContain('watch_registration_failed');
      return { text: '会话已启动，但自动跟进没有注册成功。' };
    } });
    db = new (require('better-sqlite3'))(path.join(f.directory, 'assistants.sqlite'));
    try {
      db.exec("CREATE TRIGGER reject_watch BEFORE INSERT ON assistant_contact_watch BEGIN SELECT RAISE(ABORT, 'watch write failed'); END");
      expect(await f.send('Open a session')).toMatchObject({ status: 'complete' });
      expect(f.client.session.create).toHaveBeenCalledTimes(1);
      expect(f.client.session.prompt).toHaveBeenCalledTimes(1);
      expect(cards(f.service, f.host.id)).toEqual([]);
      expect(f.service.snapshot().assistants[0].assignedSessionIDs).toEqual([]);
    } finally { db.close(); f.close(); }
  });

  it('rejects a late reference after its user turn was wiped', async () => {
    let f;
    let result;
    f = fixture({ runContactTurn: async ({ tools }) => {
      f.service.resetContact(f.host.id, {});
      result = await tools.find((tool) => tool.name === 'reference_resource').execute('late', { cardType: 'session', sessionID: 'ses_found' });
      return { text: '引用已失效。', bubbles: ['引用已失效。'] };
    } });
    try {
      expect(await f.send()).toMatchObject({ status: 'complete' });
      expect(result).toMatchObject({ isError: true, details: { error: 'validation_error' } });
      expect(cards(f.service, f.host.id)).toEqual([]);
    } finally { f.close(); }
  });

  it('reports publication failure, retries safely, deduplicates references, and never rearms a cancelled watch', async () => {
    const results = [];
    let db;
    const f = fixture({ runContactTurn: async ({ tools }) => {
      const reference = tools.find((tool) => tool.name === 'reference_resource');
      const input = { cardType: 'session', sessionID: 'ses_found' };
      db.exec("CREATE TRIGGER reject_reference BEFORE INSERT ON assistant_contact_part WHEN json_extract(NEW.part_json, '$.type')='card' BEGIN SELECT RAISE(ABORT, 'card write failed'); END");
      results.push(await reference.execute('failed', input));
      db.exec('DROP TRIGGER reject_reference');
      results.push(await reference.execute('retry', input));
      results.push(await reference.execute('duplicate', input));
      return { text: '卡片已发送。', bubbles: ['卡片已发送。'] };
    } });
    db = new (require('better-sqlite3'))(path.join(f.directory, 'assistants.sqlite'));
    try {
      f.service.appendContactCard(f.host.id, { cardType: 'session', sessionID: 'ses_found', directory: f.directory, status: 'busy' });
      f.service.reportAssignedSessionSettle('ses_found', 'cancelled', false);
      expect(await f.send()).toMatchObject({ status: 'complete' });
      expect(results[0]).toMatchObject({ isError: true, details: { error: 'reference_failed' } });
      expect(results[0].details.card).toBeUndefined();
      expect(results.slice(1).every((result) => result.details.sent === true)).toBe(true);
      expect(cards(f.service, f.host.id)).toHaveLength(2);
      expect(db.prepare('SELECT active, status FROM assistant_contact_watch').get()).toMatchObject({ active: 0, status: 'cancelled' });
    } finally { db.close(); f.close(); }
  });

  it('fails closed on deleted, forbidden and unavailable resources without fabricating cards', async () => {
    const results = [];
    const f = fixture({ listScheduledTasks: async () => { throw new Error('unavailable'); },
      runContactTurn: async ({ tools }) => {
        const reference = tools.find((tool) => tool.name === 'reference_resource');
        for (const input of [
          { cardType: 'assistant', assistantID: 'deleted' },
          { cardType: 'session', sessionID: 'ses_forbidden' },
          { cardType: 'session', sessionID: 'ses_forbidden', projectID: 'project' },
          { cardType: 'schedule', projectID: 'project', taskID: 'task' },
          { cardType: 'schedule', projectID: 'unregistered', taskID: 'task' },
          { cardType: 'session', sessionID: 'ses_found', directory: '/forged' },
        ]) results.push(await reference.execute('invalid', input));
        return { text: '这些卡片暂时无法发送。', bubbles: ['这些卡片暂时无法发送。'] };
      },
    });
    f.client.session.get.mockImplementation(async ({ sessionID }) => ({ id: sessionID, directory: path.dirname(f.directory) }));
    try {
      expect(await f.send()).toMatchObject({ status: 'complete' });
      expect(results.every((result) => result.isError && !result.details.sent && !result.details.card)).toBe(true);
      expect(cards(f.service, f.host.id)).toEqual([]);
      expect(f.client.session.prompt).not.toHaveBeenCalled();
    } finally { f.close(); }
  });
});
