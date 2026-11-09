import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fingerprint,judgeAcceptance,judgeRun,summarizeTap,summarizeBrowser,requiredSteps} from '../scripts/qa-contract.mjs';

const policy={consecutivePasses:2,minimumUnitTests:1,minimumBrowserTests:1,maximumBundleBytes:2000000};
const source='a'.repeat(64), artifact='b'.repeat(64);
function good(index=1) {
  return {
    index,mode:'full',sourceStart:source,sourceEnd:source,environment:'same-env',
    steps:requiredSteps.map(name=>({name,exitCode:0,timedOut:false,signal:null})),
    artifact:{sha256:artifact,bytes:100},artifactEnd:{sha256:artifact,bytes:100},
    unit:{tests:1,passed:1,failed:0,skipped:0,todo:0,cancelled:0,inventory:['a'],reportValid:true},
    browser:{tests:1,passed:1,skipped:0,failed:0,flaky:0,errors:[],inventory:['b'],reportValid:true,
      cases:[{id:'b',expected:'passed',status:'expected',errors:[],results:[{status:'passed',retry:0,duration:1}]}]}
  };
}
const tap='TAP version 13\n# Subtest: actual case\nok 1 - actual case\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
function browserReport() {
  return {stats:{expected:1,skipped:0,unexpected:0,flaky:0},errors:[],suites:[{title:'file',specs:[
    {file:'flow.spec.mjs',title:'flow',ok:true,tests:[
      {projectName:'chromium',expectedStatus:'passed',status:'expected',results:[
        {status:'passed',retry:0,duration:2,errors:[]}
      ]}
    ]}
  ]}]};
}

test('acceptance requires exactly two full passing runs of identical inputs and output',()=> {
  assert.equal(judgeAcceptance([good()],policy).accepted,false);
  assert.equal(judgeAcceptance([good(),good(2)],policy).accepted,true);
  for(const edit of [
    run=>run.sourceStart='c'.repeat(64),run=>run.sourceEnd='c'.repeat(64),run=>run.environment='different',
    run=>{run.artifact.sha256='c'.repeat(64);run.artifactEnd.sha256='c'.repeat(64);},
    run=>run.unit.inventory=['replaced'],run=>{run.browser.inventory=['replaced'];run.browser.cases[0].id='replaced';},
    run=>run.mode='smoke',run=>run.index=1
  ]) {
    const second=good(2);edit(second);
    assert.equal(judgeAcceptance([good(),second],policy).accepted,false);
  }
});

test('server checks require a production build first, so a previous dist cannot satisfy acceptance',()=> {
  const steps=names=>names.map(name=>({name,exitCode:0,timedOut:false,signal:null}));
  const current=good();
  current.steps=steps(['typecheck','production-build','unit-and-server','browser']);
  assert.equal(judgeRun(current,policy).passed,true);

  const stale=good();
  stale.steps=steps(['typecheck','unit-and-server','production-build','browser']);
  assert.equal(judgeRun(stale,policy).passed,false);
  assert.equal(judgeAcceptance([stale,good(2)],policy).accepted,false);

  // The build is protected during server tests too, even if they restore its bytes.
  const altered=structuredClone(current);
  altered.artifactChanged=true;
  assert.equal(judgeRun(altered,policy).passed,false);
});

test('later green results never erase failures, skips, cancellations or retries',()=> {
  for(const edit of [
    run=>run.steps[0].exitCode=1,run=>run.unit.skipped=1,run=>run.unit.todo=1,run=>run.unit.cancelled=1,
    run=>run.unit.tests=0,run=>run.browser.tests=0,run=>run.browser.flaky=1,
    run=>run.browser.cases[0].results[0].retry=1,
    run=>run.browser.cases[0].results.unshift({status:'failed',retry:0,duration:2}),
    run=>run.browser.errors.push({message:'worker crashed'}),
    run=>run.browser.cases[0].errors.push('a passed case still reported an error'),
    run=>run.browser.cases[0].status='flaky',
    run=>run.browser.cases[0].expected='failed'
  ]) {
    const first=good();edit(first);
    assert.equal(judgeRun(first,policy).passed,false);
    assert.equal(judgeAcceptance([first,good(2)],policy).accepted,false);
  }
});

test('missing stages, timed out or signalled commands cannot receive green acceptance',()=> {
  for(const edit of [
    run=>run.steps.pop(),run=>run.steps.reverse(),run=>run.steps.push({...run.steps[0]}),
    run=>run.steps[0].timedOut=true,run=>run.steps[1].signal='SIGTERM',
    run=>run.error='Приёмка прервана сигналом SIGINT.'
  ]) {
    const run=good();edit(run);
    assert.equal(judgeRun(run,policy).passed,false);
  }
});

