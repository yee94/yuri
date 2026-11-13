import { describe, expect, test } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMobileShareHandoffMarkerPart } from '@/apps/mobileShareDraftHandoff'
import { createInputStore } from '@/sync/input-store'
import { surfaceDraftKey } from '@/sync/input-draft-types'
import { mergeSyntheticPartsByPartID, projectRootAttachmentViews } from './assistantDraftAttachments'

const directory = dirname(fileURLToPath(import.meta.url))

describe('AssistantView synthetic part consumption', () => {
  test('contact AssistantView no longer consumes ChatInput draft markers', async () => {
    const source = await readFile(join(directory, 'AssistantView.tsx'), 'utf8')
    expect(source).not.toContain('consumeDraftSyntheticParts')
    expect(source).not.toContain('ensureAssistantSession')
  })

  test('consume retain keeps handoff marker in draft and returns other parts', () => {
    const store = createInputStore({ persistenceEnabled: false })
    const draftKey = surfaceDraftKey({ transportIdentity: 'runtime' }, 'assistant:a1')
    store.getState().ensureDraft(draftKey)
    store.getState().setDraftSyntheticParts(draftKey, [
      { partID: 'mobile-share-handoff:share', text: '', attachments: [], synthetic: true },
      { partID: 'send', text: 'context', attachments: [] },
    ])
    // Mirror AssistantView.resources.consumeSyntheticParts retain contract.
    const consumed = store.getState().consumeDraftSyntheticParts(draftKey, isMobileShareHandoffMarkerPart)
    expect(consumed).toEqual([{ partID: 'send', text: 'context', attachments: [] }])
    expect(store.getState().getDraft(draftKey)?.syntheticParts).toEqual([
      { partID: 'mobile-share-handoff:share', text: '', attachments: [], synthetic: true },
    ])
  })

  test('restore merge keeps handoff marker after failed-send restore', () => {
    const store = createInputStore({ persistenceEnabled: false })
    const draftKey = surfaceDraftKey({ transportIdentity: 'runtime' }, 'assistant:a1')
    store.getState().ensureDraft(draftKey)
    store.getState().setDraftSyntheticParts(draftKey, [
      { partID: 'mobile-share-handoff:share', text: '', attachments: [], synthetic: true },
    ])
    const current = store.getState().getDraft(draftKey)?.syntheticParts ?? []
    const restored = [{ partID: 'send', text: 'context', attachments: [] }]
    store.getState().setDraftSyntheticParts(draftKey, mergeSyntheticPartsByPartID(current, restored))
    expect(store.getState().getDraft(draftKey)?.syntheticParts?.map((part) => part.partID)).toEqual([
      'mobile-share-handoff:share',
      'send',
    ])
  })

  test('keeps root-only attachment projection helpers for share modules', async () => {
    const source = await readFile(join(directory, 'assistantDraftAttachments.ts'), 'utf8')
    expect(source).toContain('projectRootAttachmentViews')
    expect(source).toContain('mergeSyntheticPartsByPartID')
    const view = await readFile(join(directory, 'AssistantView.tsx'), 'utf8')
    expect(view).not.toContain('hydrateDraftAttachments(draftKey)')
    expect(view).not.toContain('Object.values(attachmentViews)')
  })

  test('attachment metadata identity changes when attachments arrive without revision coupling', () => {
    // Pure signature used by AssistantView: refs only, not full draft revision/text.
    const identityOf = (attachments: string[], synthetic: Array<{ partID: string; refs: string[] }>) => {
      const root = attachments.join('\u0001')
      const parts = synthetic.map((part) => `${part.partID}\u0002${part.refs.join('\u0001')}`).join('\u0003')
      return `${root}\u0004${parts}`
    }
    const empty = identityOf([], [])
    const late = identityOf(['["root","a"]'], [{ partID: 'p', refs: ['["part","p","s"]'] }])
    expect(empty).not.toBe(late)
    // Text/revision would change without metadata identity change:
    const sameMeta = identityOf(['["root","a"]'], [{ partID: 'p', refs: ['["part","p","s"]'] }])
    expect(sameMeta).toBe(late)
  })

  test('projectRootAttachmentViews excludes synthetic refs', () => {
    expect(projectRootAttachmentViews(
      {
        attachments: [
          {
            attachmentID: 'r',
            attachmentRefID: '["root","r"]',
            filename: 'r.txt',
            mimeType: 'text/plain',
            size: 1,
            locator: { kind: 'url', url: 'x' },
            source: 'local',
          },
        ],
      },
      {
        '["root","r"]': {
          id: 'r',
          file: new File([], 'r.txt'),
          dataUrl: 'data:text/plain,r',
          mimeType: 'text/plain',
          filename: 'r.txt',
          size: 1,
          source: 'local',
        },
        '["part","p","s"]': {
          id: 's',
          file: new File([], 's.txt'),
          dataUrl: 'data:text/plain,s',
          mimeType: 'text/plain',
          filename: 's.txt',
          size: 1,
          source: 'local',
        },
      },
    ).map((item) => item.id)).toEqual(['r'])
  })
})

