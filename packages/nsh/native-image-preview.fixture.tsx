import { mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { NativeContentImage, NativeImagePreview, type NativeImagePreviewItem } from './native-image-preview';

/** Only the preview module under test: renderers stand in for the lease-owned original. */
const draw = (id: string, color: string, fullscreen: boolean) => (
  <View testID={`fixture-${fullscreen ? 'full' : 'thumb'}-${id}`} style={{ width: '100%', height: '100%', backgroundColor: color }} />
);

const gallery: NativeImagePreviewItem[] = [
  { src: 'resource:fixture-lease-first', label: 'First image', intrinsicSize: { width: 400, height: 300 }, renderImage: fullscreen => draw('first', '#335577', fullscreen) },
  { src: 'resource:fixture-lease-second', label: 'Second image', intrinsicSize: { width: 300, height: 400 }, renderImage: fullscreen => draw('second', '#775533', fullscreen) },
];

function App() {
  const active = signal(true);
  const cardState = signal('card:closed');
  const cardHeight = signal(0);
  const cardClosed = signal(0);
  const lateMeta = signal(false);
  /** The owner's replacement sequence: the old source drops to `''`, then the new lease arrives. */
  const source = signal<'first' | 'loading' | 'second'>('first');
  const swapAt = signal(0);
  const swapClose = signal('swap-close:idle');
  const retireState = signal('retire:idle');
  let retirement: { close: () => Promise<void> } | null = null;
  const sheetOpen = signal(false);
  const sheetState = signal('sheet:idle');
  const emptyOpen = signal(false);
  const emptyState = signal('idle');
  const soloState = signal('solo:closed');
  const soloClosed = signal(0);
  const mountCard = signal(true);

  const openStandalone = () => {
    sheetOpen.set(true);
  };
  const openAndLoseFocus = () => {
    sheetOpen.set(true);
    setTimeout(() => active.set(false), 1500);
  };
  const openAndUnmountCard = () => {
    cardState.set('card:open');
    setTimeout(() => mountCard.set(false), 400);
  };
  const armRetirement = () => {
    setTimeout(() => {
      active.set(false);
      retireState.set('retire:closing');
      void retirement?.close().then(() => retireState.set('retire:done'));
    }, 2500);
  };
  const armSwap = () => {
    setTimeout(() => { swapAt.set(Date.now()); source.set('loading'); }, 1200);
    setTimeout(() => source.set('second'), 1320);
  };
  const armMeta = () => { setTimeout(() => lateMeta.set(true), 1200); };

  return <View class="flex-1 p-4 gap-3">
    <Text testID="fixture-caption">Native image preview fixture</Text>
    <Text testID="fixture-card-state">{cardState()}</Text>
    <Text testID="fixture-card-height">{`card-height:${cardHeight()}`}</Text>
    <Text testID="fixture-card-closed">{`card-closed:${cardClosed()}`}</Text>
    <Text testID="fixture-swap-close">{swapClose()}</Text>
    <Text testID="fixture-solo-state">{soloState()}</Text>
    <Text testID="fixture-solo-closed">{`solo-closed:${soloClosed()}`}</Text>
    <Text testID="fixture-retire-state">{retireState()}</Text>
    <Text testID="fixture-sheet-state">{sheetState()}</Text>
    <Text testID="fixture-empty-state">{`empty:${emptyState()}`}</Text>
    <Button testID="fixture-toggle-active" onPress={() => active.set(!active())}><Text>Toggle active</Text></Button>
    <Button testID="fixture-reset-active" onPress={() => active.set(true)}><Text>Reset active</Text></Button>
    <Button testID="fixture-late-meta" onPress={() => lateMeta.set(true)}><Text>Arrive metadata</Text></Button>
    <Button testID="fixture-retire-timer" onPress={armRetirement}><Text>Open then retire</Text></Button>
    <Button testID="fixture-swap-timer" onPress={armSwap}><Text>Open then replace source</Text></Button>
    <Button testID="fixture-meta-timer" onPress={armMeta}><Text>Open then arrive metadata</Text></Button>
    <If when={mountCard()}>
      <View class="flex-row items-start gap-3">
        <View onLayout={event => cardHeight.set(event.bounds.size.height)}>
          <NativeContentImage testID="fixture-thumb" frameWidth={160}
            src={source() === 'first' ? 'resource:fixture-lease-first'
              : source() === 'second' ? 'resource:fixture-lease-second' : ''}
            label="First image" active={active()} current={() => true}
            identity={source()}
            gallery={gallery} galleryIndex={0}
            width={lateMeta() ? 400 : undefined} height={lateMeta() ? 300 : undefined}
            renderImage={source() === 'loading' ? undefined
              : fullscreen => source() === 'first' ? draw('first', '#335577', fullscreen) : draw('second', '#775533', fullscreen)}
            retirementOwner={handle => { retirement = handle; }}
            onOpenChange={open => cardState.set(open ? 'card:open' : 'card:closed')}
            onClosed={() => cardClosed.set(cardClosed() + 1)} />
        </View>
        <NativeContentImage testID="fixture-solo" frameWidth={160}
          src={source() === 'first' ? 'resource:fixture-solo-first'
            : source() === 'second' ? 'resource:fixture-solo-second' : ''}
          label="Solo image" active={active()} current={() => true}
          identity={source()}
          width={lateMeta() ? 400 : undefined} height={lateMeta() ? 300 : undefined}
          renderImage={source() === 'loading' ? undefined
            : fullscreen => source() === 'first' ? draw('solo-first', '#335577', fullscreen) : draw('solo-second', '#775533', fullscreen)}
          onOpenChange={open => soloState.set(open ? 'solo:open' : 'solo:closed')}
          onClosed={() => {
            soloClosed.set(soloClosed() + 1);
            if (swapAt() > 0) swapClose.set(`swap-close:${Date.now() - swapAt()}`);
          }} />
      </View>
    </If>
    <Button testID="fixture-unmount-card" onPress={openAndUnmountCard}><Text>Open then unmount card</Text></Button>
    <Button testID="fixture-open-sheet" onPress={openStandalone}><Text>Open standalone viewer</Text></Button>
    <Button testID="fixture-open-fenced" onPress={openAndLoseFocus}><Text>Open then lose focus</Text></Button>
    <Button testID="fixture-open-empty" onPress={() => emptyOpen.set(true)}><Text>Open empty viewer</Text></Button>
    <NativeImagePreview open={sheetOpen()} items={gallery} index={0}
      sourceFrame={{ x: 20, y: 120, width: 200, height: 150 }}
      measureSource={() => Promise.resolve(null)}
      active={active()} current={() => true}
      onOpenChange={open => {
        sheetState.set(open ? 'sheet:open' : 'sheet:closed');
        sheetOpen.set(open);
      }}
      testID="fixture-sheet" />
    <NativeImagePreview open={emptyOpen()} items={[]} active={active()} current={() => true}
      onOpenChange={open => {
        emptyState.set(open ? 'open' : 'closed');
        emptyOpen.set(open);
      }}
      testID="fixture-empty" />
  </View>;
}

mount(App);
