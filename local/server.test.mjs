import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request as httpRequest} from 'node:http';
import {once} from 'node:events';
import {makeServer, excerptsFrom, validateGraph} from './server.mjs';

const text = 'Цель проекта описывает ожидаемое изменение. Задача — конкретная работа, необходимая для достижения цели.';
const evidence = [{id:'e1',quote:'Цель проекта описывает ожидаемое изменение.'}];
const graph = {
  title:'Проект',topics:[{id:'t1',name:'Планирование',summary:'В проекте формулируют цель.',evidence}],
  terms:[{id:'k1',name:'Цель проекта',definition:'Ожидаемое изменение.',topicIds:['t1'],evidence}],
  links:[{from:'k1',to:'t1',relation:'используется при',evidence}]
};
const limit = {timeout:6000};
const envelope = (value = graph) => JSON.stringify({choices:[{message:{content:JSON.stringify(value)},finish_reason:'stop'}]});
const fetchBounded = (url, options={}) => fetch(url,{...options,signal:options.signal
  ? AbortSignal.any([options.signal,AbortSignal.timeout(2500)]) : AbortSignal.timeout(2500)});
async function within(promise, timeout=2000) {
  let timer;
  try {
    return await Promise.race([promise,new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('Expected server event timed out')),timeout);
    })]);
  } finally { clearTimeout(timer); }
}
async function listen(server,t) {
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  server.listen(0,'127.0.0.1');
  await once(server,'listening',{signal:AbortSignal.timeout(1500)});
  return 'http://127.0.0.1:' + server.address().port;
}
async function service(t,provider,extra={}) {
  const {server}=makeServer(provider ? {
    TUTOR_PROVIDER:'compatible',TUTOR_MODEL:'test-model',TUTOR_API_BASE:provider+'/v1',...extra
  } : {TUTOR_PROVIDER:'off',...extra});
  return listen(server,t);
}
function post(site,body={text},options={}) {
  return fetchBounded(site+'/api/structure',{method:'POST',body:JSON.stringify(body),
    ...options,headers:{Origin:site,'Content-Type':'application/json',...options.headers}});
}
async function errorStatus(response,status) {
  assert.equal(response.status,status);
  const value=await response.json();
  assert.equal(typeof value.error,'string');
  assert(value.error.length>0);
}
function chunked(site,body,headers={}) {
  return new Promise((resolve,reject) => {
    const req=httpRequest(site+'/api/structure',{method:'POST',headers:{
      Origin:site,'Content-Type':'application/json','Transfer-Encoding':'chunked',...headers
    }},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));
      res.on('error',reject);
    });
    req.setTimeout(2000,()=>req.destroy(new Error('Chunked request timed out')));
    req.on('error',reject);
    req.write(body.slice(0,120000));
    req.end(body.slice(120000));
  });
}

test('configuration rejects unsupported, insecure, and incomplete settings',() => {
  for (const env of [
    {TUTOR_PROVIDER:'unknown'},
    {TUTOR_PROVIDER:'off',TUTOR_PORT:'0'},
    {TUTOR_PROVIDER:'off',TUTOR_PORT:'65536'},
    {TUTOR_PROVIDER:'compatible',TUTOR_API_BASE:'https://example.com/v1'},
    {TUTOR_PROVIDER:'compatible',TUTOR_MODEL:'m',TUTOR_API_BASE:'http://example.com/v1'},
    {TUTOR_PROVIDER:'compatible',TUTOR_MODEL:'m',TUTOR_API_BASE:'https://user:password@example.com/v1'},
    {TUTOR_PROVIDER:'ollama',TUTOR_API_BASE:'https://example.com/v1'}
  ]) assert.throws(()=>makeServer(env));
});

test('graph validation rejects invented quotations, missing references, duplicates, self-links and oversized collections',()=> {
  for (const mutate of [
    x=>x.terms[0].evidence[0].quote='такой фразы нет',
    x=>x.terms[0].evidence[0].id='e99',
    x=>x.terms[0].topicIds=['t8'],
    x=>x.links[0].to='k1',
    x=>x.links[0].to='k99',
    x=>x.topics.push({...x.topics[0],id:'t2'}),
    x=>x.terms[0].id=['k1'],
    x=>x.links.push(structuredClone(x.links[0])),
    x=>x.topics=Array.from({length:9},(_,i)=>({...x.topics[0],id:'t'+(i+1),name:'Тема '+i}))
  ]) {
    const input=structuredClone(graph);mutate(input);
    assert.throws(()=>validateGraph(input,excerptsFrom(text),''),e=>e.status===502);
  }
});

