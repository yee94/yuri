import { expect, test } from 'vitest';
import { observeTerminalFrame } from './terminal-frame-observer.mjs';

const binary = body => ({ opcode: 2, payloadData: Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(body))]).toString('base64') });

test('observes the real tagged binary ok/b/bok protocol without injecting a bind', () => {
  expect(observeTerminalFrame(binary({ t: 'ok', v: 2 }))).toMatchObject({ type: 'ok', version: 2 });
  expect(observeTerminalFrame(binary({ t: 'b', s: 'fixture-session', v: 2 }))).toMatchObject({ type: 'b', sessionId: 'fixture-session' });
  expect(observeTerminalFrame(binary({ t: 'bok', s: 'fixture-session', v: 2 }))).toMatchObject({ type: 'bok', sessionId: 'fixture-session' });
});

test('records only control metadata and hashes, never terminal text, unknown fields or credentials', () => {
  const row = observeTerminalFrame(binary({ t: 'd', s: 'fixture', d: 'private terminal output', token: 'secret-fixture' }));
  expect(row).toMatchObject({ type: 'd', outputBytes: 23 });
  expect(JSON.stringify(row)).not.toContain('private terminal output');
  expect(JSON.stringify(row)).not.toContain('secret-fixture');
  expect(observeTerminalFrame(binary({ t: 'e', c: 'NOT_BOUND', f: false, error: 'Bearer secret' }))).toMatchObject({ type: 'e', errorCode: 'NOT_BOUND', fatal: false });
  expect(observeTerminalFrame({ opcode: 2, payloadData: Buffer.from('not json').toString('base64') }).type).toBeUndefined();
});
