import { describe, expect, it } from 'vitest';
import { bot, featureFixture, settle } from './tests/features-fixture';

describe('Bot owner navigation callback seam (no engine)', () => {
  it('uses the same dirty confirmation, cancel retains draft, concurrent discard invokes callback only once', async () => {
    let leave: ((afterLeave?: () => void) => Promise<void>) | null = null;
    const f = featureFixture({ bot, onNavigation: callback => { leave = callback; } });
    const root = f.element('bot'); await settle();
    const requestLeave = leave as unknown as (afterLeave?: () => void) => Promise<void>;
    (f.find(root, node => node.props.testID === 'features-bot-name').props.onChange as (event: { value: string }) => void)({ value: 'Unsaved bot' });
    let navigated = 0;
    await requestLeave(() => { navigated++; });
    expect(f.dialogs).toHaveLength(1); expect(navigated).toBe(0); expect(f.done()).toBe(0);
    f.setAnswer('discard');
    const first = requestLeave(() => { navigated++; });
    const concurrent = requestLeave(() => { navigated += 100; });
    await Promise.all([first, concurrent]);
    expect(f.dialogs).toHaveLength(2); expect(navigated).toBe(1); expect(f.done()).toBe(0);
    f.unmount(); expect(leave).toBeNull();
  });
  it('pristine leaves immediately; default callback remains onDone; stale confirmation does not navigate', async () => {
    let leave: ((afterLeave?: () => void) => Promise<void>) | null = null;
    const f = featureFixture({ bot, onNavigation: callback => { leave = callback; } });
    const root = f.element('bot'); await settle();
    const requestLeave = leave as unknown as (afterLeave?: () => void) => Promise<void>;
    let navigated = 0;
    await requestLeave(() => { navigated++; }); expect(navigated).toBe(1); expect(f.dialogs).toHaveLength(0);
    await requestLeave(); expect(f.done()).toBe(1);
    (f.find(root, node => node.props.testID === 'features-bot-name').props.onChange as (event: { value: string }) => void)({ value: 'Dirty' });
    f.setAnswer('discard'); const pending = requestLeave(() => { navigated++; }); f.changeHost(); await pending;
    expect(navigated).toBe(1); f.unmount(); expect(leave).toBeNull();
  });
});
