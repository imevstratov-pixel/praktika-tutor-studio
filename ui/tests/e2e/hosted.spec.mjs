import {test as base, expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';

const fixture = JSON.parse(await readFile(new URL('../fixtures/hosted-recorded-lesson.json', import.meta.url), 'utf8'));
const ORIGIN = 'https://hosted.praktika.test';
const STORAGE = 'praktika.lesson.v2';
const test = base.extend({
  expectedNetworkErrors: [false, {option:true}],
  diagnostics: [async ({page, expectedNetworkErrors}, use) => {
    const errors=[];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if(message.type()!=='error') return;
      if(expectedNetworkErrors && /^Failed to load resource: (net::ERR_FAILED|the server responded with a status of (502|503))/u.test(message.text())) return;
      errors.push(message.text());
    });
    await use();
    expect(errors).toEqual([]);
  }, {auto:true}],
});

// The page and API are served in the browser's route layer. No model API,
// external host or paid service is contacted by these integration tests.
async function openPage(page, {hosted=true, origin=ORIGIN, status, structure} = {}) {
  const html=await readFile(new URL('../../../dist/index.html', import.meta.url), 'utf8');
  const requests={status:0,posts:[]};
  await page.route(origin+'/**', async route => {
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/status') {
      requests.status++;
      if(status) await status(route,requests.status);
      else await route.fulfill({json:{ai:true,provider:fixture.provider}});
    } else if(path==='/api/structure') {
      requests.posts.push(route.request().postDataJSON());
      if(structure) await structure(route,requests.posts.length);
      else await route.fulfill({json:fixture.response});
    } else if(route.request().isNavigationRequest()) {
      await route.fulfill({contentType:'text/html',body:hosted?html.replace('<head>','<head><meta name="praktika-api" content="same-origin">'):html});
    } else {
      throw new Error('Unexpected hosted-page request: '+path);
    }
  });
  await page.goto(origin+'/');
  await expect(page.getByRole('heading',{level:1,name:'Подготовьте занятие по вашей лекции'})).toBeVisible();
  return requests;
}
async function fillLecture(page) {
  await page.getByLabel(/^Название занятия/u).fill(fixture.title);
  await page.getByLabel('Текст лекции',{exact:true}).fill(fixture.text);
}
const prepare=page=>page.getByRole('button',{name:'Подготовить содержание',exact:true});
const saved=page=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),STORAGE);

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}}
const processing=page=>page.getByRole('region',{name:'Ход подготовки',exact:true});

test('hosted progress: long wait stays on the real operation, shows elapsed time and finishes on response',async({page},testInfo)=>{
  const start=new Date('2026-11-11T12:00:00Z');
  await page.clock.setFixedTime(start);
  const reply=deferred();
  try{
    const requests=await openPage(page,{structure:async route=>{await reply.promise;await route.fulfill({json:fixture.response})}});
    await fillLecture(page);
    await prepare(page).click();
    const heading=page.getByRole('heading',{level:1,name:'Готовим содержание занятия'});
    await expect(heading).toBeVisible();await expect(heading).toBeFocused();
    await expect(processing(page)).toBeVisible();
    await expect(page.getByLabel('Текст лекции',{exact:true})).toHaveCount(0);
    for(const button of await page.getByRole('navigation',{name:'Подготовка занятия'}).getByRole('button').all())await expect(button).toBeDisabled();
    await expect(page.getByRole('button',{name:'Новое занятие',exact:true})).toBeDisabled();
    await expect(processing(page).locator('[aria-current="step"]')).toContainText('ИИ выделяет темы, термины и связи');
    await expect(processing(page).getByText(/^Прошло /)).toHaveText(/^Прошло 0:0\d$/);
    expect(await processing(page).getByText(/^Прошло /).evaluate(node=>node.closest('[aria-live]')?.getAttribute('aria-live'))).toBe('off');
    await page.clock.setFixedTime(new Date(start.getTime()+31_000));
    await expect(processing(page)).toContainText('ИИ всё ещё готовит ответ');
    await expect(processing(page).getByText(/^Прошло /)).toHaveText(/^Прошло 0:3\d$/);
    await page.clock.setFixedTime(new Date(start.getTime()+121_000));
    await expect(processing(page)).toContainText('Можно подождать или отменить разбор');
    await expect(processing(page).getByText(/^Прошло /)).toHaveText(/^Прошло 2:0\d$/);
    await expect(processing(page).locator('[aria-current="step"]')).toContainText('ИИ выделяет темы, термины и связи');
    expect(await processing(page).innerText()).not.toContain('%');
    expect(requests.posts).toHaveLength(1);
    await page.screenshot({path:testInfo.outputPath('processing-desktop.png'),fullPage:true,animations:'disabled'});
    reply.resolve();
    await expect(page.getByRole('heading',{level:1,name:'Проверьте, чему будет учить тьютор'})).toBeVisible();
    await expect(processing(page)).toHaveCount(0);
    expect((await saved(page)).draft).toEqual(fixture.response);
  }finally{reply.resolve()}
});

