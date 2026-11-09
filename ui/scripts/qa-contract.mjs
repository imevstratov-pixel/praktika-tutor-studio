import {createHash} from 'node:crypto';
import {readFile,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';

const sha=data=>createHash('sha256').update(data).digest('hex');
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const list=value=>Array.isArray(value)?value:[];
const integer=value=>Number.isInteger(value)&&value>=0;
export const requiredSteps=['typecheck','unit-and-server','production-build','browser'];
export const inputFile=name=>/\.(?:json|html)$/.test(name)||/\.config\.[cm]?[jt]s$/.test(name);
export async function fingerprint(root) {
  const files=[];
  async function scan(folder,optional=false) {
    let directory;
    try {directory=await lstat(path.join(root,folder));}
    catch(error){if(optional&&error.code==='ENOENT')return;throw error;}
    if(directory.isSymbolicLink())throw Error('Symlink in acceptance inputs: '+folder);
    for(const entry of await readdir(path.join(root,folder),{withFileTypes:true})) {
      const relative=path.posix.join(folder,entry.name);
      if(entry.isSymbolicLink())throw Error('Symlink in acceptance inputs: '+relative);
      if(entry.isDirectory())await scan(relative);
      else if(entry.isFile())files.push(relative);
    }
  }
  for(const folder of ['src','tests','scripts'])await scan(folder);
  await scan('../.github',true);
  for(const entry of await readdir(root,{withFileTypes:true})) {
    if(!inputFile(entry.name))continue;
    if(entry.isSymbolicLink())throw Error('Symlink in acceptance inputs: '+entry.name);
    if(entry.isFile())files.push(entry.name);
  }
  for(const entry of await readdir(path.resolve(root,'../local'),{withFileTypes:true})) {
    if(!/\.(?:mjs|command)$/.test(entry.name))continue;
    if(entry.isSymbolicLink())throw Error('Symlink in acceptance inputs: ../local/'+entry.name);
    if(entry.isFile())files.push('../local/'+entry.name);
  }
  const manifest=[];
  for(const file of [...new Set(files)].sort()) {
    const bytes=await readFile(path.resolve(root,file));
    manifest.push({file,bytes:bytes.length,sha256:sha(bytes)});
  }
  return {hash:sha(JSON.stringify(manifest)),manifest};
}

export function summarizeTap(text) {
  if(typeof text!=='string')text='';
  const entries=key=>[...text.matchAll(new RegExp('^# '+key+' (\\d+)\\s*$','gm'))];
  const value=key=>entries(key).length===1?Number(entries(key)[0][1]):NaN;
  const keys=['tests','pass','fail','skipped','todo','cancelled'];
  const inventory=[...text.matchAll(/^\s*# Subtest: (.+)$/gm)].map(m=>m[1]).sort();
  const outcomes=[...text.matchAll(/^\s*(not ok|ok) \d+(?: - .*)?$/gm)];
  const tests=value('tests');
  return {
    tests,passed:value('pass'),failed:value('fail'),skipped:value('skipped'),
    todo:value('todo'),cancelled:value('cancelled'),inventory,
    reportValid:keys.every(key=>entries(key).length===1)&&inventory.length===tests&&
      outcomes.length===tests&&outcomes.every(match=>match[1]==='ok')&&
      [...text.matchAll(/^TAP version 13\s*$/gm)].length===1&&!/^Bail out!/mi.test(text)
  };
}
export function summarizeBrowser(report) {
  const tests=[];
  let complete=Boolean(report&&Array.isArray(report.suites)&&Array.isArray(report.errors)&&report.stats);
  function walk(suite,parents=[]) {
    if(!suite||typeof suite!=='object'){complete=false;return;}
    const names=[...parents,suite.title||''];
    for(const spec of list(suite.specs)) {
      if(!spec||typeof spec.title!=='string'||!Array.isArray(spec.tests)||!spec.tests.length){complete=false;continue;}
      for(const test of spec.tests) {
        if(!test||!Array.isArray(test.results)){complete=false;continue;}
        const results=test.results.map(result=>({
          status:result?.status,retry:result?.retry,duration:result?.duration
        }));
        const errors=test.results.flatMap(result=>[
          ...list(result?.errors),...(result?.error?[result.error]:[])
        ]).map(error=>error?.message||String(error));
        tests.push({id:[spec.file||suite.file||'',...names,spec.title,test.projectName||''].join(' / '),
          expected:test.expectedStatus,status:test.status,results,errors});
      }
    }
    for(const child of list(suite.suites))walk(child,names);
  }
  for(const suite of list(report?.suites))walk(suite);
  const stats=report?.stats||{};
  const passed=tests.filter(test=>test.expected==='passed'&&test.status==='expected'&&test.results.length===1&&
    test.results[0].status==='passed'&&test.results[0].retry===0&&!test.errors.length).length;
  complete=complete&&['expected','unexpected','skipped','flaky'].every(key=>integer(stats[key]))&&
    stats.expected+stats.unexpected+stats.skipped+stats.flaky===tests.length&&stats.expected===passed;
  return {tests:tests.length,passed,skipped:stats.skipped,failed:stats.unexpected,flaky:stats.flaky,
    errors:list(report?.errors),cases:tests,inventory:tests.map(test=>test.id).sort(),reportValid:complete};
}

export function judgeRun(run,policy) {
  const reasons=[];
  if(!run||typeof run!=='object')return {passed:false,reasons:['Протокол прогона отсутствует.']};
  if(!policy||policy.consecutivePasses!==2||!integer(policy.minimumUnitTests)||policy.minimumUnitTests<1||
    !integer(policy.minimumBrowserTests)||policy.minimumBrowserTests<1||!integer(policy.maximumBundleBytes)||policy.maximumBundleBytes<1) {
    reasons.push('Некорректное правило приёмки.');
  }
  if(run.mode!=='full')reasons.push('Смоук не заменяет полный прогон.');
  if(!digest(run.sourceStart)||!digest(run.sourceEnd)||run.sourceStart!==run.sourceEnd||run.sourceChanged)reasons.push('Исходники или тесты изменились либо их отпечаток отсутствует.');
  if(typeof run.environment!=='string'||!run.environment.trim())reasons.push('Окружение прогона не зафиксировано.');
  const steps=list(run.steps);
  if(steps.length!==requiredSteps.length||requiredSteps.some((name,index)=>steps[index]?.name!==name)||
    steps.some(step=>step?.exitCode!==0||step?.timedOut!==false||step?.signal))reasons.push('Полный набор этапов не завершился успешно.');
  const unit=run.unit;
  if(!unit||unit.reportValid!==true||!integer(unit.tests)||unit.tests<(policy?.minimumUnitTests||1)||unit.passed!==unit.tests||
    unit.failed!==0||unit.skipped!==0||unit.todo!==0||unit.cancelled!==0||!Array.isArray(unit.inventory)||
    unit.inventory.length!==unit.tests||new Set(unit.inventory).size!==unit.inventory.length)reasons.push('Автотесты данных и сервера не прошли полностью либо протокол неполный.');
  const browser=run.browser;
  if(!browser||browser.reportValid!==true||!integer(browser.tests)||browser.tests<(policy?.minimumBrowserTests||1)||browser.passed!==browser.tests||
    browser.skipped!==0||browser.failed!==0||browser.flaky!==0||!Array.isArray(browser.errors)||browser.errors.length||
    !Array.isArray(browser.cases)||browser.cases.length!==browser.tests||!Array.isArray(browser.inventory)||
    browser.inventory.length!==browser.tests||new Set(browser.inventory).size!==browser.inventory.length||
    list(browser.cases).some(test=>test?.expected!=='passed'||test.status!=='expected'||!Array.isArray(test.errors)||test.errors.length||
      !Array.isArray(test.results)||test.results.length!==1||test.results[0]?.retry!==0||test.results[0]?.status!=='passed'||
      !Number.isFinite(test.results[0]?.duration)||test.results[0].duration<0))reasons.push('Браузерные проверки не прошли с первой попытки без пропусков.');
  if(!digest(run.artifact?.sha256)||!integer(run.artifact?.bytes)||run.artifact.bytes<1||
    run.artifact.bytes>(policy?.maximumBundleBytes||0))reasons.push('Сборка отсутствует или превышает бюджет размера.');
  if(run.artifactChanged||!run.artifactEnd||run.artifactEnd.sha256!==run.artifact?.sha256||run.artifactEnd.bytes!==run.artifact?.bytes)reasons.push('Собранный файл изменился во время браузерной проверки.');
  if(run.error)reasons.push(String(run.error));
  return {passed:reasons.length===0,reasons};
}
export function judgeAcceptance(runs,policy) {
  if(!Array.isArray(runs)||policy?.consecutivePasses!==2||runs.length!==2||runs.some((run,index)=>run?.index!==index+1))return {accepted:false,reason:'Нужны два полных последовательных прогона в одном запуске приёмки.'};
  if(runs.some(run=>!judgeRun(run,policy).passed))return {accepted:false,reason:'Есть неуспешный прогон. Исправьте причину и начните оба прогона заново.'};
  const first=runs[0];
  if(runs.some(run=>run.sourceStart!==first.sourceStart||run.environment!==first.environment||run.artifact.sha256!==first.artifact.sha256||
    JSON.stringify(run.unit.inventory)!==JSON.stringify(first.unit.inventory)||JSON.stringify(run.browser.inventory)!==JSON.stringify(first.browser.inventory)))return {accepted:false,reason:'Версия, набор тестов, окружение или собранный файл различаются между прогонами.'};
  return {accepted:true,reason:'Два полных прогона подряд прошли на одной версии и одной сборке; пропусков и повторных попыток нет.'};
}
