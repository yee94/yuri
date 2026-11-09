import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import { aboutDiagnosticTypes, createAboutDiagnosticsRoot } from './settings-about-diagnostics';

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));
const source = (name: string) => readFileSync(path.join(rootDirectory, name), 'utf8');
let root: ReturnType<typeof createAboutDiagnosticsRoot> | undefined;
afterEach(() => { root?.dispose(); root = undefined; });

test('Rust, Swift and TS use the same complete event allowlist, not arbitrary runtime names', () => {
  const rust = source('desktop-host/src/diagnostics_schema.rs');
  const swift = source('ios/DiagnosticsBridge.swift');
  const rustTypes = rust.split('pub const TYPES: &[&str] = &[')[1]!.split('];')[0]!;
  const swiftTypes = swift.split('static let types: Set<String> = [')[1]!.split(']')[0]!;
  const strings = (value: string) => [...value.matchAll(/"([^"]+)"/g)].map(match => match[1]);
  expect(strings(rustTypes)).toEqual([...aboutDiagnosticTypes]);
  expect(strings(swiftTypes)).toEqual([...aboutDiagnosticTypes]);
  expect(new Set(strings(rustTypes)).size).toBe(aboutDiagnosticTypes.length);
});

test('schema 2 native methods preserve existing call names, bounds, and JSON export envelope', () => {
  const core = source('desktop-host/src/diagnostics.rs');
  const schema = source('desktop-host/src/diagnostics_schema.rs');
  const methods = core.split('pub const METHODS: &[&str] = &[')[1]!.split('];')[0]!;
  expect([...methods.matchAll(/"([^"]+)"/g)].map(match => match[1])).toEqual([
    'native.diagnostics.status', 'native.diagnostics.setEnabled', 'native.diagnostics.append', 'native.diagnostics.export',
  ]);
  expect(schema).toMatch(/MAX_ENTRIES: usize = 500/);
  expect(schema).toMatch(/MAX_BYTES: usize = 256 \* 1024/);
  expect(schema).toMatch(/MAX_EXPORT_BYTES: usize = 512 \* 1024/);
  expect(schema).toMatch(/MAX_BATCH_BYTES: usize = 16 \* 1024/);
  expect(core).toContain('yuri.client-diagnostics.v1');
  expect(core).toContain('"schemaVersion":2');
  expect(core).toContain('"recordingLease":self.lease');
  expect(core).toContain('#[path = "documents_files.rs"]');
});

test('the real TS recorder accepts desktop schema 2 and sends only anonymous exact rows', async () => {
  const scope = { hostID: 'synthetic-host', generation: 1 };
  const call = vi.fn(async (_name: string, _body?: Record<string, unknown>): Promise<unknown> => ({
    schemaVersion: 2, mode: 'event-recorder', enabled: true, recordingLease: 'native-issued-lease',
    eventCount: 0, maxEntries: 500, maxBytes: 256 * 1024,
  }));
  root = createAboutDiagnosticsRoot({ call, scope: () => scope, now: () => 42 });
  await root.refresh();
  root.onEvent({ type: 'session.status', key: 'chat', directory: '/synthetic/private', id: 'private-event',
    body: { sessionID: 'private-session', text: 'private-body', token: 'private-token', url: 'https://example.invalid' } }, scope);
  await root.flush();
  expect(call.mock.calls.at(-1)).toEqual(['native.diagnostics.append', {
    hostID: 'synthetic-host', lease: 'native-issued-lease', dropped: 0, events: [{
      at: 42, feat: 'transcript', kind: 'sse-event', sessionID: 'session-1', source: 'sse', sseType: 'session.status', surfaceKind: 'chat',
    }],
  }]);
  expect(JSON.stringify(call.mock.calls.at(-1)?.[1]?.events)).not.toMatch(/private|example\.invalid/);
});

test('native dialogs are genuine platform APIs; tests inject a driver without opening them', () => {
  const native = source('desktop-host/src/diagnostics_native.rs');
  const exporting = source('desktop-host/src/diagnostics_export.rs');
  expect(native).toContain('c"NSSavePanel"');
  expect(native).toContain('GetSaveFileNameW');
  expect(native).toContain('SAVE_FLAGS');
  expect(native).toContain('OFN_ENABLEHOOK');
  expect(native).toContain('poll.cancelled.load');
  expect(exporting).toContain('trait Driver');
  expect(exporting).toContain('driver.verify(&self.data).unwrap_or(false)');
  expect(native + exporting).not.toMatch(/std::process|Command::|println!|eprintln!|openUrl|AppleScript|powershell/i);
});
