import { test } from 'node:test';
import assert from 'node:assert/strict';
import {MAX_TEXT,validateDraft,createPackage,preview,parseSaved,serializeSaved} from '../src/lib/course.js';
import TutorEngine from '../src/lib/engine.mjs';

function draft() {
  return {
    title:'Подготовка проекта',
    excerpts:[
      {id:'e1',text:'Цель — ожидаемое изменение. Задача — работа для достижения цели.'},
      {id:'e2',text:'Риск — возможное событие, которое помешает достижению цели.'}
    ],
    topics:[
      {id:'t1',name:'Цели и задачи',summary:'Формулируем цель и задачи.',evidenceIds:['e1']},
      {id:'t2',name:'Риски',summary:'Определяем риски.',evidenceIds:['e2']}
    ],
    terms:[
      {id:'k1',name:'Цель',definition:'Ожидаемое изменение.',evidenceIds:['e1'],topicIds:['t1']},
      {id:'k2',name:'Риск',definition:'Возможное событие, которое помешает достижению цели.',evidenceIds:['e2'],topicIds:['t2']}
    ],links:[]
  };
}
function state() {
  return {title:'Подготовка проекта',text:'Цель — ожидаемое изменение. Задача — работа для достижения цели. Риск — возможное событие, которое помешает достижению цели.',
    required:'Цель',exampleId:null,draft:draft(),excluded:[],stage:1,sources:[]};
}
test('validation requires visible educational content, sources and selected topic', () => {
  const input=draft();
  assert.deepEqual(validateDraft(input),[]);
  input.terms[0].definition='';
  input.terms[0].evidenceIds=['missing'];
  const errors=validateDraft(input,['t1']);
  assert(errors.some(e=>e.id==='k1' && e.field==='definition'));
  assert(errors.some(e=>e.id==='k1' && e.field==='evidenceIds'));
  assert(errors.some(e=>e.id==='k1' && e.field==='topicIds'));
  assert.equal(validateDraft(null)[0].field,'draft');
});
test('required terms are checked with case and whitespace normalization', () => {
  assert.deepEqual(validateDraft(draft(),[],['  ЦЕЛЬ  ']),[]);
  assert(validateDraft(draft(),['k1'],['Цель']).some(e=>e.id==='k1' && e.field==='required'));
  assert(validateDraft(draft(),[],['Бюджет']).some(e=>e.field==='required'));
});
test('package filters exclusions, preserves evidence and topic links, and never mutates the draft', () => {
  const input=draft(), before=JSON.stringify(input);
  const pack=createPackage(input,['t2','k2'],[{name:'Методичка',url:'https://example.com/material',detail:'Публичный источник',token:'drop-me'}],'Правила извлечения',['Цель']);
  assert.deepEqual(pack.terms.map(x=>x.id),['k1']);
  assert.deepEqual(pack.terms[0].topicIds,['t1']);
  assert.deepEqual(pack.excerpts.map(x=>x.id),['e1']);
  assert(pack.graph.edges.some(e=>e.from==='t1' && e.to==='k1' && e.evidenceIds.includes('e1')));
  assert.equal(pack.sources[0].token,undefined);
  assert.deepEqual(pack.provenance,{method:'Правила извлечения',reviewed:true,requiredTerms:['Цель']});
  assert(pack.prompts.tutor.includes('Ожидаемое изменение.'));
  assert.equal(JSON.stringify(input),before);
  assert.throws(()=>createPackage(input,['t1'],[],''),e=>e.issues.some(issue=>issue.field==='topicIds'));
});
test('preview is deterministic and uses the first eligible definition verbatim', () => {
  const sample=draft();
  const a=preview(sample), b=preview(sample);
  assert.deepEqual(a,b);
  assert(a.question.includes('«Цель»') && a.question.includes('«Цели и задачи»'));
  assert.equal(a.expected,sample.terms[0].definition);
  assert.deepEqual(a.sourceIds,['e1']);
  assert.equal(preview(sample,['t1']).expected,sample.terms[1].definition);
  assert.equal(preview(sample,['k1','k2']).question,'');
  assert.deepEqual(preview(null).sourceIds,[]);
  assert.deepEqual(Object.keys(a),['greeting','question','expected','sourceIds']);
});
test('v2 roundtrip allowlists fields and drops unknown secrets at every level', () => {
  const original=state();
  original.apiKey='secret-top';
  original.providerConfig={secret:'secret-config'};
  original.draft.secret='secret-draft';
  original.draft.terms[0].apiKey='secret-term';
  original.draft.excerpts[0].token='secret-fragment';
  original.sources=[{name:'Источник',url:'https://example.com/',detail:'Описание',authorization:'secret-source'}];
  const saved=serializeSaved(original);
  assert(saved && !saved.includes('secret-'));
  assert.equal(JSON.parse(saved).version,2);
  const restored=parseSaved(saved);
  assert.equal(restored.draft.terms[0].definition,'Ожидаемое изменение.');
  assert.deepEqual(Object.keys(restored),['title','text','required','exampleId','draft','excluded','stage','sources','method']);
});
test('an unfinished draft remains editable and a stale final stage returns to review', () => {
  const input=state();
  input.draft.terms[0].definition='';
  assert.equal(parseSaved(serializeSaved(input)).stage,1);
  input.stage=2;
  assert.equal(parseSaved(serializeSaved(input)).stage,1);
});
test('damaged references, duplicate IDs, wrong versions and oversized material are rejected', () => {
  for(const mutate of [
    x=>x.version=1,
    x=>x.text='a'.repeat(MAX_TEXT+1),
    x=>x.draft.topics[0].id='e1',
    x=>x.draft.terms[0].topicIds=['t999'],
    x=>x.draft.topics[0].evidenceIds=['e999'],
    x=>x.draft.links=[{from:'k1',to:'missing',relation:'содержит',evidenceIds:['e1']}],
    x=>x.sources=[{name:'Вредная ссылка',url:'javascript:alert(1)'}],
    x=>x.excluded=['missing'],
    x=>x.stage=9
  ]) {
    const input={version:2,...state()};
    mutate(input);
    assert.equal(parseSaved(input),null);
  }
  assert.equal(parseSaved('{broken'),null);
  assert.equal(parseSaved(null),null);
  assert.equal(parseSaved('[]'),null);
});
test('blank initial state can be persisted, accessors cannot be read', () => {
  const initial={title:'',text:'',required:'',exampleId:null,draft:null,excluded:[],stage:0,sources:[]};
  assert.deepEqual(parseSaved(serializeSaved(initial)),{...initial,method:''});
  const input={version:2,...initial};
  Object.defineProperty(input,'title',{enumerable:true,get(){throw Error('must not run');}});
  assert.equal(parseSaved(input),null);
  assert.equal(serializeSaved(input),null);
});
test('real browser extraction output passes the course handoff', () => {
  const input=TutorEngine.build('Цель проекта\n\nЦель — ожидаемое изменение. Задача — конкретная работа для достижения цели. Задача требует ресурсов.','Проба');
  const excluded=input.terms.filter(term=>!term.definition).map(term=>term.id);
  assert.deepEqual(validateDraft(input,excluded),[]);
  const pack=createPackage(input,excluded);
  assert(pack.terms.length>0 && pack.graph.edges.length>0 && pack.prompts.evaluator);
});

