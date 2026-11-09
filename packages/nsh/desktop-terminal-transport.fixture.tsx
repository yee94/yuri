import { host } from 'nsh';
import { createTerminalWorkspace, type TerminalSnapshot } from './terminal-core';

/** Real QuickJS + native Host + real Network carrier; backend is synthetic and
 * never runs a shell. No app/state/connection/credential imports. */
async function run() {
  const expectedHost={hostID:'synthetic-host',lease:'00000000-0000-4000-8000-000000000007'};
  const check=(value:unknown,message:string)=>{if(!value)throw new Error(message);};
  let snapshot:TerminalSnapshot|undefined;
  const watchers=new Set<()=>void>();
  const until=(predicate:()=>boolean)=>new Promise<void>((resolve,reject)=>{
    let timer:ReturnType<typeof setTimeout>;
    const receive=()=>{if(predicate()){clearTimeout(timer);watchers.delete(receive);resolve();}};
    timer=setTimeout(()=>{watchers.delete(receive);reject(new Error('synthetic state deadline'));},10000);watchers.add(receive);receive();
  });
  const capability=await host.call('terminal.capabilities',{expectedHost});
  check(capability&&typeof capability==='object'&&'sseOutput' in capability&&capability.sseOutput===true,'actual SSE capability');
  const catalog=await host.call('terminal.catalog.read',{expectedHost});
  const controller=createTerminalWorkspace({scope:expectedHost,catalog,
    call:(name,body)=>host.call(name,body),subscribe:listener=>host.on('terminal.event',listener),
    changed:value=>{snapshot=value;for(const receive of watchers)receive();},
    persist:async value=>{check(await host.call('terminal.catalog.write',{expectedHost,catalog:value})===true,'durable metadata');},
  });
  try {
    check(controller.setDirectory('c:\\Synthetic\\项目'),'Windows cwd');controller.setActive(true);
    check(!snapshot?.tabs[0].sessionId,'no unmeasured create');controller.resize({cols:80,rows:24});
    if(host.params.scenario==='create-unknown'){
      await until(()=>snapshot?.tabs[0].createUnknown===true&&snapshot.tabs[0].phase==='failed');
      controller.retry();controller.setActive(false);controller.setActive(true);
      const owner=snapshot!.activeId!;
      check(await controller.closeTab(owner)===false,'unknown create must not fake close');
      await controller.flushPersistence();
      check(snapshot!.tabs.length===1&&snapshot!.tabs[0].createUnknown===true,'unknown prior remains');
      return {ok:true,unknown:true};
    }
    await until(()=>snapshot?.tabs[0].phase==='live'&&snapshot.tabs[0].chunks.some(chunk=>chunk.data==='SYNTHETIC_中文'));
    check(snapshot?.directory==='C:/Synthetic/项目','normalized Host path');
    check(await controller.inputOutcome('中\0\r\n')==='accepted','real text/plain input receipt');
    controller.resize({cols:100,rows:30});
    // This wait is a fixture synchronization point, not production polling.
    await new Promise(resolve=>setTimeout(resolve,100));
    const owner=snapshot!.activeId!;
    check(await controller.closeTab(owner)===false,'failed close must remain visible');
    check(snapshot!.tabs.some(tab=>tab.id===owner&&tab.error==='close_unconfirmed'),'prior tab retained');
    check(await controller.closeTab(owner)===true,'explicit close retry');
    controller.setActive(false);await controller.flushPersistence();
    let stale=false;try{await host.call('terminal.create',{expectedHost:{...expectedHost,lease:'00000000-0000-4000-8000-000000000008'},owner:'forbidden',directory:'/synthetic',cols:80,rows:24});}catch{stale=true;}
    check(stale,'old scope must not dispatch');
    return {ok:true,directory:snapshot!.directory,creates:snapshot!.tabs.length};
  } finally {controller.dispose();}
}
void run().then(value=>host.post('terminal.fixture.result',value),error=>host.post('terminal.fixture.result',{error:String(error)}));
