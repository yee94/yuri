import { mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';

function Fixture() {
  const calls = signal(0);
  return <View>
    <Button testID="generic-button" onPress={() => calls.update(value => value + 1)}><Text>Generic button</Text></Button>
    <Text>{`calls:${calls()}`}</Text>
  </View>;
}
mount(Fixture);
