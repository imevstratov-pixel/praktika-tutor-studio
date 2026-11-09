import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer as httpServer} from 'node:http';
import {once} from 'node:events';
import {createServer as viteServer} from 'vite';
import {localApiProxy} from '../vite.config.mjs';
import {makeServer} from '../../local/server.mjs';

async function serve(server,t) {
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  server.listen(0,'127.0.0.1');
  await once(server,'listening',{signal:AbortSignal.timeout(1500)});
  return 'http://127.0.0.1:'+server.address().port;
}
test('Vite proxy serves API and only rewrites a matching local page origin', {timeout:15000}, async t=>{
  let calls=0;
  const excerpt='Риск — событие, которое может помешать достижению цели проекта.';
  const evidence=[{id:'e1',quote:excerpt}];
  const graph={title:'Проба',topics:[{id:'t1',name:'Риски',summary:'У проекта бывают риски.',evidence}],
    terms:[{id:'k1',name:'Риск',definition:'Событие, которое может помешать достижению цели проекта.',topicIds:['t1'],evidence}],links:[]};
  const model=await serve(httpServer(async(req,res)=>{
    for await(const block of req) { /* Drain the request. */ }
    calls++;
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(graph)},finish_reason:'stop'}]}));
  }),t);
  const {server}=makeServer({TUTOR_PROVIDER:'compatible',TUTOR_MODEL:'test-model',TUTOR_API_BASE:model+'/v1'});
  const backend=await serve(server,t);
  const vite=await viteServer({
    configFile:false,root:new URL('../',import.meta.url).pathname,logLevel:'silent',
    server:{host:'127.0.0.1',port:0,hmr:false,watch:null,proxy:{'/api':localApiProxy(backend)}},
    optimizeDeps:{noDiscovery:true}
  });
  t.after(async()=>{vite.httpServer?.closeAllConnections();await vite.close();});
  await vite.listen();
  const page='http://127.0.0.1:'+vite.httpServer.address().port;
  const status=await fetch(page+'/api/status',{signal:AbortSignal.timeout(2500)});
  assert.equal(status.status,200);
  assert.equal((await status.json()).ai,true);
  const post=origin=>fetch(page+'/api/structure',{method:'POST',signal:AbortSignal.timeout(2500),headers:{
    'Content-Type':'application/json',...(origin?{Origin:origin}:{})
  },body:JSON.stringify({text:excerpt})});
  assert.equal((await post('https://untrusted.example')).status,403);
  assert.equal((await post(backend)).status,403);
  assert.equal((await post()).status,403);
  const success=await post(page);
  assert.equal(success.status,200);
  assert.equal((await success.json()).terms[0].name,'Риск');
  assert.equal(calls,1);
});
