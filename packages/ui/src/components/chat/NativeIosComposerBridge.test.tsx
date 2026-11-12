import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeIosComposerBridge, type UseNativeIosComposerArgs } from './useNativeIosComposer';
import { nativeIosComposerSession } from '@/lib/native-ios-composer-session';

const mocks = vi.hoisted(() => ({
    bind: vi.fn(), retain: vi.fn(), release: vi.fn(), update: vi.fn(async (_value: { text?: string }) => {}),
    present: vi.fn(async () => {}), hide: vi.fn(async () => {}), dismiss: vi.fn(async () => {}),
    listeners: new Map<string, (payload: Record<string, unknown>) => void>(),
    deferLogo: false, logos: [] as Array<(value: string) => void>,
    palette: { background: '#808080', foreground: '#ffffff' },
}));
vi.mock('@/lib/iosNativeUi', () => ({ useIosNativeUiEnabled: () => true }));
vi.mock('@/lib/useAgentAvatarPalette', () => ({ useAgentAvatarPalette: () => mocks.palette }));
vi.mock('@/contexts/useThemeSystem', () => ({ useOptionalThemeSystem: () => null }));
vi.mock('@/lib/native-ios-composer-leave', () => ({ attachNativeIosComposerLeaveConceal: () => () => {} }));
vi.mock('@/hooks/useModelLogo', () => ({ resolveModelLogoSrc: () => null }));
vi.mock('@/lib/native-ios-composer', async (original) => ({
    ...await original<typeof import('@/lib/native-ios-composer')>(),
    canUseNativeIosComposer: () => true,
    getNativeIosComposerPlugin: () => ({ update: mocks.update, present: mocks.present, hide: mocks.hide, dismiss: mocks.dismiss,
        addListener: async (name: string, callback: (payload: Record<string, unknown>) => void) => {
            mocks.listeners.set(name, callback);
            return { remove: async () => { if (mocks.listeners.get(name) === callback) mocks.listeners.delete(name); } };
        },
    }),
    rasterizeLogoPngBase64: () => mocks.deferLogo ? new Promise<string>((resolve) => { mocks.logos.push(resolve); }) : Promise.resolve(''),
}));

const root = createRoot(document.createElement('div'));
afterEach(async () => { await act(async () => root.render(null)); nativeIosComposerSession.shutdown(); mocks.deferLogo = false; mocks.logos = []; vi.clearAllMocks(); });

function composerArgs(onText = vi.fn(), onSend = vi.fn()): UseNativeIosComposerArgs {
    const noop = () => {};
    return {
        enabled: true, isMobile: true, text: '', textPresetEpoch: 0, placeholder: '',
        modelLabel: '', modelVariantLabel: '', canSend: true, canAbort: false,
        attachmentCount: 0, suppressed: false, attachAria: '', attachTitle: '',
        attachPhotosLabel: '', attachFilesLabel: '', attachCancelLabel: '', sendAria: '',
        queueAria: '', stopAria: '', modelAria: '', agentName: 'build', agentLabel: 'Build',
        agentAria: '', showScrollToBottom: false, scrollAria: '', attachments: [],
        removeAttachmentNamedAria: name => name,
        onText, onSend, onAbort: noop, onAttach: noop, onFiles: noop,
        onRemoveAttachment: noop, onOpenModel: noop, onCycleAgent: noop,
        onOpenAgent: noop, onScrollToBottom: noop,
    };
}

it('sets native chrome before parent layout and retains once across text and draft changes', async () => {
    const onText = vi.fn();
    const onSend = vi.fn();
    const args = composerArgs(onText, onSend);
    const parentLayout = vi.fn();
    function Parent({ text, epoch = 0 }: { text: string; epoch?: number }) {
        React.useLayoutEffect(() => { parentLayout(document.documentElement.classList.contains('yuri-native-ios-composer')); }, []);
        return <NativeIosComposerBridge {...args} text={text} textPresetEpoch={epoch} onSend={value => onSend(text, value)} />;
    }
    await act(async () => root.render(<Parent text="first" />));
    expect(parentLayout).toHaveBeenCalledExactlyOnceWith(true);
    expect(mocks.present).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 50; i++) await act(async () => root.render(<Parent text={`edit ${i}`} />));
    expect(mocks.present).toHaveBeenCalledTimes(1);
    expect(mocks.hide).not.toHaveBeenCalled();
    await act(async () => root.render(<Parent text="next draft" epoch={1} />));
    mocks.listeners.get('send')?.({ text: 'submitted' });
    expect(onSend).toHaveBeenCalledExactlyOnceWith('next draft', 'submitted');
    expect(mocks.update.mock.calls.some(([value]) => value.text === 'next draft')).toBe(true);
    await act(async () => root.render(null));
    expect(mocks.hide).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains('yuri-native-ios-composer')).toBe(false);
});

