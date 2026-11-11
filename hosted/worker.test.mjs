import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createWorker} from './worker.mjs';

const ORIGIN = 'https://studio.example';
const KEY = 'synthetic-test-secret';
const TEXT = 'Цель проекта описывает ожидаемое изменение. Задача — конкретная работа, необходимая для достижения цели.';
const EVIDENCE = [{id:'e1', quote:'Цель проекта описывает ожидаемое изменение.'}];
const GRAPH = {
  title:'Проект', topics:[{id:'t1',name:'Планирование',summary:'В проекте формулируют цель.',evidence:EVIDENCE}],
  terms:[{id:'k1',name:'Цель проекта',definition:'Ожидаемое изменение.',topicIds:['t1'],evidence:EVIDENCE}],
  links:[{from:'k1',to:'t1',relation:'используется при',evidence:EVIDENCE}],
};
const OPTIONS = {timeout:5000};
const envelope = (graph = GRAPH) => new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(graph)},finish_reason:'stop'}]}));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve=yes; reject=no;});
  return {promise, resolve, reject};
};

// Execute real SQLite statements, including UPDATE RETURNING. Two independent
// connections emulate workers sharing one D1 database; no SQL is pattern-mocked.
function d1(sqlite) {
  return {prepare(sql) {
    const statement = sqlite.prepare(sql);
    const bound = values => ({
      bind(...next) {return bound(next);},
      async run() {statement.run(...values); return {success:true};},
      async first() {return statement.get(...values) ?? null;},
    });
    return bound([]);
  }};
}
async function fixture(t, {migrate=true} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tutor-worker-test-'));
  const first = new DatabaseSync(join(dir, 'quota.sqlite'));
  const second = new DatabaseSync(join(dir, 'quota.sqlite'));
  t.after(async () => {first.close(); second.close(); await rm(dir,{recursive:true,force:true});});
  if (migrate) first.exec(await readFile(new URL('./migrations/0000_demo_budget.sql',import.meta.url),'utf8'));
  const workers = [createWorker({html:'<!doctype html><title>Студия</title>',notices:'MIT test notice'}), createWorker({html:'<!doctype html><title>Студия</title>',notices:'MIT test notice'})];
  const envs = [{DB:d1(first),TUTOR_API_KEY:KEY},{DB:d1(second),TUTOR_API_KEY:KEY}];
  const calls = [];
  let respond = async () => envelope();
  t.mock.method(globalThis,'fetch',async (url,options) => {
    assert.equal(String(url),'https://polza.ai/api/v1/chat/completions','no unexpected or real network requests');
    const call={url:String(url),options,body:JSON.parse(options.body)};
    calls.push(call);
    return respond(call);
  });
  const send = (request, index=0, env=envs[index]) => workers[index].fetch(request,env);
  const post = (input={text:TEXT}, options={}, index=0, env=envs[index]) => send(new Request(ORIGIN+'/api/structure',{
    method:'POST',body:JSON.stringify(input),...options,
    headers:{Origin:ORIGIN,'Content-Type':'application/json',...options.headers},
  }),index,env);
  const status = async (index=0, env=envs[index]) => (await send(new Request(ORIGIN+'/api/status'),index,env)).json();
  const row = () => first.prepare('SELECT * FROM demo_budget WHERE id=1').get();
  return {first,second,workers,envs,calls,send,post,status,row,respond(fn){respond=fn;}};
}
async function error(response, status) {
  assert.equal(response.status,status);
  const value=await response.json();
  assert.deepEqual(Object.keys(value),['error']);
  assert.equal(typeof value.error,'string');
  assert(value.error.length>0);
  assert(!value.error.includes(KEY));
  return value;
}

test('static routes and status disclose only public configuration and global remaining quota',OPTIONS,async t => {
  const f=await fixture(t);
  assert.deepEqual(await f.status(),{ai:true,provider:'Polza AI · Gemini 2.5 Flash',remaining:20,limit:20});
  for (const path of ['/','/index.html','/THIRD_PARTY_NOTICES.txt']) {
    const response=await f.send(new Request(ORIGIN+path));
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    assert(!(await response.text()).includes(KEY));
    assert.equal(await (await f.send(new Request(ORIGIN+path,{method:'HEAD'}))).text(),'');
  }
  for (const path of ['/missing','/api','/api/missing']) await error(await f.send(new Request(ORIGIN+path)),404);
  await error(await f.send(new Request(ORIGIN+'/api/missing',{method:'POST'})),404);
  await error(await f.send(new Request(ORIGIN+'/api/structure')),405);
  assert.equal(f.calls.length,0);
  assert.equal(f.row().total_used,0);
});

