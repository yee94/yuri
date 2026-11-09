import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { bindContactAttachmentRead } from './resources-request';
import type { ContactAttachment } from './model';

const root = path.dirname(fileURLToPath(import.meta.url));
test('production Swift accepts exact new/legacy TS descriptors and fences generation, bytes and native permission retirement', async () => {
  const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'contact-generation-'));
  try {
    const raw = readFileSync(path.join(root, 'ios/ResourceBridge.swift'), 'utf8');
    const lease = raw.split('\n').find(line => line.includes('private struct Lease {'))!;
    const present = raw.slice(raw.indexOf('    private func present(_ input:'), raw.indexOf('    private func show('));
    const retire = raw.slice(raw.indexOf('    func close(_ key:'), raw.indexOf('    private func read(_ request:'));
    expect(present).toContain('contact.readVerified'); expect(present).toContain('leases[key]?.url == lease.url');
    expect(raw).toContain('contact: request.contact'); expect(raw).toContain('try await contact.validateGeneration');
    const runtime = readFileSync(path.join(root, 'ios/RuntimeBridge.swift'), 'utf8');
    const transport = runtime.slice(runtime.indexOf('struct SpeechResourceResponse'), runtime.indexOf('private actor ResourceBytesBuffer'));
    const boundary = readFileSync(path.join(root, 'tests/resource-contact-permission-boundary.swift'), 'utf8')
      .replace('/* PRODUCTION_LEASE */', lease).replace('/* PRODUCTION_PRESENT */', present).replace('/* PRODUCTION_RETIRE */', retire);
    const swift = path.join(temporary, 'Permission.swift'); writeFileSync(swift, 'import Foundation\n' + transport + '\n' + boundary);
    const bodies: unknown[] = [], bytes = 'synthetic contact generation bytes';
    for (const generation of [undefined, 0, 7, Number.MAX_SAFE_INTEGER]) {
      const file: ContactAttachment = { type: 'file', kind: 'contact', hostID: 'fixture', assistantID: 'bot', name: 'original.txt', filename: 'original.txt',
        attachmentID: 'att_owned', sha256: createHash('sha256').update(bytes).digest('hex'), size: Buffer.byteLength(bytes), mime: 'text/plain', ...(generation === undefined ? {} : { generation }) };
      await bindContactAttachmentRead({ hostID: 'fixture', lease: '00000000-0000-4000-8000-000000000001' }, async (_name, body) => { bodies.push(body); return true; })(file, 'roundtrip');
    }
    const payload = path.join(temporary, 'descriptors.json'); writeFileSync(payload, JSON.stringify(bodies));
    const binary = path.join(temporary, 'contract');
    const compiled = spawnSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', path.join(root, 'ios/RuntimeHostScope.swift'), path.join(root, 'ios/ResourceBridge.swift'), swift,
      path.join(root, 'tests/resource-contact-generation-contract.swift'), '-o', binary], { encoding: 'utf8', timeout: 120_000 });
    expect(compiled.status, String(compiled.error ?? compiled.stdout + compiled.stderr)).toBe(0);
    const result = spawnSync(binary, [payload], { encoding: 'utf8', timeout: 15_000 });
    expect(result.status, String(result.error ?? result.stdout + result.stderr)).toBe(0);
    expect(result.stdout).toContain('Contact generation parser, wire, authenticated bytes and exact permission retirement passed');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 150_000);
