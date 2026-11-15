/** Synthetic labels only; exercises the production text motion components. */
import { mount, setColorScheme, signal, Text, token, View } from 'nsh';
import { Button } from 'nsh/base';
import { NativeAnimatedNumber, NativeFlipUpText, NativeShimmerText } from './text-motion';

function App() {
  const value = signal('9.9s'), label = signal('Read 1 file'), enabled = signal(true);
  const style = () => ({ fontSize: 14, lineHeight: 20, color: token('muted-foreground') });
  return <View class="flex-1 bg-background p-5 gap-4">
    <NativeShimmerText testID="motion-shimmer" text="Thinking · 正在思考" active={enabled()} style={style()} />
    <View class="flex-row items-center gap-1.5">
      <NativeAnimatedNumber testID="motion-number" text={value()} active={enabled()} style={style()} />
      <Text style={style()}>elapsed</Text>
    </View>
    <NativeFlipUpText class="w-full" text={label()} active={enabled()} style={style()} />
    <View class="flex-row flex-wrap gap-2">
      <Button testID="motion-ten" onPress={() => value.set('10.0s')}><Text>10</Text></Button>
      <Button testID="motion-minute" onPress={() => value.set('1m 0s')}><Text>Minute</Text></Button>
      <Button testID="motion-shrink" onPress={() => value.set('9.9s')}><Text>Shrink</Text></Button>
      <Button testID="motion-summary" onPress={() => label.set('Read 2 files')}><Text>Summary</Text></Button>
      <Button testID="motion-burst" onPress={() => {
        label.set('Read 3 files');
        setTimeout(() => label.set('Read 4 files'), 40);
        setTimeout(() => label.set('Read 5 files'), 80);
      }}><Text>Burst</Text></Button>
      <Button testID="motion-stop" onPress={() => enabled.set(false)}><Text>Stop</Text></Button>
      <Button testID="motion-dark" onPress={() => setColorScheme('dark')}><Text>Dark</Text></Button>
      <Button testID="motion-delayed" onPress={() => { setTimeout(() => value.set('10.0s'), 800); }}><Text>Delayed</Text></Button>
    </View>
  </View>;
}
mount(App);
