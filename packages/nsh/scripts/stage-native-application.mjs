import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const defaultEntry = 'packages/nsh/App.tsx';
const artwork = /\.(svg|png|jpe?g|gif|webp|avif|ico)$/i;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const native = specifier => /^nsh(?:\/|$)/.test(specifier);
const packageName = specifier => specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
const machinePath = /(?:\/(?:Users|home|private|var\/folders)\/|(?:^|[\s"'`])[A-Za-z]:[\\/]|file:\/\/\/)/;

function inside(root, file) {
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Native staging path escaped its root');
  return relative;
}

async function files(directory, prefix = '') {
  const result = [];
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(prefix, item.name);
    if (item.isDirectory()) result.push(...await files(path.join(directory, item.name), relative));
    else if (item.isFile()) result.push(relative);
    else throw new Error('Native staging does not accept package symlinks or special files');
  }
  return result;
}

// Bun discovers the production graph; the syntax pass also preserves runtime
// imports which NSH retains even when Bun removes their unused bindings.
function runtimeImports(source, name) {
  const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const imports = [];
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause, bindings = clause?.namedBindings;
      if (clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every(item => item.isTypeOnly))) return;
      if (ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.some(item => !item.isTypeOnly)) imports.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return imports;
}

async function resolveSource(importer, specifier) {
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [base, ...['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'].map(extension => base + extension), ...['index.ts', 'index.tsx', 'index.js', 'index.mjs'].map(file => path.join(base, file))];
  if (/\.js$/.test(base)) candidates.push(base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx');
  for (const candidate of candidates) {
    try { await readFile(candidate); return candidate; } catch (error) { if (!['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  throw new Error(`Unresolved native source import: ${specifier}`);
}

async function installedPackage(specifier, importer) {
  const name = packageName(specifier), require = createRequire(importer);
  // Package roots also cover ESM-only exports and asset subpaths; Node's
  // require.resolve(entry) would incorrectly reject those installed packages.
  for (const lookup of require.resolve.paths(name) ?? []) {
    try {
      const directory = await realpath(path.join(lookup, name));
      const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (metadata.name === name) return { directory, metadata };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error(`Missing installed native package: ${name} from ${path.basename(importer)}`);
}

/** Stage only into a new directory. No compiler, engine, installation or network.
 * root/cwd/entry are invocation paths, never serialized into the manifest.
 * Caller owns cleanup and invokes NSH with cwd, entry and its own output path.
 */
export async function stageNativeApplication({ root, workspaceRoot = repository, bun = 'bun', entry = defaultEntry, config = 'packages/nsh' }) {
  root = path.resolve(root);
  workspaceRoot = await realpath(workspaceRoot);
  if (!entry.startsWith('packages/') || path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) throw new Error('Invalid native staging entry');
  await mkdir(root); // Refuse to overwrite a previous build or another owner.
  const graphRoot = path.join(root, 'graph'), project = path.join(root, 'project');
  const sourceFiles = {}, dependencies = {}, pendingPackages = [];
  try {
    await mkdir(graphRoot); await mkdir(project);
    const metafile = path.join(graphRoot, 'inputs.json');
    const result = spawnSync(bun, ['build', entry, '--target=browser', '--external=nsh', '--external=nsh/*', '--loader', '.svg:file', '--loader', '.png:file', '--outdir', graphRoot, `--metafile=${metafile}`], { cwd: workspaceRoot, encoding: 'utf8', timeout: 240_000 });
    if (result.error || result.status !== 0) {
      const diagnostic = (result.stderr || result.error?.message || '').replaceAll(workspaceRoot, '<workspace>').replaceAll(root, '<stage>');
      throw new Error(`Native application Bun input graph failed: ${diagnostic}`);
    }
    const inputs = JSON.parse(await readFile(metafile, 'utf8')).inputs;
    const queue = Object.keys(inputs).map(file => path.resolve(workspaceRoot, file));
    const visited = new Set();
    for (let index = 0; index < queue.length; index++) {
      const absolute = queue[index], relative = inside(workspaceRoot, absolute);
      if (visited.has(relative)) continue;
      visited.add(relative);
      if (relative.startsWith('node_modules/') || relative.includes('/node_modules/')) {
        // Resolve the owning package without retaining Bun's machine-specific store path.
        let directory = path.dirname(absolute);
        while (directory !== workspaceRoot) {
          try {
            const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
            if (metadata.name && metadata.version) {
              const location = relative.startsWith('packages/') ? `source/${inside(workspaceRoot, directory)}` : `node_modules/${metadata.name}`;
              pendingPackages.push({ directory: await realpath(directory), metadata, location }); break;
            }
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          directory = path.dirname(directory);
        }
        continue;
      }
      if (!relative.startsWith('packages/')) throw new Error('Unexpected native input outside workspace packages');
      const bytes = await readFile(absolute), destination = path.join(project, 'source', relative);
      await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, bytes);
      sourceFiles[relative] = { bytes: bytes.length, sha256: digest(bytes) };
      if (/\.[cm]?[jt]sx?$/.test(relative)) for (const specifier of runtimeImports(bytes.toString('utf8'), relative)) {
        if (native(specifier)) continue;
        if (specifier.startsWith('.')) queue.push(await resolveSource(absolute, specifier));
        else if (specifier.startsWith('@/')) throw new Error('Unresolved alias in native runtime source');
        else pendingPackages.push(await installedPackage(specifier, absolute));
      }
    }
    for (let index = 0; index < pendingPackages.length; index++) {
      const { directory, metadata, location = `node_modules/${metadata.name}` } = pendingPackages[index], name = metadata.name;
      inside(workspaceRoot, directory);
      if (dependencies[name]) {
        if (dependencies[name].version !== metadata.version) throw new Error(`Conflicting installed native package: ${name}`);
        if (dependencies[name].locations.includes(location)) continue;
      }
      if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) throw new Error('Invalid installed package name');
      const records = {};
      const existing = dependencies[name];
      dependencies[name] = existing ?? { version: metadata.version, locations: [], files: records };
      dependencies[name].locations.push(location);
      for (const file of await files(directory)) {
        // Nested installs must be resolved explicitly, not copied as opaque state.
        if (file.startsWith('node_modules/')) throw new Error('Nested native dependency installation requires explicit resolution');
        const bytes = await readFile(path.join(directory, file)), destination = path.join(project, location, file);
        await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, bytes);
        dependencies[name].files[file] = { bytes: bytes.length, sha256: digest(bytes) };
      }
      for (const dependency of Object.keys(metadata.dependencies ?? {})) pendingPackages.push(await installedPackage(dependency, path.join(directory, 'package.json')));
    }
    for (const file of ['nsh.json', 'theme.json']) {
      const relative = path.join(config, file), bytes = await readFile(path.join(workspaceRoot, relative));
      await writeFile(path.join(project, file), bytes);
      sourceFiles[relative] = { bytes: bytes.length, sha256: digest(bytes) };
    }
    await writeFile(path.join(project, 'App.tsx'), `import './source/${entry}';\n`);
    const manifest = { schemaVersion: 1, entry: 'App.tsx', sourceEntry: `source/${entry}`, bunInputCount: Object.keys(inputs).length, sourceFiles, dependencies, assets: Object.keys(sourceFiles).filter(file => artwork.test(file)).sort() };
    const serialized = JSON.stringify(manifest, null, 2);
    if (machinePath.test(serialized) || serialized.includes(workspaceRoot)) throw new Error('Non-neutral native staging manifest');
    await writeFile(path.join(root, 'native-application.json'), serialized + '\n');
    await rm(graphRoot, { recursive: true });
    return { root, cwd: project, entry: 'App.tsx', manifest };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/** Reject dangling URLs, modified/missing originals and machine paths after NSH build. */
export async function validateNativeApplicationBundle(bundle, manifest) {
  const packaged = await files(bundle), references = [], hashes = new Set();
  for (const file of packaged) {
    const bytes = await readFile(path.join(bundle, file));
    if (file.startsWith('assets/')) hashes.add(digest(bytes));
    if (!/\.(js|json|map)$/.test(file)) continue;
    const text = bytes.toString('utf8');
    // Check URLs first so the missing-file failure is actionable even for old bundles.
    for (const match of text.matchAll(/asset:\/\/([^\s`"'<>\\]+)/g)) {
      const asset = match[1];
      if (path.isAbsolute(asset) || asset.split('/').includes('..') || !packaged.includes(`assets/${asset}`)) throw new Error(`Unpackaged native asset in ${file}`);
      references.push(asset);
    }
    // Source-map source text includes neutral path examples/comments. Executable
    // literals are checked in bundle.js; map filenames/URLs must still be neutral.
    const metadata = file.endsWith('.map') ? (() => { const { sourcesContent, ...rest } = JSON.parse(text); return JSON.stringify(rest); })() : text;
    if (machinePath.test(metadata)) throw new Error(`Non-neutral machine path in native bundle ${file}`);
  }
  if (!packaged.includes('bundle.js') || !packaged.includes('bundle.nshc')) throw new Error('Incomplete native application bundle');
  for (const asset of manifest.assets) if (!hashes.has(manifest.sourceFiles[asset].sha256)) throw new Error(`Missing original native artwork: ${asset}`);
  return { assetReferences: references.length, packagedAssets: packaged.filter(file => file.startsWith('assets/')).length, originalAssets: manifest.assets.length };
}
