import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionMetadataStore, registerSessionMetadataRoutes } from './routes.js';
import { createSessionIndexService } from '../session-index/service.js';
import { projectSessionWithStoredMap } from './session-projection.js';

const tempDirs = [];

const makeDataDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuri-metadata-routes-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

const mount = (overrides = {}) => {
  const store = overrides.sessionMetadataStore
    ?? createSessionMetadataStore({ dataDir: makeDataDir() });
  const broadcastGlobalUiEvent = overrides.broadcastGlobalUiEvent ?? vi.fn();
  const app = express();
  registerSessionMetadataRoutes(app, {
    sessionMetadataStore: store,
    sessionArchiveService: overrides.sessionArchiveService ?? null,
    broadcastGlobalUiEvent,
    onMetadataWritten: overrides.onMetadataWritten,
  });
  return { app, store, broadcastGlobalUiEvent };
};

describe('registerSessionMetadataRoutes', () => {
  it('merge-patches metadata and broadcasts the full merged object', async () => {
    const { app, store, broadcastGlobalUiEvent } = mount();

    const first = await request(app)
      .put('/api/yuri/sessions/ses_1/metadata')
      .send({ patch: { yuri: { assist: { recap: 'a' } } } })
      .expect(200);
    expect(first.body.metadata).toEqual({ yuri: { assist: { recap: 'a' } } });

    const second = await request(app)
      .put('/api/yuri/sessions/ses_1/metadata')
      .send({ patch: { yuri: { goal: { status: 'active' } } }, directory: '/repo' })
      .expect(200);
    expect(second.body.metadata).toEqual({
      yuri: { assist: { recap: 'a' }, goal: { status: 'active' } },
    });
    await expect(store.get('ses_1')).resolves.toEqual(second.body.metadata);
    expect(broadcastGlobalUiEvent).toHaveBeenLastCalledWith({
      type: 'yuri:session-metadata',
      properties: { sessionID: 'ses_1', metadata: second.body.metadata },
    });
  });

  it('notifies the metadata listener with the session directory', async () => {
    const onMetadataWritten = vi.fn();
    const { app } = mount({ onMetadataWritten });

    await request(app)
      .put('/api/yuri/sessions/ses_2/metadata')
      .send({ patch: { yuri: { goal: { id: 'g1', status: 'active', objective: 'ship' } } }, directory: '/repo' })
      .expect(200);

    expect(onMetadataWritten).toHaveBeenCalledWith({
      sessionID: 'ses_2',
      directory: '/repo',
      metadata: {
        yuri: {
          goal: { id: 'g1', status: 'active', objective: 'ship' },
        },
      },
    });
  });

  it('persists scheduled-fork detachment through the Host route and directory index rebuild', async () => {
    const dataDir = makeDataDir();
    const metadata = { custom: { keep: true }, yuri: {
      scheduledTask: { taskID: 'task-1', runID: 'run-1' },
      titleRefresh: { activityUpdatedAt: 10 },
    } };
    const source = { id: 'ses_source', title: '[Scheduled] Morning Sync', location: { directory: '/repo' }, time: { created: 1, updated: 10 }, metadata };
    const fork = { ...source, id: 'ses_fork', title: 'Morning Sync (fork #1)', time: { created: 20, updated: 20 },
      fork: { sessionID: source.id, boundary: { type: 'through', messageID: 'msg_last' } } };
    const records = new Map([source, fork].map((session) => [session.id, structuredClone(session)]));
    const storeOptions = {
      dataDir,
      recordReader: async (id) => structuredClone(records.get(id)),
      recordWriter: async (id, next) => { records.set(id, { ...records.get(id), metadata: structuredClone(next) }); },
    };
    const store = createSessionMetadataStore(storeOptions);
    const { app } = mount({ sessionMetadataStore: store });
    const indexOptions = { dbPath: path.join(dataDir, 'session-index.sqlite') };
    const index = createSessionIndexService(indexOptions);
    try {
      // Renaming alone leaves both records excluded, even after a refresh.
      index.replaceDirectory({ directory: '/repo', sessions: [...records.values()] });
      expect(index.snapshot().directories[0].sessions).toEqual([]);
      await store.setSessionMetadata(fork.id, metadata);

      const response = await request(app).put('/api/yuri/sessions/ses_fork/metadata')
        .send({ directory: '/repo', patch: { yuri: { scheduledTask: null } } }).expect(200);

      expect(response.body.metadata).toEqual({ custom: metadata.custom, yuri: { titleRefresh: metadata.yuri.titleRefresh } });
      const reopenedStore = createSessionMetadataStore(storeOptions);
      await expect(reopenedStore.get(fork.id)).resolves.toEqual(response.body.metadata);
      expect(records.get(source.id)).toEqual(source);
      index.replaceDirectory({ directory: '/repo', sessions: [...records.values()].map((session) =>
        projectSessionWithStoredMap(session, reopenedStore.getSnapshotSync())) });
      expect(index.snapshot().directories[0].sessions.map((session) => session.id)).toEqual([fork.id]);
    } finally { index.close(); }
    const reopenedIndex = createSessionIndexService(indexOptions);
    try {
      expect(reopenedIndex.snapshot().directories[0].sessions.map((session) => session.id)).toEqual([fork.id]);
    } finally { reopenedIndex.close(); }
  });

  it('rejects a blank session id and a non-object patch with 400', async () => {
    const { app } = mount();
    await request(app)
      .put('/api/yuri/sessions/%20%20/metadata')
      .send({ patch: { a: 1 } })
      .expect(400);
    await request(app)
      .put('/api/yuri/sessions/ses_1/metadata')
      .send({})
      .expect(400);
    await request(app)
      .put('/api/yuri/sessions/ses_1/metadata')
      .send({ patch: 'nope' })
      .expect(400);
    await request(app)
      .put('/api/yuri/sessions/ses_1/metadata')
      .send({ patch: ['a'] })
      .expect(400);
  });

  it('does not answer a failed store load as empty success', async () => {
    const store = {
      setSessionMetadata: async () => {
        throw new Error('session metadata is unavailable: its file could not be read');
      },
    };
    const { app } = mount({ sessionMetadataStore: store });
    const res = await request(app)
      .put('/api/yuri/sessions/ses_1/metadata')
      .send({ patch: { a: 1 } })
      .expect(503);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/could not be read/) });
  });

  it('archives via PUT /archive and returns the projected session', async () => {
    const setArchive = vi.fn(async ({ sessionID, archivedAt }) => ({
      session: {
        id: sessionID,
        title: 'Alpha',
        directory: '/repo',
        time: { created: 1, updated: 2, archived: archivedAt },
        metadata: { yuri: { archive: { archivedAt } } },
      },
    }));
    const { app } = mount({
      sessionArchiveService: { setArchive },
    });

    const res = await request(app)
      .put('/api/yuri/sessions/ses_1/archive')
      .send({ archivedAt: 99, directory: '/repo' })
      .expect(200);

    expect(setArchive).toHaveBeenCalledWith({
      sessionID: 'ses_1',
      archivedAt: 99,
      directory: '/repo',
    });
    expect(res.body.session).toMatchObject({
      id: 'ses_1',
      time: { archived: 99 },
    });
  });

  it('rejects archive without a finite archivedAt', async () => {
    const { app } = mount({
      sessionArchiveService: { setArchive: vi.fn() },
    });
    await request(app)
      .put('/api/yuri/sessions/ses_1/archive')
      .send({})
      .expect(400);
  });
});
