import assert from 'node:assert/strict';
import { createHostHandshake, exportPublicKeyJwk, generateEcdhKeyPair } from '../web/server/lib/relay/e2ee.js';
import { createTunnelHost } from '../web/server/lib/relay/tunnel-host.js';
const keys = await generateEcdhKeyPair(), publicKey = await exportPublicKeyJwk(keys.publicKey);
let rpcCount = 0, redirected = 0;
let laneSequence = 0;
const lanes = new Map();
const started = new Set();
const produced = new Map();
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0,
  async fetch(request, server) {
    const url = new URL(request.url), origin = `http://127.0.0.1:${server.port}`;
    if (url.pathname === '/config') return Response.json({ origin, relayUrl:`ws://127.0.0.1:${server.port}/relay`, serverId:'gui-fixture', hostEncPubJwk:publicKey });
    if (url.pathname === '/relay') { assert.equal(request.headers.get('authorization'), null); server.upgrade(request, {data:{kind:'relay',id:++laneSequence,handshake:createHostHandshake(keys.privateKey),chain:Promise.resolve(),outbound:Promise.resolve()}}); return; }
    if (url.pathname === '/api/terminal/ws' && request.headers.get('upgrade') === 'websocket') {
      assert.equal(url.searchParams.get('yuri_url_token'),'synthetic-scoped');
      assert.equal(request.headers.get('origin'),origin);
      server.upgrade(request,{data:{kind:'terminal'}});return;
    }
    if (url.pathname === '/wrong') { redirected++; return new Response('forbidden'); }
    if (url.pathname === '/stats') return Response.json({rpcCount,redirected,started:[...started],produced:Object.fromEntries(produced),lanes:[...lanes.values()]});
    assert.equal(request.headers.get('authorization'), 'Bearer synthetic-gui');
    if (url.pathname === '/auth/url-token') return Response.json({token:'synthetic-scoped',expiresAt:Date.now()+60000});
    if (url.pathname === '/api/system/free-port') return Response.json({port:8123});
    if (url.pathname === '/api/fs/stat') return Response.json({exists:true});
    if (url.pathname === '/api/yuri/events' || url.pathname === '/api/event') {
      let timer;
      const key = url.pathname === '/api/event' ? 'chat' : 'global';
      const tick = new TextEncoder().encode(`data: ${JSON.stringify({type:`gui.isolation.${key}.tick`})}\n\n`);
      return new Response(new ReadableStream({start(controller){
        controller.enqueue(tick);
        timer=setInterval(()=>controller.enqueue(tick),100);
      },cancel(){clearInterval(timer);}}),{headers:{'content-type':'text/event-stream'}});
    }
    if (url.pathname === '/api/rpc/synthetic/echo') {
      rpcCount++;
      assert.equal(request.headers.get('accept'), 'application/json');
      assert.equal(request.headers.get('content-type'), 'application/json');
      assert.equal(request.headers.get('x-opencode-directory'), '/synthetic');
      assert.equal(request.headers.get('x-yuri-gui-revision'), 'a'.repeat(64));
      return new Response(await request.arrayBuffer(), {status:422,headers:{'content-type':'application/json','x-yuri-gui-code':'full','set-cookie':'hidden'}});
    }
    assert.equal(request.headers.get('accept'), 'application/javascript');
    const name = url.searchParams.get('path');
    started.add(name);
    if (name === 'void') return new Response(null,{status:204});
    if (name === 'empty' || name === 'missing') return new Response('',{headers:{'content-type':'text/plain','x-yuri-file-exists':name==='empty'?'true':'false'}});
    if (name === 'redirect') return Response.redirect(origin + '/wrong',302);
    if (name?.startsWith('pending-')) return new Promise(resolve=>request.signal.addEventListener('abort',()=>resolve(new Response(null,{status:499})),{once:true}));
    if (name === 'blocked') return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([65]));}}),{headers:{'content-type':'application/javascript'}});
    let remaining = name === 'large' || name === 'paused' ? 33 * 1024 * 1024 + 65536 : 1;
    produced.set(name,0);
    return new Response(new ReadableStream({pull(controller) {
      if (!remaining) {controller.close();return;}
      const size = Math.min(65536,remaining); remaining -= size; produced.set(name,produced.get(name)+size); controller.enqueue(new Uint8Array(size).fill(65));
    }}),{headers:{'content-type':'application/javascript; charset=utf-8','x-yuri-file-exists':'true','set-cookie':'hidden'}});
  },
  websocket:{
    open(ws) {if(ws.data.kind==='terminal')ws.send('connected');},
    message(ws,raw) {
      if(ws.data.kind==='terminal'){if(typeof raw==='string')ws.send(raw);else ws.sendBinary(raw);return;}
      ws.data.chain=ws.data.chain.then(async()=>{
      if(typeof raw==='string') {
        const action=await ws.data.handshake.handleText(raw); if(action.type!=='established')return;
        ws.data.channel=action.channel;
        const audit={id:ws.data.id,requests:[],pongs:0,closed:false};lanes.set(ws.data.id,audit);
        const sendFrame=frame=>{ws.data.outbound=ws.data.outbound.then(async()=>ws.send(await ws.data.channel.encryptor.encrypt(frame)));return ws.data.outbound;};
        ws.data.mux=createTunnelHost({connectionId:'gui-fixture',getLocalPort:()=>server.port,getBufferedAmount:()=>ws.getBufferedAmount(),
          authorizeRequest:async req=>{
            audit.requests.push(req.url);
            if(req.headers.upgrade==='websocket')return new URL(req.url,`http://127.0.0.1:${server.port}`).searchParams.get('yuri_url_token')==='synthetic-scoped';
            return (req.headers.Authorization??req.headers.authorization)==='Bearer synthetic-gui';
          },sendFrame});
        ws.data.ping=setInterval(()=>sendFrame(new Uint8Array([11,0,0,0,0])).catch(()=>{}),200);
        ws.send(action.replyText);return;
      }
      const frame=await ws.data.channel.decryptor.decrypt(raw);
      if((frame[0]&0x7f)===12)lanes.get(ws.data.id).pongs++;
      await ws.data.mux.handleFrame(frame);
    }).catch(error=>{console.error(error);ws.close();});},
    close(ws) {clearInterval(ws.data.ping);const audit=lanes.get(ws.data.id);if(audit)audit.closed=true;ws.data.mux?.close();},
  },
});
console.log(`http://127.0.0.1:${server.port}/config`);