test('source splitting preserves content and complete Unicode characters',()=> {
  const paragraphs=(text+'\n\n').repeat(20).trim();
  const excerpts=excerptsFrom(paragraphs);
  assert(excerpts.length>1);
  for(const entry of excerpts) assert(paragraphs.includes(entry.text)&&entry.text.length<=420);
  assert.equal(excerpts.map(e=>e.text).join(' ').replace(/\s+/g,' '),paragraphs.replace(/\s+/g,' '));
  const unicode='я'.repeat(419)+'🙂'+'я'.repeat(40);
  const parts=excerptsFrom(unicode);
  assert.equal(parts.map(p=>p.text).join(''),unicode);
  assert(parts.every(p=>p.text.isWellFormed()),'splitting must not cut a surrogate pair');
});

test('provider off keeps static page available and returns a recoverable API error',limit,async t=> {
  const site=await service(t);
  assert.deepEqual(await(await fetchBounded(site+'/api/status')).json(),{ai:false,provider:'Модель не подключена'});
  await errorStatus(await post(site),503);
  assert.equal((await fetchBounded(site+'/')).status,200);
  await errorStatus(await post(site),503);
});

test('unavailable provider returns bounded errors and remains retryable',limit,async t=> {
  const provider=await listen(createServer(req=>req.socket.destroy()),t);
  const site=await service(t,provider);
  await errorStatus(await post(site),503);
  await errorStatus(await post(site),503);
  const ollama=await service(t,provider,{TUTOR_PROVIDER:'ollama',TUTOR_MODEL:''});
  assert.equal((await(await fetchBounded(ollama+'/api/status')).json()).ai,false);
  await errorStatus(await post(ollama),503);
});

test('valid API preserves citations, topic membership, user title and server-only credentials',limit,async t=> {
  const requests=[];
  const provider=await listen(createServer(async(req,res)=>{
    const chunks=[];for await(const part of req) chunks.push(part);
    requests.push({url:req.url,headers:req.headers,body:JSON.parse(Buffer.concat(chunks))});
    res.end(envelope());
  }),t);
  const site=await service(t,provider,{TUTOR_API_KEY:'test-placeholder-key'});
  const status=await(await fetchBounded(site+'/api/status')).json();
  assert.equal(status.ai,true);
  const response=await post(site,{text,title:'Авторский заголовок'});
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.title,'Авторский заголовок');
  assert.deepEqual(result.excerpts,[{id:'e1',text}]);
  assert.deepEqual(result.terms[0].evidenceIds,['e1']);
  assert.deepEqual(result.terms[0].topicIds,['t1']);
  assert(result.links.some(e=>e.from==='t1'&&e.to==='k1'&&e.evidenceIds.includes('e1')));
  assert.equal(requests.length,1);
  assert.equal(requests[0].url,'/v1/chat/completions');
  assert.equal(requests[0].headers.authorization,'Bearer test-placeholder-key');
  assert.equal(requests[0].body.model,'test-model');
  assert.deepEqual(JSON.parse(requests[0].body.messages[1].content).excerpts,[{id:'e1',text}]);
  assert(!JSON.stringify([status,result]).includes('test-placeholder-key'));
});

test('malformed provider responses fail safely and each next valid request succeeds',limit,async t=> {
  let answer=envelope(),upstreamStatus=200;
  const provider=await listen(createServer(async(req,res)=>{
    for await(const part of req) {}
    res.writeHead(upstreamStatus,{'Content-Type':'application/json'});
    res.end(answer);
  }),t);
  const site=await service(t,provider);
  const cases=[
    {answer:'not-json',status:502},
    {answer:'{}',status:502},
    {answer:JSON.stringify({choices:[{message:{content:'broken'}}]}),status:502},
    {answer:JSON.stringify({choices:[{message:{content:JSON.stringify(graph)},finish_reason:'length'}]}),status:502},
    {answer:envelope({...graph,terms:[{...graph.terms[0],evidence:[{id:'e99',quote:'missing'}]}]}),status:502},
    {answer:envelope({title:'Нет содержания',topics:[],terms:[],links:[]}),status:422},
    {answer:'x'.repeat(350001),status:502},
    {answer:'{}',upstreamStatus:429,status:502}
  ];
  for(const sample of cases) {
    answer=sample.answer;upstreamStatus=sample.upstreamStatus||200;
    await errorStatus(await post(site),sample.status);
    answer=envelope();upstreamStatus=200;
    assert.equal((await post(site)).status,200);
  }
});

