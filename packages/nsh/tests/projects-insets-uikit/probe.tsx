import { host, nativeComponent, type ViewRef, type Bounds } from 'nsh';

const Anchor = nativeComponent<{ probeName: string }>('fixture.insets.anchor', { props: ['probeName'] });
const refs = new Map<string, ViewRef>();
const events: Record<string, Bounds> = {};
let consumerMarker = '';

export function markLayoutConsumer(marker: string) {
  consumerMarker = marker;
  void host.call('fixture.insets.consumer', { marker }).catch(() => {});
}

export function LayoutProbe(props: { name: string }) {
  return <Anchor probeName={props.name} accessible={false} accessibilityElementsHidden style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }} />;
}
export function layoutRef(name: string) {
  return (ref: ViewRef | null) => { if (ref) refs.set(name, ref); else refs.delete(name); };
}
export function layoutEvent(name: string, event: { bounds: Bounds }) { events[name] = event.bounds; }
export function installCapture() {
  host.on('fixture.insets.capture', request => {
    void Promise.all([...refs].map(async ([key, ref]) => ({ key, measurement: await ref.measure() })))
      .then(measurements => host.call('fixture.insets.report', { request, consumerMarker, events, measurements }))
      .catch(error => host.call('fixture.insets.report', { error: String(error) }));
  });
}
