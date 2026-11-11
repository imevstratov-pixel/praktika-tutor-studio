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
      if(structure) await structure(route);
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
