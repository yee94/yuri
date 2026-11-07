import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Parse/link the production-component fixture only. No NSH engine, host, UIKit or bundle execution.
const root = path.dirname(fileURLToPath(import.meta.url));
const result = await Bun.build({
  entrypoints: [path.join(root, 'settings-usage-fixture.tsx')],
  target: 'browser', write: false, external: ['nsh', 'nsh/*'],
  plugins: [{ name: 'usage-static-native-assets', setup(builder) {
    builder.onLoad({ filter: /\.(svg|png)$/ }, async ({ path: asset }) => {
      const bytes = await readFile(asset), mime = asset.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
      return { loader: 'js', contents: `export default ${JSON.stringify(`data:${mime};base64,${bytes.toString('base64')}`)};` };
    });
  } }],
});
if (!result.success) throw new Error(result.logs.map(log => String(log)).join('\n'));
const output = await result.outputs[0].text();
if (/node_modules\/(?:react\/|zustand\/|@tanstack\/)/.test(output)) throw new Error('Browser framework runtime escaped the native Usage import boundary');
console.log(JSON.stringify({ success: true, bytes: result.outputs[0].size, entry: 'settings-usage-fixture.tsx', executed: false }));
