import {spawn} from 'node:child_process';
import {watch,existsSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {fingerprint,summarizeTap,summarizeBrowser,judgeRun,judgeAcceptance,inputFile} from './qa-contract.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const mode=process.argv[2]||'accept';
if(!['accept','once','smoke'].includes(mode))throw Error('Use: quality.mjs accept | once | smoke');
const policy=JSON.parse(await readFile(path.join(root,'qa-policy.json'),'utf8'));
const stamp=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,6);
const reportDir=path.join(root,'reports',stamp);
await mkdir(reportDir,{recursive:true});
const environment=JSON.stringify({node:process.version,platform:process.platform,arch:process.arch});
const report={schemaVersion:1,mode,startedAt:new Date().toISOString(),environment:JSON.parse(environment),policy,runs:[],accepted:false,scope:policy.scope};
report.fixedIssues=JSON.parse(await readFile(path.join(root,"qa-findings.json"),"utf8"));
let running,interrupted='',signalTimer;
const mutations=new Set(),watchers=[];
function observe(folder,recursive,predicate=()=>true) {
  if(!existsSync(folder))return;
  const watcher=watch(folder,{recursive},(event,name)=>{
    const filename=String(name||'');
    if(!filename||predicate(filename))mutations.add(path.join(folder,filename));
  });
  watcher.on('error',()=>mutations.add('Наблюдение за исходниками прервано.'));
  watchers.push(watcher);
}
for(const name of ['src','tests','scripts'])observe(path.join(root,name),true);
observe(root,false,inputFile);
observe(path.resolve(root,'../local'),false,name=>/\.(?:mjs|command)$/.test(name));
observe(path.resolve(root,'../.github'),true);
observe(path.resolve(root,'..'),false,name=>name==='.github');
async function artifactFingerprint() {
  const artifact=await readFile(path.resolve(root,'../dist/index.html'));
  return {sha256:createHash('sha256').update(artifact).digest('hex'),bytes:artifact.length};
}
const childEnv={...process.env};
for(const key of Object.keys(childEnv))if(key.startsWith('TUTOR_'))delete childEnv[key];
function stop(child,signal='SIGTERM') {
  if(!child?.pid)return;
  try{if(process.platform==='win32')child.kill(signal);else process.kill(-child.pid,signal)}catch{}
}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{
  interrupted=signal;
  report.accepted=false;
  report.success=false;
  report.reason='Приёмка прервана сигналом '+signal+'.';
  const child=running;
  stop(child);
  clearTimeout(signalTimer);
  signalTimer=setTimeout(()=>stop(child,'SIGKILL'),3000);
  signalTimer.unref();
  process.exitCode=1;
});
async function command(run,name,args,timeoutMs,extraEnv={}) {
  if(interrupted)throw Error('Приёмка прервана сигналом '+interrupted+'.');
  if(mutations.size)throw Error('Исходники изменились во время приёмки.');
  console.log('['+run.index+'] '+name+'…');
  const start=Date.now();let stdout='',stderr='',timedOut=false,killTimer;
  const child=spawn(process.execPath,args,{cwd:root,env:{...childEnv,...extraEnv},detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
  running=child;
  child.stdout.on('data',d=>{stdout+=d;});child.stderr.on('data',d=>{stderr+=d;});
  const timer=setTimeout(()=>{timedOut=true;stop(child);killTimer=setTimeout(()=>stop(child,'SIGKILL'),3000);killTimer.unref()},timeoutMs);
  const completion=await new Promise(resolve=>{
    child.once('error',error=>{stderr+=error.message;resolve({code:-1,signal:null});});
    child.once('close',(code,signal)=>resolve({code:code??-1,signal}));
  });
  const code=completion.code;
  clearTimeout(timer);clearTimeout(killTimer);clearTimeout(signalTimer);running=null;
  // Stop descendants left behind by a crashed command, including a web server.
  stop(child);
  if(process.platform!=='win32'&&child.pid) {
    let groupRemains=false;
    try{process.kill(-child.pid,0);groupRemains=true;}catch{}
    if(groupRemains){await new Promise(resolve=>setTimeout(resolve,100));stop(child,'SIGKILL');}
  }
  const step={name,exitCode:code,durationMs:Date.now()-start,timedOut,signal:completion.signal||interrupted||null,log:name+'.log'};
  run.steps.push(step);
  await writeFile(path.join(run.directory,step.log),stdout+'\n'+stderr);
  if(interrupted)throw Error('Приёмка прервана сигналом '+interrupted+'.');
  if(code!==0||timedOut)throw Error(name+': '+(timedOut?'превышено время ожидания':('ошибка '+code))+'\n'+(stderr||stdout).slice(-1800));
  console.log('['+run.index+'] '+name+': OK ('+Math.round(step.durationMs/1000)+' с)');
  return stdout;
}
const first=await fingerprint(root);
report.sourceHash=first.hash;report.manifest=first.manifest;
for(let index=1;index<=(mode==='accept'?policy.consecutivePasses:1);index++) {
  const directory=path.join(reportDir,'run-'+index);await mkdir(directory,{recursive:true});
  const run={index,mode:mode==='smoke'?'smoke':'full',startedAt:new Date().toISOString(),directory,environment,sourceStart:(await fingerprint(root)).hash,steps:[]};
  report.runs.push(run);
  let artifactWatcher;
  try {
    if(run.sourceStart!==first.hash)throw Error('Состав исходников/тестов изменился. Начните приёмку заново.');
    if(mode!=='smoke') {
      await command(run,'typecheck',['node_modules/typescript/bin/tsc','--noEmit'],90000);
      const tap=await command(run,'unit-and-server',['scripts/test-unit.mjs','--tap'],120000);
      run.unit=summarizeTap(tap);
    }
    await command(run,'production-build',['scripts/build.mjs'],90000);
    run.artifact=await artifactFingerprint();
    artifactWatcher=watch(path.resolve(root,'../dist/index.html'),()=>{run.artifactChanged=true;});
    artifactWatcher.on('error',()=>{run.artifactChanged=true;});
    const args=['node_modules/@playwright/test/cli.js','test','--config=playwright.config.mjs'];
    if(mode==='smoke')args.push('--grep','@smoke');
    await command(run,'browser',args,240000,{QA_RUN_DIR:directory});
    run.browser=summarizeBrowser(JSON.parse(await readFile(path.join(directory,'browser.json'),'utf8')));
  }catch(error){run.error=error.message;console.error(run.error)}
  finally {
    artifactWatcher?.close();
    // A failed command may still have emitted a complete diagnostic report.
    if(!run.unit&&mode!=='smoke') {
      try {run.unit=summarizeTap(await readFile(path.join(directory,'unit-and-server.log'),'utf8'));}catch{}
    }
    if(!run.browser) {
      try {run.browser=summarizeBrowser(JSON.parse(await readFile(path.join(directory,'browser.json'),'utf8')));}catch{}
    }
    try {
      run.sourceEnd=(await fingerprint(root)).hash;
      if(run.artifact)run.artifactEnd=await artifactFingerprint();
    } catch(error) {run.error=run.error||error.message;}
    run.sourceChanged=mutations.size>0;
    if(interrupted)run.error='Приёмка прервана сигналом '+interrupted+'.';
    run.completedAt=new Date().toISOString();
    if(mode==='smoke') {
      const b=run.browser;
      run.passed=!run.error&&!run.sourceChanged&&!run.artifactChanged&&run.sourceStart===run.sourceEnd&&run.artifact?.sha256===run.artifactEnd?.sha256&&b?.reportValid===true&&b.tests>0&&b.passed===b.tests&&!b.skipped&&!b.failed&&!b.flaky&&!b.errors.length;
      run.reasons=run.passed?[]:[run.error||'Смоук-проверки не завершились полностью.'];
    }else Object.assign(run,judgeRun(run,policy));
    await writeFile(path.join(directory,'run.json'),JSON.stringify(run,null,2));
  }
  if(!run.passed)break;
}
for(const watcher of watchers)watcher.close();
report.inputChanges=[...mutations];
if(mutations.size||interrupted)for(const run of report.runs) {
  run.sourceChanged=mutations.size>0;
  run.error=run.error||(interrupted?'Приёмка прервана сигналом '+interrupted+'.':'Исходники изменились во время приёмки.');
  run.passed=false;
}
const verdict=judgeAcceptance(report.runs,policy);
report.accepted=mode==='accept'&&verdict.accepted;
report.reason=mode==='accept'?verdict.reason:mode==='smoke'?'Смоук — быстрая проверка работоспособности. Он не засчитывается как полная приёмка.':'Один полный прогон. Для приёмки выполните npm run accept.';
report.success=mode==='accept'?report.accepted:report.runs.every(r=>r.passed);
report.completedAt=new Date().toISOString();
report.improvements=[
  'Проверить точность определений и полноту тем на реальных транскриптах вместе с методистом. Эти автотесты не подтверждают качество реальной языковой модели.',
  'Добавить автоматические прогоны WebKit/Safari и Firefox после выбора поддерживаемых браузеров. Сейчас автоматическая приёмка выполняется в Chromium на широком и узком экранах.',
  'Согласовать формат JSON с действующим тьютором и проверить реальный импорт, диалог и обратную связь.',
  'Согласовать визуальный эталон с пользователями. Проверки переполнения и клавиатуры находят часть проблем, но не оценивают красоту и понятность всех экранов.'
];
const slow=report.runs.flatMap(r=>r.browser?.cases||[]).map(t=>({name:t.id,ms:Math.max(0,...t.results.map(r=>r.duration))})).sort((a,b)=>b.ms-a.ms).slice(0,5);
report.slowestBrowserTests=slow;
if(slow.some(t=>t.ms>5000))report.improvements.push("Есть браузерные сценарии дольше 5 секунд. Посмотрите их трассировки и отделите ожидание интерфейса от времени самого теста.");
if(report.runs.some(r=>r.artifact?.bytes>1500000))report.improvements.push("Автономный файл превысил 1,5 МБ. Проверьте размер шрифтов и подключаемых компонентов до достижения предела 2 МБ.");
await writeFile(path.join(reportDir,'report.json'),JSON.stringify(report,null,2));
await writeFile(path.join(reportDir,'report.html'),render(report));
await writeFile(path.join(root,'reports','latest.json'),JSON.stringify({directory:reportDir,...{accepted:report.accepted,success:report.success,sourceHash:report.sourceHash,completedAt:report.completedAt}},null,2));
console.log(report.reason+'\nОтчёт: '+path.join(reportDir,'report.html'));
process.exitCode=report.success&&!interrupted?0:1;

function render(r) {
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const title=r.accepted?'Техническая приёмка пройдена':r.success?'Проверки прошли. Приёмка ещё не завершена':'Найдены ошибки';
  const rows=r.runs.map(run=>`<tr><td>Прогон ${run.index}</td><td>${run.passed?'Пройден':'Не пройден'}</td><td>${run.unit?run.unit.passed+'/'+run.unit.tests:'—'}</td><td>${run.browser?run.browser.passed+'/'+run.browser.tests:'—'}</td><td>${Math.round(run.steps.reduce((a,s)=>a+s.durationMs,0)/1000)} с</td></tr>`).join('');
  const evidence=r.runs.map(run=>`<details><summary>Прогон ${run.index}: состав и результат</summary><p>Начало: ${esc(run.startedAt)}<br>Конец: ${esc(run.completedAt)}</p><p>Сборка: <code>${esc(run.artifact?.sha256)}</code> · ${Math.round((run.artifact?.bytes||0)/1024)} КБ</p>${run.reasons?.length?'<ul>'+run.reasons.map(e=>'<li>'+esc(e)+'</li>').join('')+'</ul>':''}<h3>Данные, сервер и правило приёмки</h3><ol>${(run.unit?.inventory||[]).map(n=>'<li>'+esc(n)+'</li>').join('')}</ol><h3>Сценарии в браузере</h3><ol>${(run.browser?.cases||[]).map(t=>'<li>'+esc(t.id)+' — '+esc(t.results.map(x=>x.status).join(', '))+'</li>').join('')}</ol></details>`).join('');
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Практика — проверка качества</title><style>body{margin:0;background:#f5f7fa;color:#213047;font:16px/1.6 system-ui,sans-serif}main{max-width:920px;margin:40px auto;padding:40px;background:white;border:1px solid #dfe6ef;border-radius:16px}h1{font-size:34px;line-height:1.2;letter-spacing:-.8px}h2{margin-top:32px}h3{font-size:17px}.badge{display:inline-block;padding:7px 13px;border-radius:6px;background:${r.success?'#e4f3eb':'#fee8e8'};color:${r.success?'#245a3d':'#9c2a2a'}}.muted{color:#647389}.notice{border-left:4px solid #2a5fc9;padding:10px 20px;background:#f0f5fe}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:12px 8px;border-bottom:1px solid #dee5ef}code{word-break:break-all;font-size:12px}details{border:1px solid #dfe6ef;border-radius:8px;padding:16px;margin:12px 0}summary{cursor:pointer;font-weight:600}li{margin:8px 0}a{color:#235ace}footer{font-size:13px;border-top:1px solid #dfe6ef;margin-top:28px;padding-top:20px}@media(max-width:600px){main{margin:0;padding:24px 18px;border-radius:0}h1{font-size:28px}table{font-size:13px}th,td{padding:8px 4px}}</style><main><p class="muted">Практика · протокол автоматической проверки · ${esc(r.completedAt)}</p><span class="badge">${esc(title)}</span><h1>Два зелёных прогона одной версии</h1><p>${esc(r.reason)}</p><p class="notice">${esc(r.scope)}<br>Зелёный отчёт подтверждает проверенные сценарии. Он не является доказательством отсутствия любых ошибок.</p><table><thead><tr><th>Запуск</th><th>Итог</th><th>Автотесты</th><th>Браузер</th><th>Время</th></tr></thead><tbody>${rows}</tbody></table><h2>Правило приёмки</h2><ol><li>Один запуск <code>npm run accept</code> выполняет два полных прогона последовательно.</li><li>В обоих проходят проверки типов, данных, сервера, сборки и браузерных сценариев. Пропуски, отмены, ожидаемые падения и автоматические повторы не засчитываются.</li><li>Исходники, тесты, настройки, зависимости, окружение и состав тестов совпадают. SHA-256 собранного HTML также совпадает.</li><li>Любая ошибка прекращает приёмку. После исправления оба прогона выполняются заново.</li></ol><h2>Исправления, защищённые автотестами</h2><p>${r.fixedIssues.length} воспроизведённых дефектов исправлены при расширении набора.</p>${r.fixedIssues.map(item=>`<details><summary>${esc(item.id)} · ${esc(item.area)}</summary><p>${esc(item.problem)}</p><p>${esc(item.fix)}</p><p class="muted">Проверка: ${esc(item.regression)}</p></details>`).join('')}<h2>Что ещё нужно оценить</h2><ul>${r.improvements.map(x=>'<li>'+esc(x)+'</li>').join('')}</ul><h2>Подтверждение прогона</h2><p>Отпечаток исходников и тестов: <code>${esc(r.sourceHash)}</code><br>Среда: ${esc(r.environment.node)} · ${esc(r.environment.platform)} · ${esc(r.environment.arch)}</p>${evidence}<details><summary>Самые длительные браузерные проверки</summary><ul>${r.slowestBrowserTests.map(t=>'<li>'+esc(t.name)+' — '+(t.ms/1000).toFixed(2)+' с</li>').join('')}</ul><p class="muted">Время зависит от компьютера. Это сигнал для исследования, а не оценка скорости реального модельного сервиса.</p></details><footer>Полные журналы, JSON-результаты и снимки ошибок сохраняются рядом с этим отчётом. Автотесты запускают отдельный Chromium с новым контекстом, не используют пользовательские вкладки и не вызывают настоящую модель. Подход к настройке: <a href="https://playwright.dev/docs/test-retries">повторные попытки</a>, <a href="https://playwright.dev/docs/test-webserver">тестовый сервер</a>, <a href="https://playwright.dev/docs/test-reporters">отчёты Playwright</a>.</footer></main></html>`;
}