test('input validation enforces JSON type and text/title bounds before contacting the provider',limit,async t=> {
  let calls=0;
  const provider=await listen(createServer(async(req,res)=>{
    for await(const part of req) {}
    calls++;res.end(envelope());
  }),t);
  const site=await service(t,provider);
  for(const [body,status] of [
    [null,400],[{text:42},400],[{text,title:42},400],[{text:'коротко'},422],
    [{text:'x'.repeat(32001)},413],[{text,title:'x'.repeat(201)},413]
  ]) await errorStatus(await post(site,body),status);
  await errorStatus(await post(site,{text},{body:'broken'}),400);
  await errorStatus(await post(site,{text},{headers:{'Content-Type':'text/plain'}}),415);
  await errorStatus(await post(site,{text:'x'.repeat(210000)}),413);
  assert.equal(calls,0);
  const maximum=text+' '.repeat(32000-text.length);
  assert.equal((await post(site,{text:maximum,title:'x'.repeat(200)})).status,200);
  assert.equal(calls,1);
});

test('oversized chunked body receives JSON 413 and the server accepts the next request',limit,async t=> {
  const site=await service(t);
  const response=await chunked(site,JSON.stringify({text:'x'.repeat(210000)}));
  assert.equal(response.status,413);
  assert.equal(typeof JSON.parse(response.body).error,'string');
  await errorStatus(await post(site),503);
});

test('same-origin checks reject other origins, wrong host and unsupported methods',limit,async t=> {
  const site=await service(t);
  for(const origin of ['https://untrusted.example','null',site.replace('127.0.0.1','localhost'),'']) {
    await errorStatus(await post(site,{text},{headers:{Origin:origin}}),403);
  }
  const wrongHost=await chunked(site,JSON.stringify({text}),{Host:'untrusted.example'});
  assert.equal(wrongHost.status,403);
  await errorStatus(await fetchBounded(site+'/api/structure',{method:'PUT'}),405);
  await errorStatus(await post(site),503);
});

test('static GET and HEAD serve the current app with no-cache and reject traversal',limit,async t=> {
  const site=await service(t);
  const get=await fetchBounded(site+'/');
  assert.equal(get.status,200);
  assert.match(get.headers.get('content-type'),/^text\/html/);
  assert.equal(get.headers.get('cache-control'),'no-store');
  assert.equal(get.headers.get('x-content-type-options'),'nosniff');
  const body=await get.text();
  assert.match(body,/<html/);
  const head=await fetchBounded(site+'/',{method:'HEAD'});
  assert.equal(head.status,200);
  assert.equal(head.headers.get('content-length'),get.headers.get('content-length'));
  assert.equal(await head.text(),'');
  for(const path of ['/missing.css','/local/server.mjs','/%2e%2e%2flocal%2fserver.mjs','/%00','/api/unknown']) {
    await errorStatus(await fetchBounded(site+path),404);
  }
});

test('Ollama discovery ignores remote/embedding models, rejects bad metadata, and recovers',limit,async t=> {
  let payload={models:[{name:'embed-foo'},{name:'remote',remote_host:'https://upstream.example'},null,{name:'local-chat:latest'}]};
  const provider=await listen(createServer((req,res)=>res.end(JSON.stringify(payload))),t);
  const site=await service(t,provider,{TUTOR_PROVIDER:'ollama',TUTOR_MODEL:''});
  assert.deepEqual(await(await fetchBounded(site+'/api/status')).json(),{ai:true,provider:'Ollama · local-chat:latest'});
  payload={models:{unexpected:true}};
  assert.equal((await(await fetchBounded(site+'/api/status')).json()).ai,false);
  await errorStatus(await post(site),502);
  payload={models:[]};
  await errorStatus(await post(site),503);
  payload={models:[{name:'local-chat:latest'}]};
  assert.equal((await(await fetchBounded(site+'/api/status')).json()).ai,true);
  const absent=await service(t,provider,{TUTOR_PROVIDER:'ollama',TUTOR_MODEL:'not-installed'});
  assert.equal((await(await fetchBounded(absent+'/api/status')).json()).ai,false);
});

test('concurrent request is busy; cancelling closes upstream and a new analysis succeeds',limit,async t=> {
  let begin,closed;
  const began=new Promise(resolve=>{begin=resolve;});
  const upstreamClosed=new Promise(resolve=>{closed=resolve;});
  let calls=0;
  const provider=await listen(createServer(async(req,res)=>{
    for await(const part of req) {}
    calls++;
    if(calls===1) {res.once('close',closed);begin();return;}
    res.end(envelope());
  }),t);
  const site=await service(t,provider);
  const controller=new AbortController();
  t.after(()=>controller.abort());
  const pending=post(site,{text},{signal:controller.signal})
    .then(response=>({response}),error=>({error}));
  await within(began);
  await errorStatus(await post(site),429);
  controller.abort();
  const cancelled=await within(pending);
  assert.equal(cancelled.error?.name,'AbortError');
  await within(upstreamClosed);
  assert.equal((await post(site)).status,200);
  assert.equal(calls,2);
});
