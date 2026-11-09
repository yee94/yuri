import { host, mount, signal, Text, View, type ViewRef } from 'nsh';
import { Button, Dialog, Input } from 'nsh/base';

// Synthetic control messages only; no real Host, storage or network access.
function Contracts() {
  const calls = signal('');
  const focus = signal('none');
  const disabled = signal(false);
  const hidden = signal(false);
  const excluded = signal(false);
  const mounted = signal(true);
  const modal = signal(false);
  let button: ViewRef | undefined;
  let role: ViewRef | undefined;
  host.on('focus.control', (value: unknown) => {
    const action = (value as { action: string }).action;
    switch (action) {
      case 'focus-button': button?.focus(); break;
      case 'focus-role': role?.focus(); break;
      case 'blur-role': role?.blur(); break;
      case 'disable': disabled.set(true); break;
      case 'hide': hidden.set(true); break;
      case 'exclude': excluded.set(true); break;
      case 'destroy': mounted.set(false); break;
      case 'modal': modal.set(true); break;
      case 'close-modal': modal.set(false); break;
    }
  });
  return <View style={{ flex: 1 }}>
    <Button ref={button} onPress={() => calls.update(value => value + 'B')}>
      <Text>Ordinary Button</Text>
    </Button>
    <If when={mounted()}>{() => <View
      ref={role} role="button" testID="role-button"
      accessibilityState={{ disabled: disabled() }}
      accessibilityElementsHidden={excluded()}
      style={{ height: 32, visibility: hidden() ? 'hidden' : 'visible' }}
      onFocus={() => focus.set('role')} onPress={() => calls.update(value => value + 'R')}
    ><Text>Role Button View</Text></View>}</If>
    <View focusable={true} testID="non-pressable" style={{ height: 32 }} onFocus={() => focus.set('chart')}>
      <Text>Focusable chart</Text>
    </View>
    <Input testID="entry" style={{ height: 32 }} onFocus={() => focus.set('input')}
      submitBehavior="submit" onSubmit={() => calls.update(value => value + 'I')} />
    <View accessibilityState={{ disabled: true }}>
      <View role="button" onPress={() => calls.update(value => value + '!')}><Text>Disabled ancestor</Text></View>
    </View>
    <View importantForAccessibility="no-hide-descendants">
      <View role="button" onPress={() => calls.update(value => value + '!')}><Text>AX hidden ancestor</Text></View>
    </View>
    <View style={{ pointerEvents: 'none' }}>
      <View role="button" onPress={() => calls.update(value => value + '!')}><Text>No pointer ancestor</Text></View>
    </View>
    <Text>{`focus:${focus()}`}</Text>
    <Text>{`calls:${calls()}`}</Text>
    <Dialog open={modal()} onOpenChange={({ open }) => modal.set(open)}>
      <View style={{ flex: 1 }}>
        <View role="button" onFocus={() => focus.set('modal')} onPress={() => calls.update(value => value + 'M')}>
          <Text>Modal Button</Text>
        </View>
      </View>
    </Dialog>
  </View>;
}
mount(Contracts);
