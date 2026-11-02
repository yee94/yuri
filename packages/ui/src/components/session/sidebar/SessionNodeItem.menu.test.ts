import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'SessionNodeItem.tsx'),
  'utf8',
)

describe('SessionNodeItem session menu', () => {
  test('context menus keep the shared popup material unobscured', () => {
    const menu = source.slice(source.indexOf('const contextMenuContent = ('), source.indexOf('<React.Fragment key={session.id}>'));
    expect(menu).toContain('dropdownMenuPopupClass');
    expect(menu).not.toContain('backgroundColor:');
  })

  test('right-click menu exposes user transcript refresh', () => {
    expect(source).toContain("t('sessions.sidebar.session.menu.refreshTranscript')")
    expect(source).toContain('sync.refreshSessionTranscript')
    expect(source).toContain('disabled={!sessionDirectory || isTranscriptRefreshing}')
  })

  test('shows session change counts next to the title when summary has them', () => {
    expect(source).toContain('formatSessionChangeCounts(readSessionChangeSummary(resolvedSession))')
    expect(source).toContain('sessionChangeCounts')
  })
})