test('valid public request uses fixed HTTPS provider, model and schema with server-only key',OPTIONS,async t => {
  const f=await fixture(t);
  const response=await f.post({text:TEXT,title:'Авторский заголовок',model:'attacker',url:'https://attacker.example',apiKey:'attacker'}, {},0,
    {...f.envs[0],TUTOR_MODEL:'attacker',TUTOR_PROVIDER:'off',TUTOR_API_BASE:'https://attacker.example',TUTOR_JSON_MODE:'object'});
  assert.equal(response.status,200);
  const graph=await response.json();
  assert.equal(graph.title,'Авторский заголовок');
  assert.deepEqual(graph.excerpts,[{id:'e1',text:TEXT}]);
  assert.deepEqual(graph.terms[0].topicIds,['t1']);
  assert.deepEqual(graph.terms[0].evidenceIds,['e1']);
  assert(graph.links.some(link=>link.from==='t1'&&link.to==='k1'&&link.relation==='содержит термин'));
  const call=f.calls[0];
  assert.equal(call.options.headers.Authorization,'Bearer '+KEY);
  assert.equal(call.body.model,'google/gemini-2.5-flash');
  assert.equal(call.body.response_format.type,'json_schema');
  assert.equal(call.body.response_format.json_schema.strict,true);
  assert.equal(call.body.response_format.json_schema.name,'lesson_graph');
  assert(!JSON.stringify(graph).includes(KEY));
  assert.equal(f.row().total_used,1);
  assert.equal(f.row().lease_token,null);
  assert.equal((await f.status(1)).remaining,19);
  assert.deepEqual(f.first.prepare('PRAGMA table_info(demo_budget)').all().map(x=>x.name),['id','total_used','lease_token','lease_expires_at']);
});

test('origin and JSON requirements reject cross-site, missing and malformed headers before quota',OPTIONS,async t => {
  const f=await fixture(t);
  for (const origin of ['https://other.example','null',ORIGIN+'/',ORIGIN+':444','']) await error(await f.post({text:TEXT},{headers:{Origin:origin}}),403);
  await error(await f.send(new Request(ORIGIN+'/api/structure',{method:'POST',body:JSON.stringify({text:TEXT}),headers:{'Content-Type':'application/json'}})),403);
  for (const type of ['text/plain','application/jsonp','']) await error(await f.post({text:TEXT},{headers:{'Content-Type':type}}),415);
  assert.equal(f.calls.length,0);
  assert.equal((await f.status()).remaining,20);
});

test('malformed JSON and invalid title/text never reserve a paid run',OPTIONS,async t => {
  const f=await fixture(t);
  for (const [input,status] of [[null,400],[[],400],[{},400],[{text:12},400],[{text:TEXT,title:12},400],[{text:'short'},422],[{text:' '.repeat(60)},422],[{text:'я'.repeat(32001)},413],[{text:TEXT,title:'x'.repeat(201)},413]]) await error(await f.post(input),status);
  await error(await f.post({text:TEXT},{body:'{broken'}),400);
  await error(await f.post({text:TEXT},{body:null}),400);
  assert.equal(f.calls.length,0);
  assert.equal((await f.status()).remaining,20);
});

test('declared and streamed byte overflow are rejected and the request stream is cancelled',OPTIONS,async t => {
  const f=await fixture(t);
  await error(await f.post({text:TEXT},{headers:{'Content-Length':'200001'}}),413);
  let cancelled=0;
  const stream=new ReadableStream({start(controller) {
    controller.enqueue(new Uint8Array(100001));
    controller.enqueue(new Uint8Array(100000));
  },cancel(){cancelled++;}});
  await error(await f.post({text:TEXT},{body:stream,duplex:'half'}),413);
  assert.equal(cancelled,1);
  assert.equal(f.calls.length,0);
  assert.equal((await f.status()).remaining,20);
});

test('cancellation before admission and during incoming stream makes zero provider calls',OPTIONS,async t => {
  const f=await fixture(t);
  const before=new AbortController();before.abort();
  await error(await f.post({text:TEXT},{signal:before.signal}),499);
  const pending=new AbortController();
  const reading=deferred();let cancelled=0;
  const stream=new ReadableStream({pull(){reading.resolve();},cancel(){cancelled++;}});
  const result=f.post({text:TEXT},{body:stream,duplex:'half',signal:pending.signal});
  await reading.promise;
  pending.abort();
  await error(await result,499);
  assert.equal(cancelled,1);
  assert.equal(f.calls.length,0);
  assert.equal((await f.status()).remaining,20);
});

test('atomic lease admits one in-flight request across independent workers and database connections',OPTIONS,async t => {
  const f=await fixture(t);
  const started=deferred(), finish=deferred();
  f.respond(async()=>{started.resolve(); await finish.promise; return envelope();});
  const active=f.post();await started.promise;
  const row=f.row();
  assert.equal(row.total_used,1);
  assert.equal(typeof row.lease_token,'string');
  const now=f.first.prepare('SELECT unixepoch() AS now').get().now;
  assert(row.lease_expires_at-now>=209 && row.lease_expires_at-now<=210);
  const rejected=await Promise.all(Array.from({length:24},(_,i)=>f.post({text:TEXT},{},i%2)));
  for(const response of rejected) await error(response,429);
  assert.equal(f.calls.length,1);
  assert.equal(f.row().total_used,1);
  finish.resolve();assert.equal((await active).status,200);
  assert.equal((await f.post({text:TEXT},{},1)).status,200);
  assert.equal(f.row().total_used,2);
});

