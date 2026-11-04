import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsdown';
import { Service as ModelResolverService } from '@opencode/core/model-resolver';
import { Service as PluginHooksService } from '@opencode/core/plugin/hooks';

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server/lib/llm');
// The plugin only looks up services supplied by the host. Read the installed
// SDK's keys at build time without bundling its service implementations/layers.
const hostServices = new Map([
  ['@opencode/core/model-resolver', ModelResolverService],
  ['@opencode/core/plugin/hooks', PluginHooksService],
]);
await build({
  config: false,
  entry: { 'bridge-plugin.bundle': path.join(directory, 'bridge-plugin.js') },
  outDir: directory,
  clean: false,
  format: 'esm',
  platform: 'node',
  target: 'esnext',
  dts: false,
  minify: true,
  sourcemap: false,
  deps: { alwaysBundle: [/.*/], neverBundle: [/^bun(?::|$)/], onlyBundle: false },
  outputOptions: { codeSplitting: false, entryFileNames: '[name].js' },
  plugins: [{
    name: 'opencode-host-service-tags',
    resolveId(id) { if (hostServices.has(id)) return `\0${id}`; },
    load(id) {
      const service = hostServices.get(id.slice(1));
      if (!id.startsWith('\0') || !service) return;
      return `import { Context } from 'effect'; export class Service extends Context.Service()(${JSON.stringify(service.key)}) {}`;
    },
  }],
});
console.log('Built self-contained Yuri LLM bridge');