test('UUIDs created by the UI remain valid even when they start with a digit', () => {
  const input=state();
  input.draft.terms[0].id='123e4567-e89b-42d3-a456-426614174000';
  assert.deepEqual(validateDraft(input.draft),[]);
  assert(parseSaved(serializeSaved(input)));
  assert.equal(createPackage(input.draft).terms[0].id,input.draft.terms[0].id);
});
test('changing a term topic replaces its old membership edge and evidence', () => {
  const input=draft();
  input.links.push({from:'t1',to:'k1',relation:'содержит термин',evidenceIds:['e1']});
  input.terms[0].topicIds=['t2'];
  input.terms[0].evidenceIds=['e2'];
  const result=createPackage(input);
  assert(!result.links.some(edge=>edge.from==='t1' && edge.to==='k1' && edge.relation==='содержит термин'));
  assert.deepEqual(result.links.find(edge=>edge.from==='t2' && edge.to==='k1'),
    {from:'t2',to:'k1',relation:'содержит термин',evidenceIds:['e2']});
});
test('model provenance survives a save and reload while older v2 saves still load', () => {
  const input=state();
  input.method='Local model · test-model';
  const loaded=parseSaved(serializeSaved(input));
  assert.equal(loaded.method,input.method);
  assert.equal(createPackage(loaded.draft,loaded.excluded,loaded.sources,loaded.method).provenance.method,input.method);
  assert.equal(parseSaved({version:2,...state()}).method,'');
});