test('hosted progress: mobile reduced-motion screen remains readable and cancellation preserves the lecture',async({page},testInfo)=>{
  await page.setViewportSize({width:390,height:844});
  await page.emulateMedia({reducedMotion:'reduce'});
  const reply=deferred();
  try{
    const requests=await openPage(page,{structure:async route=>{await reply.promise;await route.fulfill({json:fixture.response}).catch(()=>{})}});
    await fillLecture(page);
    await page.getByRole('button',{name:'Есть термины, которые важно сохранить?'}).click();
    await page.getByLabel('Обязательные термины',{exact:true}).fill('Повторный визит');
    await prepare(page).click();
    await expect(processing(page)).toBeVisible();
    await expect(page.getByRole('button',{name:'Отменить разбор',exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    expect(await processing(page).evaluate(el=>el.getAnimations({subtree:true}).filter(a=>a.playState==='running'&&a.effect?.getTiming().iterations===Infinity).length)).toBe(0);
    await page.screenshot({path:testInfo.outputPath('processing-mobile.png'),fullPage:true,animations:'disabled'});
    await page.getByRole('button',{name:'Отменить разбор',exact:true}).click();
    await expect(processing(page)).toHaveCount(0);
    await expect(page.getByRole('note')).toContainText('Разбор отменён. Текст лекции сохранён.');
    await expect(page.getByRole('heading',{level:1,name:'Подготовьте занятие по вашей лекции'})).toBeFocused();
    await expect(page.getByLabel('Текст лекции',{exact:true})).toHaveValue(fixture.text);
    await expect(page.getByLabel(/^Название занятия/u)).toHaveValue(fixture.title);
    expect((await saved(page)).required).toBe('Повторный визит');
    expect((await saved(page)).draft).toBeNull();
    expect(requests.posts).toHaveLength(1);
  }finally{reply.resolve()}
});

test('hosted progress: a cancelled late response cannot replace a newer preparation',async({page})=>{
  // Model a transport that completes after cancellation. No network leaves the
  // route fixture; this verifies result ownership, not only AbortController.
  await page.addInitScript(()=>{
    const original=window.fetch;
    window.__structureResponses=0;
    window.fetch=(url,options)=>String(url)==='/api/structure'?original(url,{...options,signal:undefined}).then(async response=>{
      await response.clone().text();window.__structureResponses++;return response;
    }):original(url,options);
  });
  const oldReply=deferred(),newReply=deferred(),oldDelivered=deferred();
  try{
    const requests=await openPage(page,{structure:async(route,attempt)=>{
      await (attempt===1?oldReply:newReply).promise;
      await route.fulfill({json:{...fixture.response,title:route.request().postDataJSON().title}});
      if(attempt===1)oldDelivered.resolve();
    }});
    await fillLecture(page);await prepare(page).click();
    await expect.poll(()=>requests.posts.length).toBe(1);
    await page.getByRole('button',{name:'Отменить разбор',exact:true}).click();
    await expect(prepare(page)).toBeEnabled();
    await page.getByLabel(/^Название занятия/u).fill('Новая версия лекции');
    await prepare(page).click();
    await expect.poll(()=>requests.posts.length).toBe(2);
    oldReply.resolve();await oldDelivered.promise;
    // Flush the completed old response through the page before checking that
    // its finally path did not hide the new request's loading screen.
    await expect.poll(()=>page.evaluate(()=>window.__structureResponses)).toBe(1);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await expect(processing(page)).toBeVisible();
    expect((await saved(page)).draft).toBeNull();
    newReply.resolve();
    await expect(page.getByRole('heading',{level:1,name:'Проверьте, чему будет учить тьютор'})).toBeVisible();
    const state=await saved(page);
    expect(state.title).toBe('Новая версия лекции');expect(state.draft.title).toBe('Новая версия лекции');
    expect(requests.posts).toHaveLength(2);
  }finally{oldReply.resolve();newReply.resolve()}
});

test('hosted progress: request deadline returns to an editable lecture with a helpful error',async({page})=>{
  await page.clock.install();
  const reply=deferred();
  try{
    const requests=await openPage(page,{structure:async route=>{await reply.promise;await route.fulfill({json:fixture.response}).catch(()=>{})}});
    await fillLecture(page);
    await expect(prepare(page)).toBeEnabled();
    await page.clock.pauseAt((await page.evaluate(()=>Date.now()))+1000);
    await prepare(page).click();
    await page.clock.runFor(300);
    await expect(processing(page)).toBeVisible();
    await page.clock.fastForward(198_700);
    await expect(processing(page)).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.clock.fastForward(1001);
    await expect(processing(page)).toHaveCount(0);
    await expect(page.getByRole('alert')).toContainText('не успел');
    await expect(page.getByLabel('Текст лекции',{exact:true})).toHaveValue(fixture.text);
    await expect(prepare(page)).toBeEnabled();
    expect((await saved(page)).draft).toBeNull();expect(requests.posts).toHaveLength(1);
  }finally{reply.resolve()}
});

test('hosted: waits for status, then uses the recorded API response and keeps its provenance in export', async ({page}) => {
  let release;
  const gate=new Promise(resolve=>{release=resolve});
  const requests=await openPage(page,{status:async (route,attempt)=>{await gate;await route.fulfill({json:{ai:true,provider:fixture.provider,remaining:attempt===1?3:2}})}});
  await fillLecture(page);
  await expect(page.getByRole('status')).toContainText('Проверяем доступность');
  await expect(prepare(page)).toBeDisabled();
  expect(requests.posts).toEqual([]);
  release();
  await expect(prepare(page)).toBeEnabled();
  await expect(page.getByRole('status')).toContainText(fixture.provider);
  await expect(page.getByRole('status')).toContainText('Демо: ИИ готовит черновик');
  await prepare(page).click();
  await expect(page.getByRole('heading',{level:1,name:'Проверьте, чему будет учить тьютор'})).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Осталось запусков ИИ: 2.');
  expect(requests.status).toBe(2);
  expect(requests.posts).toEqual([{title:fixture.title,text:fixture.text}]);
  const state=await saved(page);
  expect(state.draft).toEqual(fixture.response);
  expect(state.method).toBe(fixture.provider);
  await page.getByRole('button',{name:'Посмотреть результат',exact:true}).click();
  const pending=page.waitForEvent('download');
  await page.getByRole('button',{name:'Скачать файл занятия',exact:true}).click();
  const download=await pending;
  expect(await download.failure()).toBeNull();
  const pack=JSON.parse(await readFile(await download.path(),'utf8'));
  expect(pack.provenance.method).toBe(fixture.provider);
  expect(pack.terms).toEqual(fixture.response.terms);
  expect(pack.links).toEqual(fixture.response.links);
});

test('hosted: provider off cannot silently prepare by local rules; retry recovers', async ({page}) => {
  const requests=await openPage(page,{status:(route,attempt)=>route.fulfill({json:attempt===1?{ai:false,provider:'off'}:{ai:true,provider:fixture.provider}})});
  await fillLecture(page);
  await expect(page.getByRole('status')).toContainText('Сервис подготовки сейчас недоступен');
  await expect(prepare(page)).toBeDisabled();
  expect((await saved(page)).draft).toBeNull();
  expect(requests.posts).toEqual([]);
  await page.getByRole('button',{name:'Проверить ещё раз',exact:true}).click();
  await expect(prepare(page)).toBeEnabled();
  await prepare(page).click();
  await expect(page.getByRole('heading',{level:1,name:'Проверьте, чему будет учить тьютор'})).toBeVisible();
  await expect.poll(()=>requests.status).toBe(3);
  expect(requests.posts).toHaveLength(1);
  expect((await saved(page)).method).toBe(fixture.provider);
});

test('hosted: status timeout leaves editing available but never prepares or sends the lecture', async ({page}) => {
  let release;
  const gate=new Promise(resolve=>{release=resolve});
  try {
    const requests=await openPage(page,{status:async route=>{await gate;await route.abort().catch(()=>{})}});
    await fillLecture(page);
    await expect(prepare(page)).toBeDisabled();
    await expect(page.getByRole('status')).toContainText('Сервис подготовки сейчас недоступен',{timeout:12_000});
    await expect(prepare(page)).toBeDisabled();
    await expect(page.getByLabel('Текст лекции',{exact:true})).toBeEnabled();
    await expect(page.getByRole('button',{name:'Проверить ещё раз',exact:true})).toBeVisible();
    expect(requests.posts).toEqual([]);
    expect((await saved(page)).draft).toBeNull();
  } finally { release(); }
});

test.describe('hosted failures',()=>{
  test.use({expectedNetworkErrors:true});
  test('status HTTP failure leaves no draft or fallback POST', async ({page})=>{
    const requests=await openPage(page,{status:route=>route.fulfill({status:503,json:{error:'Unavailable'}})});
    await fillLecture(page);
    await expect(page.getByRole('status')).toContainText('Сервис подготовки сейчас недоступен');
    await expect(prepare(page)).toBeDisabled();
    expect(requests.posts).toEqual([]);
    expect((await saved(page)).draft).toBeNull();
  });
  test('failed AI extraction is shown and never replaced by local rules', async ({page})=>{
    const requests=await openPage(page,{
      status:(route,attempt)=>route.fulfill({json:{ai:true,provider:fixture.provider,remaining:attempt===1?2:1}}),
      structure:route=>route.fulfill({status:502,json:{error:'Не удалось получить ответ. Попробуйте ещё раз.'}}),
    });
    await fillLecture(page);
    await expect(prepare(page)).toBeEnabled();
    await prepare(page).click();
    await expect(page.getByRole('alert')).toContainText('Не удалось получить ответ');
    await expect(prepare(page)).toBeEnabled();
    await expect(page.getByRole('status')).toContainText('Осталось запусков ИИ: 1.');
    expect(requests.status).toBe(2);
    expect(requests.posts).toHaveLength(1);
    expect((await saved(page)).draft).toBeNull();
  });
});

test('hosted: exhausted quota is explained separately from an unavailable service', async ({page})=>{
  const requests=await openPage(page,{status:route=>route.fulfill({json:{ai:true,provider:fixture.provider,remaining:0,limit:20}})});
  await fillLecture(page);
  await expect(page.getByRole('status')).toContainText('Лимит демо исчерпан');
  await expect(page.getByRole('status')).not.toContainText('недоступен');
  await expect(prepare(page)).toBeDisabled();
  expect(requests.posts).toEqual([]);
  expect((await saved(page)).draft).toBeNull();
});

test('hosted: the last run refreshes quota, preserves materials and blocks another preparation', async ({page})=>{
  const requests=await openPage(page,{status:(route,attempt)=>route.fulfill({json:{ai:true,provider:fixture.provider,remaining:attempt===1?1:0,limit:20}})});
  await fillLecture(page);
  await expect(page.getByRole('status')).toContainText('Осталось запусков ИИ: 1.');
  await prepare(page).click();
  await expect(page.getByRole('heading',{level:1,name:'Проверьте, чему будет учить тьютор'})).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Лимит демо исчерпан');
  expect((await saved(page)).draft).toEqual(fixture.response);
  await page.getByRole('button',{name:'Посмотреть результат',exact:true}).click();
  await expect(page.getByRole('button',{name:'Скачать файл занятия',exact:true})).toBeEnabled();
  await page.getByRole('navigation',{name:'Подготовка занятия'}).getByRole('button').first().click();
  await expect(prepare(page)).toBeDisabled();
  await page.getByLabel('Текст лекции',{exact:true}).fill(fixture.text+'\nЕщё один фрагмент.');
  await expect(prepare(page)).toBeDisabled();
  expect(requests.posts).toHaveLength(1);
  expect(requests.status).toBe(2);
  expect((await saved(page)).draft).toBeNull();
});

test('public GitHub Pages without opt-in makes no API calls and preserves offline preparation', async ({page})=>{
  const requests=await openPage(page,{hosted:false,origin:'https://imevstratov-pixel.github.io'});
  await fillLecture(page);
  await expect(page.getByRole('status')).toContainText('текст разбирается по правилам');
  await prepare(page).click();
  await expect(page.getByRole('heading',{level:1,name:'Проверьте, чему будет учить тьютор'})).toBeVisible();
  expect(requests.status).toBe(0);
  expect(requests.posts).toEqual([]);
  expect((await saved(page)).method).toBe('Локальные правила');
});
