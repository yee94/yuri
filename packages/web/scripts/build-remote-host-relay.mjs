import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsdown';

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server/lib/remote-hosts');
await build({ config: false, entry: { 'relay-client.bundle': path.join(directory, 'relay-client.ts') },
  outDir: directory, clean: false, format: 'esm', platform: 'node', target: 'esnext',
  dts: false, minify: true, sourcemap: false,
  deps: { alwaysBundle: [/.*/], onlyBundle: false },
  outputOptions: { codeSplitting: false, entryFileNames: '[name].js' } });
