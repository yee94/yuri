import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let binary: string | undefined;
function compile() {
  if (binary) return binary;
  const directory = mkdtempSync(path.join(tmpdir(), 'resource-presentation-native-'));
  const bridge = readFileSync(path.join(root, 'ios/ResourceBridge.swift'), 'utf8');
  const registration = bridge.slice(bridge.indexOf('    func registerPresenter('), bridge.indexOf('    /// Native-only fixture entry;'));
  if (!registration.includes('try capture(expectedHost).isCurrent()')) throw Error('Missing real registration admission');
  const source = readFileSync(path.join(root, 'ios/ResourceHTMLComponents.swift'), 'utf8');
  const anchor = source.slice(source.indexOf('@MainActor private final class ResourcePresenterRegistrationView:'));
  if (!anchor.includes('final class ResourcePresentationAnchor:')) throw Error('Missing production anchor');
  const combined = path.join(directory, 'Anchor.swift');
  writeFileSync(combined, readFileSync(path.join(root, 'tests/resource-presentation-platform.swift'), 'utf8').replace('/* PRODUCTION_REGISTRATION */', registration)
    + '\n' + anchor + '\n' + readFileSync(path.join(root, 'tests/resource-presentation-main.swift'), 'utf8'));
  const output = path.join(directory, 'anchor-contract');
  const result = spawnSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', path.join(root, 'ios/RuntimeHostScope.swift'), combined, '-o', output], { encoding: 'utf8', timeout: 120_000 });
  if (result.error || result.status !== 0) throw Error(String(result.error ?? result.stdout + result.stderr));
  binary = output; return output;
}

export type NativeAnchorEvent = { event: string; owner?: string; attempt?: number; code?: string; command?: string; dismissCalls?: number; foreignDismissCalls?: number; captures?: number; presenters?: number };

/** Executes the production Swift owner/admission, with controllable platform transitions. */
export function nativeAnchor(receive: (event: NativeAnchorEvent) => void) {
  const child = spawn(compile(), [], { stdio: ['pipe', 'pipe', 'pipe'] });
  let outstanding: { resolve(value: NativeAnchorEvent): void; reject(cause: Error): void } | undefined;
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  createInterface({ input: child.stdout }).on('line', line => {
    const event = JSON.parse(line) as NativeAnchorEvent;
    if (event.event === 'ack') { const current = outstanding; outstanding = undefined; current?.resolve(event); }
    else receive(event);
  });
  child.on('error', cause => { outstanding?.reject(cause); outstanding = undefined; });
  child.on('exit', code => { outstanding?.reject(Error(`Native anchor exited ${code}: ${stderr}`)); outstanding = undefined; });
  return {
    command(command: string): Promise<NativeAnchorEvent> {
      if (outstanding) return Promise.reject(Error('Native commands must be sequential'));
      return new Promise((resolve, reject) => { outstanding = { resolve, reject }; child.stdin.write(command + '\n'); });
    },
    close() { child.stdin.end('quit\n'); },
  };
}
