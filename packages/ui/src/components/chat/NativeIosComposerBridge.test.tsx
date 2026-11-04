import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeIosComposerBridge, type UseNativeIosComposerArgs } from './useNativeIosComposer';
import { nativeIosComposerSession } from '@/lib/native-ios-composer-session';

const mocks = vi.hoisted(() => ({
    bind: vi.fn(), retain: vi.fn(), release: vi.fn(), update: vi.fn(async (_value: { text?: string }) => {}),
    palette: { background: '#808080', foreground: '#ffffff' },
}));
vi.mock('@/lib/native-ios-composer-session', () => ({ nativeIosComposerSession: {
    bind: mocks.bind, retain: mocks.retain, release: mocks.release,
    rememberText: vi.fn(), rememberState: vi.fn(),
} }));
vi.mock('@/lib/iosNativeUi', () => ({ useIosNativeUiEnabled: () => true }));
vi.mock('@/lib/useAgentAvatarPalette', () => ({ useAgentAvatarPalette: () => mocks.palette }));
vi.mock('@/contexts/useThemeSystem', () => ({ useOptionalThemeSystem: () => null }));
vi.mock('@/lib/native-ios-composer-leave', () => ({ attachNativeIosComposerLeaveConceal: () => () => {} }));
vi.mock('@/hooks/useModelLogo', () => ({ resolveModelLogoSrc: () => null }));
vi.mock('@/lib/native-ios-composer', async (original) => ({
    ...await original<typeof import('@/lib/native-ios-composer')>(),
    canUseNativeIosComposer: () => true,
    getNativeIosComposerPlugin: () => ({ update: mocks.update }),
    rasterizeLogoPngBase64: async () => '',
}));

const root = createRoot(document.createElement('div'));
afterEach(async () => { await act(async () => root.render(null)); vi.clearAllMocks(); });

it('sets native chrome before parent layout and retains once across text and draft changes', async () => {
    const onText = vi.fn();
    const onSend = vi.fn();
    const noop = () => {};
    const args: UseNativeIosComposerArgs = {
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
    const parentLayout = vi.fn();
    function Parent({ text, epoch = 0 }: { text: string; epoch?: number }) {
        React.useLayoutEffect(() => { parentLayout(document.documentElement.classList.contains('yuri-native-ios-composer')); }, []);
        return <NativeIosComposerBridge {...args} text={text} textPresetEpoch={epoch} onSend={value => onSend(text, value)} />;
    }
    await act(async () => root.render(<Parent text="first" />));
    expect(parentLayout).toHaveBeenCalledExactlyOnceWith(true);
    expect(nativeIosComposerSession.retain).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 50; i++) await act(async () => root.render(<Parent text={`edit ${i}`} />));
    expect(nativeIosComposerSession.retain).toHaveBeenCalledTimes(1);
    expect(nativeIosComposerSession.release).not.toHaveBeenCalled();
    await act(async () => root.render(<Parent text="next draft" epoch={1} />));
    const handlers = mocks.bind.mock.calls.at(-1)![0];
    handlers.onSend('submitted');
    expect(onSend).toHaveBeenCalledExactlyOnceWith('next draft', 'submitted');
    expect(mocks.update.mock.calls.some(([value]) => value.text === 'next draft')).toBe(true);
    await act(async () => root.render(null));
    expect(nativeIosComposerSession.release).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains('yuri-native-ios-composer')).toBe(false);
});
