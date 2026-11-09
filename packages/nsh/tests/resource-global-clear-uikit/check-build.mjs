import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const input = process.argv[2];
if (!input || process.argv.length !== 3) throw Error('Usage: node check-build.mjs /absolute/path/fixture-build.json');
const filename = path.resolve(input), directory = path.dirname(filename), manifest = JSON.parse(await readFile(filename, 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const frozen = path.join(directory, 'frozen/project/source');
if (!manifest.syntheticOnly || !manifest.controlsDefaultOff || manifest.fullAppRoutesProved !== false || manifest.installed || manifest.launched || manifest.engineStarted) throw Error('Wrong fixture/validation boundary');
if (!manifest.appBuilt || !manifest.sourceTypechecked || !manifest.swiftTypechecked || manifest.changedAfterSnapshot.length) throw Error('Incomplete build or source drift');
const transforms = new Map(manifest.transforms.map(value => [value.path, value]));
if (transforms.size !== 2 || !transforms.has('packages/nsh/resource-html-native.tsx') || !transforms.has('packages/nsh/tests/resource-global-clear-uikit/connection-effect.ts')) throw Error('Unexpected source adapter');
for (const [relative, record] of Object.entries(manifest.sources)) {
  const target = relative.startsWith('packages/') ? path.join(frozen, relative) : path.join(directory, 'typecheck-inputs', relative);
  const transform = transforms.get(relative), bytes = await readFile(target);
  if (hash(bytes) !== (transform?.generatedSHA256 ?? record.sha256)) throw Error('Frozen source mismatch: ' + relative);
  if (transform && hash(await readFile(path.join(directory, 'originals', relative))) !== record.sha256) throw Error('Original source mismatch: ' + relative);
}
for (const unit of manifest.combined) {
  const bytes = await readFile(path.join(directory, 'generated', path.basename(unit.production)));
  const original = await readFile(path.join(frozen, unit.production)), appendix = await readFile(path.join(frozen, unit.appendix));
  if (!bytes.equals(Buffer.concat([original, Buffer.from('\n'), appendix])) || hash(bytes) !== unit.combinedSHA256 || hash(original) !== unit.originalSHA256) throw Error('Production Swift body was modified');
}
const app = await readFile(path.join(frozen, 'packages/nsh/application.tsx'), 'utf8');
const parsed = ts.createSourceFile('application.tsx', app, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TSX), effects = [];
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'effect' && node.getText(parsed).includes('previous = selected')) effects.push(node.getText(parsed));
  ts.forEachChild(node, visit);
}
visit(parsed);
const supplied = await readFile(path.join(frozen, 'packages/nsh/tests/resource-global-clear-uikit/connection-effect.ts'), 'utf8');
if (effects.length !== 1 || hash(effects[0]) !== manifest.productionConnectionEffectSHA256 || !supplied.includes(effects[0])) throw Error('Connection effect is not the production entry');
const config = JSON.parse(await readFile(path.join(directory, 'frozen/project/nsh.json'), 'utf8'));
if (Object.keys(config.capabilities).join() !== 'host' || config.capabilities.host.some(value => !/^(connection\.list|runtime\.request|resources\.(read|present|release|cancel|close|web\.(present|close))|fixture\.globalClear\.(control|applied|event|audit))$/.test(value))) throw Error('Unexpected capability grant');
if (hash(await readFile(path.join(directory, 'bundle/bundle.nshc'))) !== manifest.bundleSHA256) throw Error('Bundle hash mismatch');
if (hash(await readFile(path.join(directory, 'frameworks/NativeShell.framework/NativeShell'))) !== manifest.nativeShellSHA256) throw Error('SDK hash mismatch');
if (hash(await readFile(path.join(directory, 'frameworks/NativeShell.framework/Modules/NativeShell.swiftmodule/arm64-apple-ios-simulator.swiftinterface'))) !== manifest.publicInterfaceSHA256) throw Error('SDK interface hash mismatch');
if (hash(await readFile(path.join(manifest.app, 'ResourceGlobalClearUIKitFixture'))) !== manifest.executableSHA256) throw Error('Executable hash mismatch');
console.log(JSON.stringify({ buildID: manifest.buildID, buildContractVerified: true, actualUIKitValidated: false,
  controlsDefaultOff: true, sourceAdapters: transforms.size, productionSwiftBodiesUnchanged: true,
  productionConnectionEffect: true, journalCapacity: manifest.eventCapacity, installed: false, launched: false }));
