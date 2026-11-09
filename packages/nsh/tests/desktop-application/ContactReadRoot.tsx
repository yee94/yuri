import { host, mount, View } from 'nsh';
import { YuriNativeApp } from '../../application';

// Observe the public native-ref measurement result without changing any value,
// event, product component, controller, List, writer or transport.
const probe = View({});
const prototype = Object.getPrototypeOf(probe);
const measure = prototype.measure;
const snapshot = prototype.getScrollSnapshot;
let held = (host.params as Record<string, unknown>).holdReadMeasure === true;
let heldSnapshot = (host.params as Record<string, unknown>).holdReadSnapshot === true;
const waiters: Array<() => void> = [];
const snapshotWaiters: Array<() => void> = [];
host.on('contact-read.test.control', input => {
  const action = (input as { action?: string }).action;
  if (action === 'releaseSnapshotOne') { snapshotWaiters.shift()?.(); return; }
  held = action === 'hold';
  heldSnapshot = action === 'holdSnapshot';
  if (!held) waiters.splice(0).forEach(resolve => resolve());
  if (!heldSnapshot) snapshotWaiters.splice(0).forEach(resolve => resolve());
});
prototype.getScrollSnapshot = async function () {
  const value = await snapshot.call(this);
  host.post('contact-read.test.metric', { phase: 'snapshot', value });
  if (heldSnapshot && value) {
    host.post('contact-read.test.metric', { phase: 'heldSnapshot', value });
    await new Promise<void>(resolve => snapshotWaiters.push(resolve));
  }
  return value;
};
prototype.measure = async function () {
  const value = await measure.call(this);
  host.post('contact-read.test.metric', { phase: 'measure', value });
  if (held && value?.bounds.size.width === 1 && value.bounds.size.height === 1) {
    host.post('contact-read.test.metric', { phase: 'held', value });
    await new Promise<void>(resolve => waiters.push(resolve));
  }
  return value;
};
mount(YuriNativeApp);
