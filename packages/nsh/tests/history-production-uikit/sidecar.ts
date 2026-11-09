import { host } from 'nsh';

// No mount, state mutation, List, controller, timers or measurement. Production App owns all UI.
host.on('history.qa.clock.request', payload => {
  const nonce = (payload as { nonce?: unknown })?.nonce;
  if (typeof nonce !== 'string') return;
  void (async () => {
    const jsSendMs = performance.now();
    const reply = await host.call('history.qa.clock', { nonce, jsSendMs }) as { receivedNativeMs: number; returnedNativeMs: number };
    const jsReceiveMs = performance.now();
    await host.call('history.qa.clockAck', { nonce, jsSendMs, jsReceiveMs, receivedNativeMs: reply.receivedNativeMs, returnedNativeMs: reply.returnedNativeMs });
  })().catch(() => { console.error('history_qa_clock_exchange_failed'); });
});
void host.call('history.qa.ready', {}).catch(() => { console.error('history_qa_sidecar_not_ready'); });
