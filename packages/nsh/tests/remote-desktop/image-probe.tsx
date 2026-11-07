import { Image, mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { remoteDesktopFixtureBrokenJPEG, remoteDesktopFixtureJPEG, remoteDesktopFixturePNG } from '../../remote-desktop-fixture-images';

/** Real primitive callbacks only. No simulated Image events, host live state or ACK. */
function ProbeImage(props: { name: string; source: string }) {
  const starts = signal(0), loads = signal(0), errors = signal(0), ends = signal(0), detail = signal('none');
  return <View class="gap-1">
    <Image testID={`probe-${props.name}-image`} src={props.source} style={{ width: 48, height: 32, objectFit: 'contain' }}
      onLoadStart={() => starts.set(starts() + 1)}
      onLoad={event => { loads.set(loads() + 1); detail.set(`decoded:${JSON.stringify(event.size)}`); }}
      onError={event => { errors.set(errors() + 1); detail.set(`error:${event.code ?? ''}:${event.message}`); }}
      onLoadEnd={() => ends.set(ends() + 1)} />
    <Text testID={`probe-${props.name}-events`}>{`${props.name}:start=${starts()};load=${loads()};error=${errors()};end=${ends()}`}</Text>
    <Text testID={`probe-${props.name}-detail`}>{`${props.name}:detail=${detail()}`}</Text>
  </View>;
}

function ImagePrimitiveProbe() {
  const size = signal('getSize:idle');
  return <View testID="remote-desktop-image-probe" class="flex-1 bg-background p-4 gap-3">
    <ProbeImage name="jpeg" source={remoteDesktopFixtureJPEG.source} />
    <ProbeImage name="png" source={remoteDesktopFixturePNG} />
    <ProbeImage name="broken" source={remoteDesktopFixtureBrokenJPEG} />
    <Button testID="probe-get-size" onPress={() => {
      size.set('getSize:pending');
      void Image.getSize(remoteDesktopFixturePNG).then(value => size.set(`getSize:success:${JSON.stringify(value)}`), error => size.set(`getSize:error:${String(error instanceof Error ? error.message : error)}`));
    }}><Text>Probe Image.getSize</Text></Button>
    <Text testID="probe-get-size-result">{size()}</Text>
  </View>;
}
mount(ImagePrimitiveProbe);
