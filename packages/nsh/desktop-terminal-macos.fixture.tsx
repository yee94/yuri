import { mount, nativeComponent, signal, host, View, type NativeComponentRef } from 'nsh';

/** Isolated real WKWebView carrier. No state/application/Vault/PTY imports. */
const Terminal = nativeComponent<{ owner: string; generation: number; expectedHost: object; active: boolean; configuration: object }, { terminal: Record<string, unknown> }>('yuri.terminal.viewport', {
  props: ['owner','generation','expectedHost','active','configuration'], events: ['terminal'],
});
function Fixture() {
  const reference = signal<NativeComponentRef | null>(null);
  const width = signal(700);
  host.on('terminal.fixture.resize', () => width.set(600));
  const authority = { owner:'synthetic-renderer', generation:1, expectedHost:{hostID:'synthetic-host',lease:'00000000-0000-4000-8000-000000000007'} };
  return <View class="flex-1"><Terminal {...authority} active style={{width:width(),height:300}} ref={value => reference.set(value)} configuration={{
    palette:{background:'#ffffff',foreground:'#212121',cursor:'#212121',selectionBackground:'#cccccc'},family:'monospace',size:13,lineHeight:1.625,label:'Synthetic terminal',
  }} onLayout={event=>reference()?.command('layout',{...authority,...event.bounds.size})} onTerminal={event => {
    void host.call('terminal.fixture.event', event);
    if (event.type==='ready') reference()?.command('render', {...authority,type:'render',key:'synthetic-tab',live:true,serial:1,chunks:[{id:1,data:'\x1b[32mSYNTHETIC_OUTPUT\x1b[0m\r\n'},{id:2,data:'READY> '}]});
    if (event.type==='ack') reference()?.command('focus', authority);
    if (event.type==='input') reference()?.command('inputResult', {...authority,key:event.key,receipt:event.receipt,status:'accepted'});
  }} /></View>;
}
mount(Fixture);