test('source mutation and output replacement are rejected even after their hashes are restored',()=> {
  for(const edit of [
    run=>run.sourceChanged=true,run=>run.artifactChanged=true,
    run=>delete run.sourceStart,run=>{delete run.sourceStart;delete run.sourceEnd;},
    run=>delete run.artifactEnd,run=>run.artifactEnd.sha256='c'.repeat(64),
    run=>run.artifactEnd.bytes++,run=>delete run.environment
  ]) {
    const run=good();edit(run);
    assert.equal(judgeRun(run,policy).passed,false);
  }
});

test('missing, inconsistent and oversized reports fail closed',()=> {
  for(const edit of [
    run=>delete run.unit,run=>delete run.browser,run=>delete run.artifact,run=>run.artifact.bytes=2000001,
    run=>run.unit.tests=NaN,run=>run.unit.inventory=[],run=>delete run.unit.reportValid,
    run=>run.browser.cases=[],run=>run.browser.inventory=[],run=>delete run.browser.reportValid,
    run=>run.browser.cases[0].results=[],run=>run.steps=[null]
  ]) {
    const run=good();edit(run);
    assert.equal(judgeRun(run,policy).passed,false);
  }
  assert.equal(judgeRun(null,policy).passed,false);
  assert.equal(judgeAcceptance(null,policy).accepted,false);
  assert.equal(judgeAcceptance([good(),good(2)],{...policy,consecutivePasses:1}).accepted,false);
});

test('TAP reader requires one complete report and matching executed cases',()=> {
  const summary=summarizeTap(tap);
  assert.deepEqual(summary,{tests:1,passed:1,failed:0,cancelled:0,skipped:0,todo:0,
    inventory:['actual case'],reportValid:true});
  for(const damaged of [
    '',tap+tap,tap.replace('# todo 0\n',''),tap.replace('# tests 1','# tests 2'),
    tap.replace('ok 1 - actual case','not ok 1 - actual case'),tap.replace('# Subtest: actual case\n',''),
    'Bail out! worker crashed\n'+tap
  ]) assert.equal(summarizeTap(damaged).reportValid,false);
});

test('browser reports retain retries and require complete, consistent result statistics',()=> {
  const summary=summarizeBrowser(browserReport());
  assert.equal(summary.reportValid,true);
  assert.equal(summary.passed,1);
  for(const mutate of [
    report=>delete report.stats,report=>delete report.errors,
    report=>report.stats.expected=2,report=>report.suites[0].specs[0].tests[0].results[0].retry=1,
    report=>report.suites[0].specs[0].tests[0].results.unshift({status:'failed',retry:0,duration:1}),
    report=>report.suites[0].specs[0].tests[0].results[0].errors=[{message:'worker error'}],
    report=>report.suites[0].specs[0].tests=[]
  ]) {
    const report=browserReport();mutate(report);
    const parsed=summarizeBrowser(report);
    const run=good();run.browser=parsed;
    assert.equal(judgeRun(run,policy).passed,false);
  }
  assert.equal(summarizeBrowser({}).reportValid,false);
});

test('fingerprint covers nested tests, local server and CI but ignores generated reports',async t=> {
  const folder=await mkdtemp(path.join(tmpdir(),'praktika-qa-gate-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const root=path.join(folder,'ui');
  for(const dir of ['ui/src','ui/tests/deep','ui/scripts','ui/reports','local','.github/workflows']) {
    await mkdir(path.join(folder,dir),{recursive:true});
  }
  await writeFile(path.join(root,'package.json'),'{}');
  await writeFile(path.join(root,'tests/deep/sample.test.mjs'),'test');
  await writeFile(path.join(folder,'local/server.mjs'),'server');
  await writeFile(path.join(folder,'.github/workflows/quality.yml'),'version1');
  const first=await fingerprint(root);
  assert(first.manifest.some(file=>file.file==='tests/deep/sample.test.mjs'));
  assert(first.manifest.some(file=>file.file==='../local/server.mjs'));
  assert(first.manifest.some(file=>file.file==='../.github/workflows/quality.yml'));
  await writeFile(path.join(root,'reports/result.json'),'generated');
  assert.equal((await fingerprint(root)).hash,first.hash);
  await writeFile(path.join(folder,'.github/workflows/quality.yml'),'version2');
  assert.notEqual((await fingerprint(root)).hash,first.hash);
});