test('excluding topics and terms removes their nodes from every exported view and prompt context', () => {
  for (const excluded of [[], ['t2','k2'], ['t1','k1']]) {
    const input=draft();
    input.links.push({from:'k1',to:'k2',relation:'учитывает',evidenceIds:['e1','e2']});
    const pack=createPackage(input,excluded);
    const selected=new Set([...pack.topics,...pack.terms].map(node=>node.id));
    assert(excluded.every(id=>!selected.has(id)));
    assert.deepEqual(new Set(pack.graph.nodes.map(node=>node.id)),selected);
    assert(pack.links.every(edge=>selected.has(edge.from)&&selected.has(edge.to)));
    for(const prompt of Object.values(pack.prompts)) {
      const context=JSON.parse(prompt.split('\n\nДанные курса\n')[1]);
      assert.deepEqual(context.terms,pack.terms);
      assert.deepEqual(context.topics,pack.topics);
      assert.deepEqual(context.links,pack.links);
      assert.deepEqual(context.excerpts,pack.excerpts);
    }
  }
});

test('mandatory terms cannot be bypassed by exclusion, missing definitions or a stale completed save', () => {
  const input=state();
  input.required='ЦЕЛЬ; цель\nРиск';
  input.excluded=['k1'];
  assert.throws(()=>createPackage(input.draft,input.excluded,[],input.method,input.required),
    error=>error.issues.some(issue=>issue.field==='required'&&issue.id==='k1'));
  input.stage=2;
  assert.equal(parseSaved(serializeSaved(input)).stage,1);
  input.excluded=[];
  input.draft.terms[0].definition=' \t';
  assert.throws(()=>createPackage(input.draft,[],[],input.method,input.required),
    error=>error.issues.some(issue=>issue.field==='definition'&&issue.id==='k1'));
  input.draft.terms[0].definition='Ожидаемое изменение.';
  const result=createPackage(input.draft,[],[],input.method,input.required);
  assert.deepEqual(result.provenance.requiredTerms,['ЦЕЛЬ','Риск']);
});

test('a term shared across topics survives one topic exclusion without stale membership links', () => {
  const input=draft();
  input.terms[0].topicIds=['t1','t2','t2'];
  input.links=[
    {from:'t1',to:'k1',relation:'содержит термин',evidenceIds:['e1']},
    {from:'t2',to:'k1',relation:'содержит термин',evidenceIds:['e2']}
  ];
  const pack=createPackage(input,['t1']);
  assert.deepEqual(pack.terms.find(term=>term.id==='k1').topicIds,['t2']);
  assert.equal(pack.links.filter(link=>link.to==='k1'&&link.relation==='содержит термин').length,1);
  assert(pack.links.every(link=>link.from!=='t1'&&link.to!=='t1'));
});

test('reviewed content, sources and method produce a deterministic package before and after saving', () => {
  const input=state();
  input.method='compatible · model-one';
  input.sources=[{name:'Материал занятия',url:'https://example.com/lecture#part-2',detail:'Транскрипт лекции'}];
  input.draft.terms[0].definition='Проверенная методистом трактовка цели.';
  input.draft.links=[{from:'k1',to:'k2',relation:'учитывает',evidenceIds:['e1','e2']}];
  input.stage=2;
  const original=structuredClone(input);
  const first=createPackage(input.draft,input.excluded,input.sources,input.method,input.required);
  const loaded=parseSaved(serializeSaved(input));
  assert(loaded);
  const second=createPackage(loaded.draft,loaded.excluded,loaded.sources,loaded.method,loaded.required);
  assert.deepEqual(first,second);
  assert.equal(JSON.stringify(first),JSON.stringify(second));
  assert.deepEqual(input,original);
  assert.deepEqual(JSON.parse(JSON.stringify(first)),first);
  assert.equal(first.terms[0].definition,input.draft.terms[0].definition);
  assert(first.excerpts.every(fragment=>input.text.includes(fragment.text)));
  first.terms[0].topicIds.push('not-in-input');
  first.sources[0].name='Changed export';
  assert.deepEqual(input,original);
});

test('a saved source edited independently of its evidence cannot masquerade as the original lecture', () => {
  const original={version:2,...state()};
  assert(parseSaved(original));
  const changedSource=structuredClone(original);
  changedSource.text=changedSource.text.replace('ожидаемое изменение','любая покупка');
  assert.equal(parseSaved(changedSource),null);
  const changedEvidence=structuredClone(original);
  changedEvidence.draft.excerpts[0].text='Цель — любая покупка.';
  assert.equal(parseSaved(changedEvidence),null);
});

