// Run with Bun: imports the production TS projection, not a second palette/schema generator.
import { nativeThemeTokens } from '../../appearance-core.ts';
import { getThemeById } from '../../../ui/src/lib/theme/themes';
import { readFileSync } from 'node:fs';
const fixture = {
  hostID: 'synthetic-host', revision: 7, mode: 'system',
  cssVars: { light: nativeThemeTokens(getThemeById('jetbrains-light')), dark: nativeThemeTokens(getThemeById('jetbrains-dark')) },
  fonts: { ui: 'system-ui', mono: 'monospace', assistantLight: 'JetBrains Mono', assistantDark: 'JetBrains Mono' },
};
if (process.argv.includes('--check')) {
  const saved = JSON.parse(readFileSync(new URL('./appearance.json', import.meta.url), 'utf8'));
  if (JSON.stringify(saved) !== JSON.stringify(fixture)) throw new Error('Rust appearance fixture differs from production TS projection');
} else process.stdout.write(JSON.stringify(fixture, null, 2) + '\n');