test('twenty reservations are a persistent global cap and concurrent overflow cannot bypass it',OPTIONS,async t => {
  const f=await fixture(t);
  for(let i=0;i<19;i++) assert.equal((await f.post({text:TEXT},{},i%2)).status,200);
  const results=await Promise.all(Array.from({length:30},(_,i)=>f.post({text:TEXT},{},i%2)));
  assert.equal(results.filter(r=>r.status===200).length,1);
  assert.equal(results.filter(r=>r.status===429).length,29);
  assert.equal(f.calls.length,20);
  assert.equal(f.row().total_used,20);
  const restarted=createWorker({html:'new deployment',notices:'MIT'});
  const status=await(await restarted.fetch(new Request(ORIGIN+'/api/status'),f.envs[1])).json();
  assert.deepEqual(status,{ai:true,provider:'Polza AI · Gemini 2.5 Flash',remaining:0,limit:20});
  await error(await f.post(),429);
  assert.equal(f.calls.length,20);
});

test('expired lease recovers after a crash and old owner cannot release replacement lease',OPTIONS,async t => {
  const f=await fixture(t);
  await f.status();
  f.first.prepare('UPDATE demo_budget SET total_used=4, lease_token=?, lease_expires_at=unixepoch()-1 WHERE id=1').run('crashed-worker');
  const started=deferred(),finish=deferred();
  f.respond(async()=>{started.resolve();await finish.promise;return envelope();});
  const active=f.post();await started.promise;
  assert.equal(f.row().total_used,5);
  assert.notEqual(f.row().lease_token,'crashed-worker');
  f.second.prepare('UPDATE demo_budget SET lease_token=?,lease_expires_at=unixepoch()+210 WHERE id=1').run('replacement-owner');
  finish.resolve();assert.equal((await active).status,200);
  assert.equal(f.row().lease_token,'replacement-owner');
  await error(await f.post({text:TEXT},{},1),429);
  assert.equal(f.calls.length,1);
});

test('upstream rejection, malformed graph and bounded output failures consume their reserved slots',OPTIONS,async t => {
  const f=await fixture(t);
  const invalid=structuredClone(GRAPH);invalid.terms[0].topicIds=[];
  const cases=[
    [()=>new Response('private provider detail '+KEY,{status:401}),502],
    [()=>{throw new Error('private provider detail '+KEY);},503],
    [()=>new Response('{broken'),502],
    [()=>envelope(invalid),502],
    [()=>new Response('x'.repeat(350001)),502],
  ];
  for(const [respond,code] of cases) {
    f.respond(respond);
    await error(await f.post(),code);
    assert.equal(f.row().lease_token,null);
  }
  assert.equal(f.calls.length,cases.length);
  assert.equal(f.row().total_used,cases.length);
  assert.equal((await f.status()).remaining,20-cases.length);
});

test('cancellation during provider request aborts it, consumes a slot and releases only its lease',OPTIONS,async t => {
  const f=await fixture(t);
  const started=deferred();let aborted=false;
  f.respond(({options})=>new Promise((_,reject)=>{
    options.signal.addEventListener('abort',()=>{aborted=true;reject(new DOMException('Aborted','AbortError'));},{once:true});
    started.resolve();
  }));
  const controller=new AbortController();
  const result=f.post({text:TEXT},{signal:controller.signal});
  await started.promise;controller.abort();
  await error(await result,499);
  assert(aborted);
  assert.equal(f.row().total_used,1);
  assert.equal(f.row().lease_token,null);
});

test('missing secret, database and unapplied migrations fail closed without creating schema',OPTIONS,async t => {
  const f=await fixture(t,{migrate:false});
  for(const env of [{}, {DB:f.envs[0].DB}, {TUTOR_API_KEY:KEY}, f.envs[0]]) {
    assert.deepEqual(await f.status(0,env),{ai:false,provider:'Модель недоступна',remaining:0,limit:20});
    await error(await f.post({text:TEXT},{},0,env),503);
  }
  assert.equal(f.calls.length,0);
  assert.deepEqual(f.first.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),[]);
});

test('database failures cannot admit requests or expose internal errors in status',OPTIONS,async t => {
  const f=await fixture(t);
  const env={...f.envs[0],DB:{prepare(){throw new Error('account details '+KEY);}}};
  assert.deepEqual(await f.status(0,env),{ai:false,provider:'Модель недоступна',remaining:0,limit:20});
  await error(await f.post({text:TEXT},{},0,env),503);
  assert.equal(f.calls.length,0);
});

test('cleanup database failure retains the lease and valid paid result without allowing another run',OPTIONS,async t => {
  const f=await fixture(t);
  const env={...f.envs[0],DB:{prepare(sql){
    if(sql.includes('SET lease_token = NULL')) throw new Error('release unavailable');
    return f.envs[0].DB.prepare(sql);
  }}};
  assert.equal((await f.post({text:TEXT},{},0,env)).status,200);
  assert.notEqual(f.row().lease_token,null);
  await error(await f.post({text:TEXT},{},1),429);
  assert.equal(f.row().total_used,1);
  assert.equal(f.calls.length,1);
});
