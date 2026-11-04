import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'SessionNodeItem.tsx'),
  'utf8',
)

describe('SessionNodeItem session menu', () => {
  test('delete icon inherits the same softened destructive color as its label', () => {
    expect(source).toContain('className="text-destructive/80 focus:text-destructive/80 [&>svg]:mr-1"')
    expect(source).toContain('<Icon name="delete-bin" className="mr-1 h-4 w-4 text-inherit" />')
  })

  test('removes the side-panel action while keeping the mini chat window action', () => {
    expect(source).not.toContain('sessions.sidebar.session.menu.openInSidePanel')
    expect(source).not.toContain('sessions.sidebar.session.menu.betaBadge')
    expect(source).not.toContain('openContextPanelTab')
    expect(source).toContain("t('sessions.sidebar.session.menu.openMiniChatWindow')")
    expect(source).toContain('onClick={handleOpenMiniChatWindow}')
  })

  test('context menus keep the shared popup material unobscured', () => {
    const menu = source.slice(source.indexOf('const contextMenuContent = ('), source.indexOf('<React.Fragment key={session.id}>'));
    expect(menu).toContain('dropdownMenuPopupClass');
    expect(menu.match(/yuri-session-context-menu/g)).toHaveLength(2);
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
