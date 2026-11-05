import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

describe('StatusRowContainer source contracts', () => {
  const source = readFileSync(join(here, 'StatusRowContainer.tsx'), 'utf8')
  const messageListSource = readFileSync(join(here, 'MessageList.tsx'), 'utf8')

  test('keeps generic busy thinking visible while the turn is working', () => {
    // First-prompt claim often has no tool/reasoning/text part yet. Hiding that
    // generic WorkingPlaceholder left a blank slot under the model header while
    // Stop stayed armed. Concrete parts still replace the generic phrase.
    expect(source).toContain('const showAssistantStatus = working.isWaitingForPermission')
    expect(source).toContain('|| working.isWorking')
    expect(source).toContain('showAssistantStatus={showAssistantStatus}')
    expect(source).not.toContain('|| !working.isGenericStatus')
  })

  test('classic live status slot mounts inside the markdown pin-reveal root', () => {
    expect(messageListSource).toContain('liveStatusSlot?: React.ReactNode')
    expect(messageListSource).toContain('{liveStatusSlot}')
    const pinRoot = messageListSource.indexOf('ref={setTanstackPinRoot}')
    const slot = messageListSource.indexOf('{liveStatusSlot}')
    const pinRootClose = messageListSource.indexOf('</div>', messageListSource.indexOf('<StreamingTailContent'))
    expect(pinRoot).toBeGreaterThan(-1)
    expect(slot).toBeGreaterThan(pinRoot)
    expect(slot).toBeLessThan(pinRootClose)
  })

  test('mobile Tasks shares the Changes type scale without changing desktop typography', () => {
    const statusRowSource = readFileSync(join(here, 'StatusRow.tsx'), 'utf8')
    const sharedStylesSource = readFileSync(join(here, 'statusBarPopover.ts'), 'utf8')
    const typeScale = 'text-xs leading-4 md:text-[0.8125rem] md:leading-5'

    for (const token of typeScale.split(' ')) expect(sharedStylesSource).toContain(token)
    expect(statusRowSource).toContain('cn(statusBarTriggerLabelClassName, "text-muted-foreground")')
    expect(statusRowSource).toContain(`isMobile ? "${typeScale}" : "text-base"`)
    expect(statusRowSource).toContain('isMobile && "[&_[dir=auto]]:text-[1em]"')
    expect(statusRowSource).toContain('!isMobile && "text-[0.88em]"')
  })
})