describe('AssistantView contact surface', () => {
  test('keeps the desktop transcript scrollbar at the workspace right edge', async () => {
    const css = await readFile(join(directory, 'assistant-workspace.css'), 'utf8')
    const workspaceRules = [...css.matchAll(/\.yuri-assistant-workspace\[data-assistant-layout="desktop"\] \{([^}]+)\}/g)]
    expect(workspaceRules).toHaveLength(2)
    expect(workspaceRules[0][1]).toContain('padding: 0 0 0 var(--assistant-workspace-inset)')
    expect(workspaceRules[0][1]).toContain('--assistant-workspace-inset: 1rem')
    expect(workspaceRules[1][1]).toContain('--assistant-workspace-inset: 0.625rem')
  })

  test('insets the floating desktop catalog and composer independently of the full-height message canvas', async () => {
    const [css, surface] = await Promise.all([
      readFile(join(directory, 'assistant-workspace.css'), 'utf8'),
      readFile(join(directory, 'AssistantConversationSurface.tsx'), 'utf8'),
    ])
    const composerInset = css.match(/\.yuri-assistant-workspace\[data-assistant-layout="desktop"\] \[data-assistant-contact-composer\] > form \{([^}]+)\}/)?.[1]
    expect(composerInset).toContain('padding-bottom: 0;')
    const catalog = css.match(/\.yuri-assistant-catalog-panel \{([^}]+)\}/)?.[1]
    expect(catalog).toContain('margin-block: var(--assistant-workspace-inset, 1rem)')
    const footer = css.match(/\.yuri-assistant-workspace\[data-assistant-layout="desktop"\] \[data-assistant-contact-composer\] \{([^}]+)\}/)?.[1]
    expect(footer).toContain('padding-bottom: var(--assistant-workspace-inset)')
    expect(css).not.toContain('.yuri-assistant-pane {')
    const composerMaterial = css.match(/\.yuri-assistant-workspace \[data-composer-material\] \{([^}]+)\}/)?.[1]
    expect(composerMaterial).toContain('box-shadow: var(--assistant-composer-shadow)')
    const bubbleCss = await readFile(join(directory, 'contact-message-bubble.css'), 'utf8')
    const overlay = bubbleCss.match(/\[data-composer-overlay\] \[data-assistant-contact-composer\] \{([^}]+)\}/)?.[1]
    expect(overlay).toContain('position: absolute')
    expect(overlay).toContain('pointer-events: none')
    expect(bubbleCss).toContain('padding-bottom: var(--contact-composer-height, 0px)')
    expect(bubbleCss).toContain('scroll-padding-bottom: var(--contact-composer-height, 0px)')
    expect(surface).toContain("'relative w-full pt-1.5 pb-4'")
    expect(surface).toContain("isMobile && 'bottom-safe-area yuri-mobile-composer'")
  })

  test.each(['desktop', 'mobile'])('sticky avatars count the overlay composer inset only once (%s)', async (layout) => {
    const style = document.createElement('style')
    style.textContent = await readFile(join(directory, 'contact-message-bubble.css'), 'utf8')
    const surface = document.createElement('div')
    surface.className = 'yuri-contact-conversation'
    surface.dataset.contactLayout = layout
    surface.dataset.composerOverlay = ''
    surface.innerHTML = '<div data-assistant-contact-transcript><div data-assistant-contact-avatar-rail></div></div>'
    document.head.append(style)
    document.body.append(surface)
    try {
      for (const height of [80, 160]) {
        surface.style.setProperty('--contact-composer-height', `${height}px`)
        const transcript = surface.querySelector<HTMLElement>('[data-assistant-contact-transcript]')!
        const rail = surface.querySelector<HTMLElement>('[data-assistant-contact-avatar-rail]')!
        expect(getComputedStyle(transcript).paddingBottom).toBe(`${height}px`)
        expect(getComputedStyle(rail).bottom).toBe('8px')
      }
    } finally {
      surface.remove()
      style.remove()
    }
  })

  test('gives message bodies proportional leading without changing composer metrics', async () => {
    const css = await readFile(join(directory, 'contact-message-bubble.css'), 'utf8')
    expect(css.match(/--contact-body-leading:/g)).toHaveLength(1)
    expect(css).toContain('--contact-body-leading: 1.65;')
    expect(css).toContain('line-height: var(--contact-body-leading, 1.65);')
    expect(css).toContain('--markdown-list-line-height: 1.5;')
    expect(css).toContain('--markdown-paragraph-spacing: 0.5em;')
    expect(css).toContain('margin-block: 0.15em;')
    expect(css).toContain('margin-block: 0.35em !important;')
    expect(css).toContain('margin-bottom: 0 !important;')
    expect(css).toContain('.markdown-content li > :is(p, .paragraph-node)')
    expect(css).toContain('font-size: var(--contact-body-size, var(--text-markdown));')
    expect(css).toContain('line-height: 1.25rem;')
    expect(css).toContain('.yuri-contact-bubble-time {')
  })

  test('uses variant-aware theme material without changing the wallpaper canvas', async () => {
    const [css, entry, mobile, artwork, license] = await Promise.all([
      readFile(join(directory, 'assistant-workspace.css'), 'utf8'),
      readFile(join(directory, '../../index.css'), 'utf8'),
      readFile(join(directory, '../../mobile/assistant/MobileAssistantTab.tsx'), 'utf8'),
      readFile(join(directory, '../../assets/assistant-wallpaper/telegram-pattern.svg'), 'utf8'),
      readFile(join(directory, '../../assets/assistant-wallpaper/LICENSE'), 'utf8'),
    ])
    expect(entry).toContain('@import "./components/assistants/assistant-workspace.css"')
    expect(css).toContain('background: var(--surface-background)')
    expect(css).toContain('--assistant-panel-background: color-mix(in srgb, var(--surface-background) 97%, black)')
    expect(css).toContain('--assistant-panel-background: color-mix(in srgb, var(--surface-background) 94%, white)')
    const darkMaterial = css.match(/:root\.dark \.yuri-assistant-wallpaper,\s*:root\.dark \.yuri-assistant-mobile-header \{([^}]+)\}/)?.[1]
    expect(darkMaterial).toContain('94%, white')
    expect(darkMaterial).toContain('--assistant-panel-shadow: none')
    expect(darkMaterial).toContain('--assistant-composer-shadow: none')
    expect(darkMaterial).toContain('--assistant-tag-shadow: none')
    expect(darkMaterial).toContain('--assistant-bubble-filter: none')
    const lightMaterial = css.match(/\.yuri-assistant-wallpaper,\s*\.yuri-assistant-mobile-header \{([^}]+)\}/)?.[1]
    expect(lightMaterial).toContain('--assistant-panel-shadow: 0 4px 12px color-mix(in srgb, var(--surface-foreground) 12%, transparent)')
    expect(lightMaterial).toContain('--assistant-composer-shadow: 0 3px 10px color-mix(in srgb, var(--surface-foreground) 14%, transparent)')
    expect(lightMaterial).toContain('--assistant-tag-shadow: 0 1px 3px color-mix(in srgb, var(--surface-foreground) 10%, transparent)')
    expect(lightMaterial).toContain('--assistant-bubble-filter: drop-shadow(0 1px 1px color-mix(in srgb, var(--surface-foreground) 16%, transparent))')
    expect(css).toContain('.yuri-assistant-workspace .yuri-contact-bubble .yuri-contact-bubble-outline')
    expect(css).not.toContain('oklch(')
    expect(css).toContain('[data-contact-bubble-direction="incoming"]')
    expect(css).toContain('--contact-bubble-fill: var(--assistant-panel-background)')
    expect(css).toContain('box-shadow: var(--assistant-panel-shadow)')
    expect(css).toContain('filter: var(--assistant-bubble-filter)')
    expect(css).toContain(':root.dark .yuri-assistant-wallpaper :is([data-composer-material]')
    expect(css).toContain('outline: 2px solid var(--interactive-focus-ring)')
    expect(css).toContain('[data-assistant-contact-transcript] > :is(')
    expect(entry).toContain('--assistant-wallpaper-pattern: url("./assets/assistant-wallpaper/telegram-pattern.svg")')
    expect(css).toContain('mask: var(--assistant-wallpaper-pattern)')
    expect(css.match(/center top \/ 504px 1036px repeat/g)).toHaveLength(2)
    expect(mobile).toContain("cn('yuri-assistant-mobile-catalog-page', className)")
    const shell = await readFile(join(directory, '../../mobile/MobileTabsRoot.tsx'), 'utf8')
    expect(shell).toContain("selectedTab === 'assistant' && 'yuri-assistant-wallpaper'")
    const catalog = css.match(/\.yuri-assistant-mobile-catalog-page \.yuri-mobile-assistant-catalog \{([^}]+)\}/)?.[1]
    expect(catalog).toContain('background: transparent')
    expect(catalog).not.toContain('border-radius')
    expect(catalog).not.toContain('box-shadow')
    expect(artwork).toContain('viewBox="0 0 1440 2960"')
    expect(artwork).not.toMatch(/<script|<foreignObject|https?:\/\/(?!www\.w3\.org)/i)
    expect(license).toContain('GNU GENERAL PUBLIC LICENSE')
  })

  test('phone identity delegates directly to its page-stack owner', async () => {
    const source = await readFile(join(directory, 'AssistantView.tsx'), 'utf8')
    const header = source.slice(source.indexOf('const MobileAssistantConversationHeader:'), source.indexOf('type AssistantListItemProps'))
    expect(header).toContain('if (onOpenSettings) {\n      onOpenSettings(assistant.id);\n      return;')
    expect(source).toContain('onOpenSettings={onMobileOpenSettings}')
  })

  test('preserves shared liquid-glass action material and focus in both themes', async () => {
    const css = await readFile(join(directory, 'assistant-workspace.css'), 'utf8')
    expect(css).toContain('[data-slot="button"]:not(.yuri-mobile-floating-action)) {\n  box-shadow: none !important;')
    expect(css).toContain('[data-slot="button"]:not(.yuri-mobile-floating-action):focus-visible')
    for (const [, selector] of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
      expect(selector.replaceAll(':not(.yuri-mobile-floating-action)', '')).not.toContain('.yuri-mobile-floating-action')
    }
  })

  test('keeps the dark avatar shadow and a single short scrim, with no light avatar shadow', async () => {
    const css = await readFile(join(directory, 'assistant-workspace.css'), 'utf8')
    const avatarShadow = css.match(/\.yuri-assistant-header-identity \[data-assistant-working-avatar\] \{([^}]+)\}/)?.[1]
    expect(avatarShadow).toContain('filter: drop-shadow(')
    expect(avatarShadow).toContain('light-dark(var(--surface-foreground), var(--surface-background))')
    expect(css).toContain(':root:not(.dark) .yuri-assistant-header-identity [data-assistant-working-avatar] {\n  filter: none;')
    const scrim = css.match(/\.yuri-assistant-mobile-header::before \{([^}]+)\}/)?.[1]
    expect(css).toContain('.yuri-assistant-mobile-header::after {\n  content: none;')
    expect(scrim).toContain('height: 4.5rem')
    expect(scrim).toContain('inset: 0 0 auto')
    expect(scrim).toContain('mask-image: linear-gradient(to right, transparent, currentColor 20%, currentColor 80%, transparent)')
    const header = css.match(/\.yuri-assistant-conversation-header \{([^}]+)\}/)?.[1]
    expect(header).toContain('padding-top: 0')
    const identity = css.match(/\.yuri-assistant-header-identity\[data-slot="button"\] \{([^}]+)\}/)?.[1]
    expect(identity).toContain('margin-top: 0.5rem')
    expect(css).toContain('padding: 0 0 0 var(--assistant-workspace-inset)')
    expect(css).toContain('padding-top: var(--yuri-safe-area-top, 0px)')
    const back = css.match(/\.yuri-mobile-detail-navigation-content > button \{([^}]+)\}/)?.[1]
    expect(back).toContain('margin-top: calc((0.5rem + 28px) * var(--dpt-n, 1))')
    expect(back).toContain('translate: 0 -50%')
  })
  test('keeps localized creation actions in populated desktop and mobile headers', async () => {
    const desktop = await readFile(join(directory, 'AssistantView.tsx'), 'utf8')
    const mobile = await readFile(join(directory, '../../mobile/assistant/MobileAssistantTab.tsx'), 'utf8')
    const desktopHeader = desktop.slice(desktop.indexOf('<section className="flex h-full'), desktop.indexOf('role="listbox"'))
    const mobileHeader = mobile.slice(mobile.indexOf('snapshot.data.assistants.length > 0'), mobile.indexOf('className="yuri-mobile-assistant-catalog"'))
    for (const header of [desktopHeader, mobileHeader]) {
      expect(header).toContain('type="button"')
      expect(header).toContain("aria-label={t('assistants.settings.create')}")
      expect(header).toContain('<Icon name="add"')
    }
    expect(desktopHeader).toContain('size="mobileIcon"')
    expect(desktopHeader).toContain('variant="mobileGlass"')
    expect(desktopHeader).toContain('min-w-0 truncate')
    expect(desktopHeader).toContain('<AssistantMarkAllReadButton snapshot={snapshot} compact rowClassName="flex min-w-0 flex-1 justify-end" />')
    expect(desktopHeader).toContain('onClick={openCreateSettings}')
    expect(mobileHeader).toContain('trailing={(')
    expect(mobileHeader).toContain('size="mobileIcon"')
    expect(mobileHeader).toContain('onClick={handleCreate}')
    const trailing = mobileHeader.slice(mobileHeader.indexOf('trailing={('), mobileHeader.indexOf('\n        )}'))
    expect(trailing).toContain('<AssistantMarkAllReadButton snapshot={snapshot.data} compact mobile />')
    expect(mobileHeader.match(/<AssistantMarkAllReadButton/g)).toHaveLength(1)
    expect(mobileHeader).not.toContain('rowClassName="flex justify-end pb-2"')
  })

  test('does not ensure an OpenCode session to show the contact transcript', async () => {
    const source = await readFile(join(directory, 'AssistantView.tsx'), 'utf8')
    expect(source).toContain('<AssistantConversationSurface')
    expect(source).not.toContain('ensureAssistantSession')
    expect(source).not.toContain('refreshBinding')
    expect(source).toContain('<AssistantHeaderIdentity assistant={assistant} onClick={openConversationSettings}')
    expect(source).toContain('<AssistantHeaderIdentity assistant={assistant} onClick={openSettings}')
    expect(source).toContain("t('assistants.conversation.openSettings')")
    expect(source).not.toContain('<AssistantContactStatus')
    expect(source).not.toContain('<Icon name="settings-3"')
    expect(source).toContain('openAssistantSettings(assistant.id')
    expect(source).toContain('yuri-assistant-header-name truncate')
    expect(source).toContain('yuri-assistant-catalog-panel')
    expect(source).toContain('yuri-assistant-conversation-header')
    expect(source).not.toContain('border-l border-[var(--surface-subtle)]')
    expect(source).toContain('size={56}')
  })

  test('pending capability or snapshot uses a loading spinner, not unavailable copy', async () => {
    const source = await readFile(join(directory, 'AssistantView.tsx'), 'utf8')
    expect(source).toContain('resolveAssistantWorkspacePresentation')
    expect(source).toContain('data-assistant-workspace-loading')
    expect(source).toContain("t('common.loading')")
    expect(source).toContain("name=\"loader-4\"")
    expect(source).not.toContain("isPending) return renderState('ai-agent', t('assistants.state.unavailable')")
    expect(source).toContain('snapshotSettled: snapshotQuery.isSuccess')
    expect(source).toContain('hasAssistant: Boolean(assistant)')
  })
})