test('full-size material roundtrips without dropping provenance; over-limit content is rejected', () => {
  const input=state();
  input.text=input.text.padEnd(MAX_TEXT,' ');
  const loaded=parseSaved(serializeSaved(input));
  assert.equal(loaded.text.length,MAX_TEXT);
  assert.deepEqual(loaded.draft.excerpts,input.draft.excerpts);
  input.text+=' ';
  assert.equal(serializeSaved(input),null);
});

test('a complete long definition stays editable across save and reload', () => {
  const definition='ожидаемый '+('результат для участников ').repeat(250)+'с измеримым сроком.';
  const text='Цель — '+definition;
  const model=TutorEngine.build(text,'Длинная трактовка');
  const input={title:model.title,text,required:'Цель',exampleId:null,draft:model,excluded:[],stage:2,sources:[],method:'Правила извлечения'};
  assert.deepEqual(validateDraft(model,[],'Цель'),[]);
  const restored=parseSaved(serializeSaved(input));
  assert(restored,'Valid extraction within the material limit must remain saveable');
  assert.equal(restored.draft.terms.find(term=>term.name==='Цель').definition,definition);
  assert.deepEqual(createPackage(restored.draft,[],[],restored.method,'Цель'),createPackage(model,[],[],input.method,'Цель'));
});

test('prototype keys, nested accessors, unsafe addresses and malformed persistence cannot enter a restored draft', () => {
  const input=state();
  const saved=JSON.parse(serializeSaved(input));
  const polluted=JSON.parse(JSON.stringify(saved).replace('"version":2','"version":2,"__proto__":{"polluted":true}'));
  const restored=parseSaved(polluted);
  assert(restored);
  assert.equal(Object.hasOwn(restored,'__proto__'),false);
  assert.equal(Object.prototype.polluted,undefined);
  for(const url of ['javascript:alert(1)','data:text/html,<h1>hi</h1>','file:///etc/passwd','https://login:secret@example.com']) {
    assert.throws(()=>createPackage(draft(),[],[{name:'Ссылка',url}]),/источник/);
    assert.equal(parseSaved({...saved,sources:[{name:'Ссылка',url}]}),null);
  }
  let reads=0;
  const nested=structuredClone(saved);
  Object.defineProperty(nested.draft.terms[0],'name',{enumerable:true,get(){reads++;return 'unsafe';}});
  assert.equal(parseSaved(nested),null);
  assert.equal(reads,0);
  assert.equal(parseSaved(' '.repeat(1200001)),null);
});

test('duplicate names and non-existent evidence prevent completion with actionable field issues', () => {
  const input=draft();
  input.terms[1].name='  ЦЕЛЬ ';
  input.topics[1].evidenceIds=['missing'];
  input.links=[{from:'k1',to:'k2',relation:'связано',evidenceIds:[]}];
  const errors=validateDraft(input);
  assert(errors.some(issue=>issue.id==='k2'&&issue.field==='name'));
  assert(errors.some(issue=>issue.id==='t2'&&issue.field==='evidenceIds'));
  assert(errors.some(issue=>issue.id==='k1'&&issue.field==='evidenceIds'));
  assert(errors.every(issue=>typeof issue.message==='string'&&issue.message.trim()));
  assert.throws(()=>createPackage(input),error=>error.issues.length>=3);
});

test('all built-in lessons can be reviewed, saved, restored and exported using the same contract', async () => {
  const {default:examples}=await import('../src/lib/examples.js');
  for(const example of examples) {
    const model=TutorEngine.build(example.text,example.title);
    const excluded=model.terms.filter(term=>!term.definition).map(term=>term.id);
    const input={title:example.title,text:example.text,required:'',exampleId:example.id,draft:model,excluded,stage:2,sources:example.sources,method:'Правила извлечения'};
    assert.deepEqual(validateDraft(model,excluded),[]);
    const restored=parseSaved(serializeSaved(input));
    assert(restored,example.title+' must remain restorable');
    assert.equal(restored.stage,2);
    const pack=createPackage(restored.draft,restored.excluded,restored.sources,restored.method);
    assert(pack.terms.length>0);
    assert(pack.excerpts.every(fragment=>example.text.includes(fragment.text)));
    assert.deepEqual(pack.sources,example.sources.map(source=>({...source,detail:source.detail||''})));
  }
});