it('inactive mounted bridge cannot steal handlers, update chrome or hide the successor', async () => {
    const firstText = vi.fn(); const nextText = vi.fn();
    const first = composerArgs(firstText); const next = composerArgs(nextText);
    const render = (foreground: 'first' | 'next', keepFirst = true) => act(async () => root.render(<>
        {keepFirst ? <NativeIosComposerBridge key="first" {...first} enabled={foreground === 'first'} text="first" /> : null}
        <NativeIosComposerBridge key="next" {...next} enabled={foreground === 'next'} text="next" />
    </>));
    await render('first');
    const oldText = mocks.listeners.get('textChanged')!;
    await act(async () => oldText({ text: 'first edit' }));
    expect(firstText).toHaveBeenCalledOnce(); expect(nextText).not.toHaveBeenCalled();
    await render('next');
    expect(mocks.present).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'next' }));
    const hides = mocks.hide.mock.calls.length;
    const updates = mocks.update.mock.calls.length;
    await act(async () => oldText({ text: 'stale first event' }));
    expect(firstText).toHaveBeenCalledOnce(); expect(nextText).not.toHaveBeenCalled();
    for (let index = 0; index < 50; index++) await render('next');
    expect(mocks.update).toHaveBeenCalledTimes(updates);
    await render('next', false);
    expect(mocks.hide).toHaveBeenCalledTimes(hides);
    expect(document.documentElement.classList.contains('yuri-native-ios-composer')).toBe(true);
    await act(async () => mocks.listeners.get('textChanged')?.({ text: 'next edit' }));
    expect(nextText).toHaveBeenCalledExactlyOnceWith('next edit', false, null);
    expect(firstText).toHaveBeenCalledOnce();
});

it('a deferred Web send checks the captured native owner after a handoff', async () => {
    const submit = vi.fn();
    const args = composerArgs();
    let deferred!: () => void;
    await act(async () => root.render(<NativeIosComposerBridge {...args} onSend={(_text, isCurrent) => {
        deferred = () => { if (isCurrent()) submit(); };
    }} />));
    mocks.listeners.get('send')?.({ text: 'captured' });
    await act(async () => root.render(<NativeIosComposerBridge key="successor" {...args} text="other draft" />));
    deferred();
    expect(submit).not.toHaveBeenCalled();
});

it('superseded still-mounted primary cannot rebind or clear the new primary on cleanup', async () => {
    const firstText = vi.fn(); const secondText = vi.fn();
    const first = composerArgs(firstText); const second = composerArgs(secondText);
    const render = (keepFirst: boolean) => act(async () => root.render(<>
        {keepFirst ? <NativeIosComposerBridge key="first" {...first} text="old" /> : null}
        <NativeIosComposerBridge key="second" {...second} text="foreground" />
    </>));
    await render(true);
    expect(mocks.present).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'foreground' }));
    for (let index = 0; index < 50; index++) await render(true);
    const hides = mocks.hide.mock.calls.length;
    await render(false);
    expect(mocks.hide).toHaveBeenCalledTimes(hides);
    expect(document.documentElement.classList.contains('yuri-native-ios-composer')).toBe(true);
    mocks.listeners.get('textChanged')?.({ text: 'new input' });
    expect(firstText).not.toHaveBeenCalled();
    expect(secondText).toHaveBeenCalledExactlyOnceWith('new input', false, null);
});

it('late artwork from a departed Host cannot publish into the successor props', async () => {
    mocks.deferLogo = true;
    const args = composerArgs();
    await act(async () => root.render(<NativeIosComposerBridge key="A" {...args} agentName="A" />));
    const first = mocks.logos[0];
    await act(async () => root.render(<NativeIosComposerBridge key="B" {...args} agentName="B" />));
    const second = mocks.logos[1];
    mocks.update.mockClear();
    await act(async () => first('stale A icon'));
    expect(mocks.update).not.toHaveBeenCalled();
    await act(async () => second('current B icon'));
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({ agentIcon: 'current B icon' });
});
