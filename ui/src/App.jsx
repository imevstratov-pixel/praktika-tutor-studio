import React, {useEffect, useRef, useState} from "react";
import {BookOpen, FileText, Check, ArrowRight, ArrowLeft, Upload, Download, Plus, Pencil, CheckCircle2, HelpCircle, Circle, RotateCcw} from "lucide-react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Textarea} from "@/components/ui/textarea";
import {Field, FieldLabel, FieldDescription, FieldError, FieldGroup} from "@/components/ui/field";
import {Checkbox} from "@/components/ui/checkbox";
import {Accordion, AccordionItem, AccordionTrigger, AccordionContent} from "@/components/ui/accordion";
import ResultMaterials from "./ResultMaterials";
import {Banner, BannerTitle, BannerDescription} from "@/components/ui/banner";
import {Progress} from "@/components/ui/progress";
import {Separator} from "@/components/ui/separator";
import engine from "@/lib/engine.mjs";
import examples from "@/lib/examples";
import {validateDraft,createPackage,preview,parseSaved,serializeSaved,MAX_TEXT} from "@/lib/course";
import {apiMode,readApiStatus} from "@/lib/api-client.mjs";

const STORAGE="praktika.lesson.v2";
const EMPTY={version:2,title:"",text:"",required:"",exampleId:null,draft:null,excluded:[],stage:0,sources:[],method:""};
const steps=[["Добавьте лекцию","Текст, с которым будет работать тьютор"],["Проверьте содержание","Темы занятия и значения терминов"],["Получите материалы","Пример вопроса и файлы для запуска"]];
const normalizeName=s=>s.trim().replace(/\s+/g," ").toLocaleLowerCase("ru");
const requiredNames=s=>[...new Map(s.split(/[,;\n]/).map(x=>x.trim().replace(/\s+/g," ")).filter(Boolean).map(x=>[normalizeName(x),x])).values()];
const cx=(...values)=>values.filter(Boolean).join(" ");
function initial(){try{return parseSaved(localStorage.getItem(STORAGE))||EMPTY}catch{return EMPTY}}
function saveFile(text,name,type="text/plain;charset=utf-8"){const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement("a");a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500)}
function Notice({title,children,status="info"}){return <Banner status={status}><BannerTitle>{title}</BannerTitle>{children&&<BannerDescription>{children}</BannerDescription>}</Banner>}
function Evidence({ids,draft}){const snippets=draft.excerpts.filter(q=>ids.includes(q.id));return snippets.length?<Accordion type="single" collapsible className="evidence w-full"><AccordionItem value="source"><AccordionTrigger>Свериться с текстом лекции</AccordionTrigger><AccordionContent>{snippets.map(q=><blockquote key={q.id}>{q.text}</blockquote>)}</AccordionContent></AccordionItem></Accordion>:<p className="issue">Выберите фрагмент лекции, который объясняет эту формулировку.</p>}
function SourcePicker({value,change,draft}){return <Field><FieldLabel htmlFor={"source-"+value.id}>Основание в лекции</FieldLabel><select id={"source-"+value.id} className="native-select" value={value.evidenceIds[0]||""} onChange={e=>change({evidenceIds:e.target.value?[e.target.value]:[]})}><option value="">Выберите фрагмент</option>{draft.excerpts.map(q=><option key={q.id} value={q.id}>{q.text.slice(0,150)}</option>)}</select></Field>}
function Term({term,draft,selectedTopics,included,mandatory,change,toggle,issues}) {
 const [editing,setEditing]=useState(!term.definition||!term.name);
 const errors=issues.filter(e=>e.id===term.id);
 return <article className={cx("term-row",!included&&"muted-row")} id={"item-"+term.id}>
  <div className="term-top"><div className="term-name"><Checkbox id={"use-"+term.id} checked={included} onCheckedChange={toggle} disabled={mandatory} aria-label={"Включить термин "+term.name}/><label htmlFor={"use-"+term.id}>{term.name||"Новый термин"}</label>{mandatory&&<span className="required-label">Обязательный</span>}</div><Button variant="ghost" leadingIcon={editing?Check:Pencil} onClick={()=>setEditing(!editing)} aria-expanded={editing}>{editing?"Свернуть":"Изменить"}</Button></div>
  {editing?<FieldGroup className="editor">
   <Field><FieldLabel htmlFor={"name-"+term.id}>Термин</FieldLabel><Input id={"name-"+term.id} value={term.name} readOnly={mandatory} onChange={e=>change({name:e.target.value})} maxLength={180}/></Field>
   <Field data-invalid={included&&!term.definition.trim()}><FieldLabel htmlFor={"def-"+term.id}>Как тьютор должен понимать термин</FieldLabel><Textarea id={"def-"+term.id} value={term.definition} onChange={e=>change({definition:e.target.value})} maxLength={MAX_TEXT} aria-invalid={included&&!term.definition.trim()} placeholder="Запишите определение из лекции…"/><FieldError>{included&&!term.definition.trim()?(mandatory?"Добавьте определение обязательного термина по лекции.":"В лекции не найдено явного определения. Уточните его или исключите термин."):null}</FieldError></Field>
   <Field><FieldLabel htmlFor={"topic-"+term.id}>Тема занятия</FieldLabel><select className="native-select" id={"topic-"+term.id} value={term.topicIds[0]||""} onChange={e=>change({topicIds:e.target.value?[e.target.value]:[]})}><option value="">Выберите тему</option>{selectedTopics.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
   <SourcePicker value={term} draft={draft} change={change}/>
  </FieldGroup>:<p className="term-definition">{term.definition||"Добавьте определение, чтобы использовать этот термин."}</p>}
  {included&&errors.length>0&&term.definition&&<p className="issue">{errors[0].message}</p>}
  <Evidence ids={term.evidenceIds} draft={draft}/>
 </article>
}
function Topic({topic,draft,included,change,toggle}){const [edit,setEdit]=useState(!topic.name);return <article id={"item-"+topic.id} className={cx("topic-row",!included&&"muted-row")}>
 <div className="term-top"><label className="topic-choice"><Checkbox checked={included} onCheckedChange={toggle} aria-label={"Включить тему "+topic.name}/><span>{topic.name||"Новая тема"}</span></label><Button variant="ghost" onClick={()=>setEdit(!edit)} leadingIcon={edit?Check:Pencil} aria-label={(edit?"Свернуть ":"Изменить тему ")+topic.name}>{edit?"Готово":"Изменить"}</Button></div>
 {edit?<FieldGroup className="editor"><Field><FieldLabel htmlFor={"topicname-"+topic.id}>Название темы</FieldLabel><Input id={"topicname-"+topic.id} maxLength={300} value={topic.name} onChange={e=>change({name:e.target.value})}/></Field><Field><FieldLabel htmlFor={"summary-"+topic.id}>Что важно понять слушателю</FieldLabel><Textarea id={"summary-"+topic.id} maxLength={5000} value={topic.summary} onChange={e=>change({summary:e.target.value})}/></Field><SourcePicker value={topic} change={change} draft={draft}/></FieldGroup>:<p>{topic.summary}</p>}
 </article>}
export default function App(){
 const [mode]=useState(()=>apiMode(location,document));
 const [state,setState]=useState(initial),[busy,setBusy]=useState(false),[error,setError]=useState(""),[saved,setSaved]=useState(true),[library,setLibrary]=useState(false),[pending,setPending]=useState(null),[api,setApi]=useState(()=>({ai:false,provider:"",phase:mode==="offline"?"offline":"checking"})),[statusAttempt,setStatusAttempt]=useState(0);
 const heading=useRef(null),file=useRef(null),abort=useRef(null);
 const {stage,draft}=state;
 const issues=draft?validateDraft(draft,state.excluded,requiredNames(state.required)):[];
 const selectedTopics=draft?.topics.filter(t=>!state.excluded.includes(t.id))||[];
 const selectedTerms=draft?.terms.filter(t=>!state.excluded.includes(t.id))||[];
 useEffect(()=>{try{const value=serializeSaved(state);if(value)localStorage.setItem(STORAGE,value);setSaved(Boolean(value))}catch{setSaved(false)}},[state]);
 useEffect(()=>{heading.current?.focus();window.scrollTo({top:0,behavior:"instant"})},[stage]);
 useEffect(()=>{
  if(mode==="offline")return;
  const controller=new AbortController();
  setApi({ai:false,provider:"",phase:"checking"});
  readApiStatus({signal:controller.signal}).then(status=>{
   if(!controller.signal.aborted)setApi({...status,phase:status.ai?"ready":mode==="hosted"?"unavailable":"offline"});
  }).catch(()=>{if(!controller.signal.aborted)setApi({ai:false,provider:"",phase:mode==="hosted"?"unavailable":"offline"})});
  return()=>controller.abort();
 },[mode,statusAttempt]);
 useEffect(()=>()=>abort.current?.abort(),[]);
 const patch=(v)=>setState(s=>({...s,...v}));
 function sourcePatch(v){setState(s=>({...s,...v,draft:null,excluded:[],stage:0,...("text" in v?{sources:[],exampleId:null}:{})}));setError("")}
 function go(n){patch({stage:n});setError("")}
 function toggle(id,on){
  const excluded=new Set(state.excluded);if(on)excluded.delete(id);else excluded.add(id);
  if(!on&&draft.topics.some(t=>t.id===id)){
   const required=new Set(requiredNames(state.required).map(normalizeName));
   for(const t of draft.terms)if(!required.has(normalizeName(t.name))&&!t.topicIds.some(topic=>!excluded.has(topic)))excluded.add(t.id);
  }
  patch({excluded:[...excluded]});setError("")
 }
 function updateItem(group,id,values){patch({draft:{...draft,[group]:draft[group].map(t=>t.id===id?{...t,...values}:t)}})}
 function loadExample(ex){setState({...EMPTY,title:ex.title,text:ex.text,exampleId:ex.id,sources:ex.sources});setError("");setLibrary(false);setPending(null)}
 function useExample(ex){if(state.text&&state.exampleId!==ex.id){setPending({type:"example",example:ex});return}loadExample(ex)}
 function clearLesson(){setState({...EMPTY});setError("");setLibrary(false);setPending(null)}
 function reset(){if(state.text||draft){setPending({type:"reset"});window.scrollTo({top:0,behavior:"instant"});return}clearLesson()}
 async function upload(e){try{const f=e.target.files[0];if(!f)return;if(!/\.(txt|md)$/i.test(f.name)||f.size>130000)throw Error("Выберите файл TXT или MD размером до 130 КБ.");const text=new TextDecoder("utf-8",{fatal:true}).decode(await f.arrayBuffer());if(text.length>MAX_TEXT||text.includes("\0"))throw Error("В файле должно быть до 32 000 знаков текста в UTF-8.");sourcePatch({text,title:f.name.replace(/\.[^.]+$/,"").slice(0,160)})}catch(err){setError(err.message||"Не удалось прочитать файл. Попробуйте вставить текст.")}finally{e.target.value=""}}
 async function prepare(){
  if(prepareBlocked)return;
  if(state.text.trim().length<45||state.text.length>MAX_TEXT){setError("Добавьте от 45 до 32 000 знаков текста лекции.");document.getElementById("lecture").focus();return}
  if(draft){go(1);return}
  setBusy(true);setError("");abort.current=new AbortController();
  let requestedAi=false;
  try{let d;const title=state.title.trim()||"Новое занятие";let usedMethod="Локальные правила";
   if(api.ai){requestedAi=true;const r=await fetch("/api/structure",{method:"POST",credentials:"same-origin",redirect:"error",headers:{"Content-Type":"application/json"},signal:AbortSignal.any([abort.current.signal,AbortSignal.timeout(200000)]),body:JSON.stringify({title,text:state.text})});const body=await r.json();if(!r.ok)throw Error(body.error||"Не удалось подготовить содержание.");d=body;usedMethod=api.provider}
   else if(mode!=="hosted"){await new Promise(r=>setTimeout(r,0));d=engine.build(state.text,title)}
   else throw Error("Сервис подготовки сейчас недоступен. Проверьте соединение и попробуйте ещё раз.");
   if(!d.topics.length)throw Error("Добавьте связный фрагмент лекции с пояснениями.");
   const excluded=d.terms.filter(t=>!t.definition).map(t=>t.id);
   for(const name of requiredNames(state.required)){let term=d.terms.find(t=>normalizeName(t.name)===normalizeName(name));if(!term){const evidence=d.excerpts.filter(e=>e.text.toLocaleLowerCase("ru").includes(name.toLocaleLowerCase("ru"))).map(e=>e.id);term={id:"term-"+crypto.randomUUID(),name,definition:"",evidenceIds:evidence,topicIds:d.topics.filter(t=>t.evidenceIds.some(id=>evidence.includes(id))).map(t=>t.id)};d.terms.push(term)}const i=excluded.indexOf(term.id);if(i>=0)excluded.splice(i,1)}
   patch({title,draft:d,excluded,stage:1,method:usedMethod});
  }catch(err){if(err.name!=="AbortError")setError(err.message||"Попробуйте ещё раз или сократите текст.")}finally{setBusy(false);if(mode==="hosted"&&requestedAi){setApi(s=>({...s,phase:"checking"}));setStatusAttempt(n=>n+1)}}
 }
 function finish(){if(issues.length){setError(issues[0].message);const row=document.getElementById("item-"+issues[0].id);row?.scrollIntoView({block:"center"});(row?.querySelector('[aria-invalid="true"],textarea:not([readonly]),input:not([readonly]):not([disabled]),select')||row?.querySelector("button:not([disabled])"))?.focus({preventScroll:true});return}go(2)}
 function bundle(){return createPackage(draft,state.excluded,state.sources,state.method||"Не указан",requiredNames(state.required))}
 function exportPackage(){try{saveFile(JSON.stringify(bundle(),null,2),"Занятие — "+state.title+".json","application/json")}catch(err){setError(err.message);go(1)}}
 function exportDescription(){const p=bundle(),sample=preview(draft,state.excluded);saveFile([p.title,"ТЕМЫ",...p.topics.map(t=>t.name+"\n"+t.summary),"СЛОВАРЬ",...p.terms.map(t=>t.name+" — "+t.definition),"ПРИМЕР ПЕРВОГО ВОПРОСА",sample.question,"ИСТОЧНИКИ",...p.sources.map(s=>s.name+"\n"+s.url)].join("\n\n"),"Описание занятия.txt")}
 const apiUnavailable=mode==="hosted"&&api.phase==="unavailable";
 const quotaExhausted=mode==="hosted"&&api.ai&&api.remaining===0;
 const prepareBlocked=api.phase==="checking"||apiUnavailable||quotaExhausted;
 const quotaNote=mode==="hosted"&&api.ai&&Number.isSafeInteger(api.remaining)?quotaExhausted?"Лимит демо исчерпан: доступных запусков больше нет.":"Осталось запусков ИИ: "+api.remaining+".":"";
 const note=api.phase==="checking"?"Проверяем доступность сервиса подготовки…":apiUnavailable?"Сервис подготовки сейчас недоступен. Проверьте соединение и попробуйте ещё раз.":quotaExhausted?quotaNote:api.ai?(quotaNote?quotaNote+" ":"")+"Текст будет отправлен в "+api.provider+". "+(mode==="hosted"?"Демо: ИИ готовит черновик. Проверьте определения, связи и источники перед использованием.":"После обработки проверьте темы и определения."):"В этой версии текст разбирается по правилам. Проверьте предложенные темы и определения.";
 return <div className="app">
  <a className="skip" href="#main">К содержанию</a>
  <aside className="sidebar">
   <div className="brand"><span className="brand-icon"><BookOpen size={22}/></span><span>Практика</span></div><p className="brand-purpose">Подготовка занятий<br/>с ИИ-тьютором</p>
   <nav aria-label="Подготовка занятия">{steps.map(([name,desc],i)=><button key={name} className={cx("step",stage===i&&"current",stage>i&&"done")} disabled={busy||(i>0&&!draft)||(i===2&&issues.length>0)} aria-current={stage===i?"step":undefined} onClick={()=>go(i)}><span className="step-mark">{stage>i?<Check size={15}/>:i+1}</span><span><strong>{name}</strong><small>{desc}</small></span></button>)}</nav>
   <div className="sidebar-bottom"><div className="save-note"><CheckCircle2 size={16}/><span>{saved?"Черновик сохраняется на этом устройстве":"Чтобы сохранить результат, скачайте файл"}</span></div><Button variant="ghost" leadingIcon={Plus} onClick={reset} disabled={busy}>Новое занятие</Button></div>
  </aside>
  <div className="workspace">
   <header className="topbar"><span>{state.title||"Новое занятие"}</span><span className="step-counter">Шаг {stage+1} из 3</span></header>
   <Progress value={stage+1} max={3} className="page-progress" aria-label="Этап подготовки" aria-valuetext={"Шаг "+(stage+1)+" из 3"}/>
   <main id="main" className="main">
    <div className="page-heading"><h1 ref={heading} tabIndex={-1}>{["Подготовьте занятие по вашей лекции","Проверьте, чему будет учить тьютор","Материалы занятия готовы"][stage]}</h1><p>{["Вставьте текст лекции. Мы соберём темы и словарь, чтобы тьютор помог слушателям закрепить материал.","Оставьте нужные темы и уточните определения. Эти формулировки станут основой ответов тьютора.","Посмотрите содержание и первый вопрос. Затем скачайте файлы для подключения тьютора."][stage]}</p></div>
    {stage>0&&mode==="hosted"&&quotaNote&&api.phase==="ready"&&<p className="processing-note" role="status">{quotaNote}</p>}
    {pending&&<div className="notice-wrap"><Notice status="warning" title={pending.type==="reset"?"Начать новое занятие?":"Заменить текст готовым примером?"}>Текущий черновик и ваши правки будут удалены.</Notice><div className="confirmation-actions"><Button variant="secondary" onClick={()=>setPending(null)}>Оставить текущий черновик</Button><Button onClick={()=>pending.type==="reset"?clearLesson():loadExample(pending.example)}>{pending.type==="reset"?"Начать новое":"Заменить текст"}</Button></div></div>}
    {error&&<div className="notice-wrap"><Notice status="error" title="Нужно уточнение">{error}</Notice></div>}
    {stage===0&&<div className="input-layout">
     <section className="sheet">
      <FieldGroup>
       <Field><FieldLabel htmlFor="lesson-title">Название занятия <span className="optional">по желанию</span></FieldLabel><Input id="lesson-title" name="lesson-title" autoComplete="off" value={state.title} onChange={e=>sourcePatch({title:e.target.value})} placeholder="Например, как сформулировать цель проекта…" maxLength={160} disabled={busy}/></Field>
       <Field data-invalid={Boolean(error)}><div className="label-row"><FieldLabel htmlFor="lecture">Текст лекции</FieldLabel><Button variant="ghost" leadingIcon={Upload} onClick={()=>file.current.click()} disabled={busy}>Загрузить файл</Button><input ref={file} type="file" aria-label="Файл лекции" accept=".txt,.md" hidden onChange={upload}/></div><Textarea id="lecture" name="lecture" autoComplete="off" className="lecture-input" value={state.text} onChange={e=>sourcePatch({text:e.target.value})} placeholder="Вставьте сюда расшифровку лекции или фрагмент учебного материала…" disabled={busy} aria-invalid={Boolean(error)}/><div className="input-meta"><FieldDescription>Текст, TXT или MD. До 32 000 знаков.</FieldDescription><span>{state.text.length.toLocaleString("ru")} знаков</span></div></Field>
      </FieldGroup>
      {state.exampleId&&<div className="sample-note"><FileText size={15}/><span>Учебный пример ШМК. Ситуация и числа вымышлены.</span></div>}
      <div className="form-end"><p className="processing-note" id="processing-note" role="status">{note}</p>{apiUnavailable&&<Button variant="secondary" onClick={()=>setStatusAttempt(n=>n+1)}>Проверить ещё раз</Button>}<Button className="main-action" loading={busy} disabled={prepareBlocked} aria-describedby="processing-note" trailingIcon={ArrowRight} onClick={prepare}>{busy?"Готовим содержание…":"Подготовить содержание"}</Button>{busy&&<Button variant="ghost" onClick={()=>abort.current.abort()}>Отменить</Button>}</div>
      <div className="sample-action"><Button variant="secondary" leadingIcon={BookOpen} onClick={()=>setLibrary(!library)} disabled={busy} aria-expanded={library}>Попробовать на готовом примере</Button>{library&&<div className="example-list">{examples.map(ex=><Button key={ex.id} variant="ghost" onClick={()=>useExample(ex)}>{ex.title}</Button>)}</div>}</div>
      <Accordion type="single" collapsible className="w-full"><AccordionItem value="required"><AccordionTrigger>Есть термины, которые важно сохранить?</AccordionTrigger><AccordionContent><Field><FieldLabel htmlFor="required">Обязательные термины</FieldLabel><Input id="required" name="required" autoComplete="off" value={state.required} onChange={e=>sourcePatch({required:e.target.value})} placeholder="Например, цель проекта, заинтересованная сторона…" maxLength={600} disabled={busy}/><FieldDescription>Укажите через запятую. Мы попросим проверить определение каждого.</FieldDescription></Field></AccordionContent></AccordionItem></Accordion>

     </section>
     <aside className="outcome-preview"><div className="outcome-heading"><span className="preview-icon"><CheckCircle2 size={24}/></span><h2>Что получится</h2></div><ul><li><Check size={17}/><div><strong>План занятия</strong><p>Темы, которые слушатель закрепит после лекции.</p></div></li><li><Check size={17}/><div><strong>Проверенный словарь</strong><p>Значения терминов, на которые будет опираться тьютор.</p></div></li><li><Check size={17}/><div><strong>Материалы для запуска</strong><p>Файл с содержанием и инструкциями для подключения тьютора.</p></div></li></ul><Separator/><div className="outcome-foot"><HelpCircle size={17}/><p>Все формулировки можно изменить перед сохранением.</p></div></aside>
    </div>}
    {stage===1&&draft&&<div className="review-layout">
     <div className="review-main">
      <section className="sheet"><div className="section-title"><h2>Темы занятия</h2><span>{selectedTopics.length} выбрано</span></div><p className="section-hint">Снимите галочку, если эту тему пока не нужно закреплять.</p>{draft.topics.map(t=><Topic key={t.id} topic={t} draft={draft} included={!state.excluded.includes(t.id)} toggle={on=>toggle(t.id,on)} change={values=>updateItem("topics",t.id,values)}/>)}</section>
      <section className="sheet"><div className="section-title"><h2>Словарь для тьютора</h2><span>{selectedTerms.length} выбрано</span></div><p className="section-hint">Прочитайте определения. По кнопке «Изменить» можно исправить смысл и указать его основание в лекции.</p>
       {issues.length>0&&<div className="notice-wrap"><Notice status="warning" title="Есть формулировки, которые нужно уточнить">{issues[0].message}</Notice></div>}
       {draft.terms.map(t=><Term key={t.id} term={t} draft={draft} selectedTopics={selectedTopics} included={!state.excluded.includes(t.id)} mandatory={requiredNames(state.required).some(n=>normalizeName(n)===normalizeName(t.name))} issues={issues} toggle={on=>toggle(t.id,on)} change={values=>updateItem("terms",t.id,values)}/>)}
       <Button variant="secondary" leadingIcon={Plus} onClick={()=>{const id="term-"+crypto.randomUUID();patch({draft:{...draft,terms:[...draft.terms,{id,name:"",definition:"",topicIds:selectedTopics.length?[selectedTopics[0].id]:[],evidenceIds:[]}]}})}}>Добавить свой термин</Button>
      </section>
     </div>
     <aside className="review-summary"><h2>Ваше занятие</h2><p>{state.title}</p><dl><div><dt>Темы</dt><dd>{selectedTopics.length}</dd></div><div><dt>Термины</dt><dd>{selectedTerms.length}</dd></div></dl><p className="caption">После проверки вы увидите пример первого вопроса и сможете скачать материалы.</p><Button className="main-action" trailingIcon={ArrowRight} onClick={finish}>Посмотреть результат</Button><Button variant="ghost" leadingIcon={ArrowLeft} onClick={()=>go(0)}>Вернуться к лекции</Button></aside>
    </div>}
    {stage===2&&draft&&<Result state={state} selectedTopics={selectedTopics} selectedTerms={selectedTerms} getPackage={bundle} exportPackage={exportPackage} exportDescription={exportDescription} back={()=>go(1)}/>}
   </main><footer className="footer">Практика <span>Рабочая версия для методиста</span></footer>
  </div>
 </div>
}

function Result({state,selectedTopics,selectedTerms,getPackage,exportPackage,exportDescription,back}) {
 const pack=getPackage(),sample=preview(state.draft,state.excluded);
 return <div className="result-layout">
  <div className="result-main">
   <section className="sheet lesson-plan"><div className="section-title"><h2>{state.title}</h2><span className="ready"><CheckCircle2 size={15} aria-hidden="true"/>Проверено вами</span></div><p className="section-hint">После лекции слушатель закрепит эти темы.</p><ol>{selectedTopics.map((topic,i)=><li key={topic.id}><span className="lesson-number">{i+1}</span><div><h3>{topic.name}</h3><p>{topic.summary}</p><div className="term-tags">{selectedTerms.filter(t=>t.topicIds.includes(topic.id)).map(t=><span key={t.id}>{t.name}</span>)}</div></div></li>)}</ol></section>
   <section className="sheet question-preview"><div className="section-title"><h2>Первый вопрос слушателю</h2><span>Предпросмотр</span></div><div className="tutor-message"><span className="tutor-avatar"><BookOpen size={20} aria-hidden="true"/></span><div><strong>Тьютор</strong><p>{sample.greeting}</p><p>{sample.question}</p></div></div><Accordion type="single" collapsible className="w-full"><AccordionItem value="answer"><AccordionTrigger>На какое определение опирается вопрос</AccordionTrigger><AccordionContent><p className="expected-answer">{sample.expected}</p><Evidence ids={sample.sourceIds} draft={state.draft}/></AccordionContent></AccordionItem></Accordion><p className="caption">Это пример по шаблону, чтобы проверить смысл занятия. Диалог и оценка ответов появятся после подключения тьютора.</p></section>
  </div>
  <aside className="download-panel"><span className="download-symbol"><FileText size={26} aria-hidden="true"/></span><h2>Сохраните результат</h2><p>Скачайте материалы и передайте человеку, который подключает тьютора.</p><Button className="main-action" leadingIcon={Download} onClick={exportPackage}>Скачать файл занятия</Button><p className="file-detail">JSON · граф, словарь и промпты</p><Button variant="secondary" leadingIcon={FileText} onClick={exportDescription}>Скачать описание</Button><p className="file-detail">TXT · для чтения и согласования</p><Separator/><p className="caption">Занятие ещё не опубликовано для слушателей. Для запуска нужно подключить файл к системе тьютора.</p><Button variant="ghost" leadingIcon={Pencil} onClick={back}>Вернуться к проверке</Button></aside>
  <ResultMaterials pack={pack} saveFile={saveFile}/>
 </div>
}
