#!/usr/bin/env node
/**
 * Verify a deployed static build without touching a user's browser or clipboard.
 * Usage (from ui):
 *   node scripts/verify-published.mjs https://OWNER.github.io/REPOSITORY/ --artifact /tmp/accepted/index.html
 * Requires an independently obtained accepted artifact, Playwright and Chromium.
 * The expected artifact must come from the accepted build/run, never from this site.
 * Reports and screenshots are written to reports/published/<timestamp>/.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect as playwrightExpect } from '@playwright/test';

const uiRoot = fileURLToPath(new URL('../', import.meta.url));
const defaultBuildPath = fileURLToPath(new URL('../../dist/index.html', import.meta.url));
const expect = playwrightExpect.configure({ timeout: 7_000 });
const marker = '\n\nДанные курса\n';
const title = 'Проверка опубликованного сайта — учебный пример';
const lecture = `# Цели и проверка результата
Цель проекта — это изменение для конкретной группы людей к установленному сроку. Показатель — это величина, по которой проверяют достижение цели. В вымышленном посёлке команда хочет, чтобы к июню девять автобусных рейсов из десяти приезжали к станции за пять минут до электрички. Для проверки считают долю рейсов, приехавших вовремя. Все числа и события в этом примере вымышлены.

# Работа команды
Задача проекта — это часть работы, которая приближает команду к нужному изменению. Команда изучит задержки и вместе с перевозчиком испытает другое расписание. У каждой части работы есть исполнитель и срок.

# Управление рисками
Риск проекта — это возможное событие, способное помешать достижению цели. Дорожные работы могут увеличить время поездки. Команда заранее уточняет даты ремонта и проверяет объезд.`;

function usage() {
  console.log('Usage: node scripts/verify-published.mjs https://OWNER.github.io/REPOSITORY/ [--artifact /path/to/accepted/index.html]');
  console.log('Expected artifact defaults to ../dist/index.html; use the accepted CI artifact for a CI deployment.');
  console.log('Checks the deployed bytes and an isolated browser workflow; reports: ui/reports/published/<timestamp>/');
}

const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
  usage();
  process.exit(0);
}
if (!(args.length === 1 || (args.length === 3 && args[1] === '--artifact' && args[2]))) {
  usage();
  process.exit(2);
}
const buildPath = args.length === 3 ? path.resolve(args[2]) : defaultBuildPath;

let requestedUrl;
try {
  requestedUrl = new URL(args[0]);
  assert.equal(requestedUrl.protocol, 'https:', 'A published HTTPS URL is required');
  assert(!requestedUrl.username && !requestedUrl.password, 'Credentials are not allowed in the site URL');
  assert(!requestedUrl.hash, 'Use the published page URL without a fragment');
} catch (error) {
  console.error('Invalid published URL: ' + error.message);
  process.exit(2);
}

const startedAt = new Date().toISOString();
const reportDir = path.join(uiRoot, 'reports', 'published', startedAt.replace(/[:.]/gu, '-'));
await mkdir(reportDir, { recursive: true });
const report = {
  status: 'running', startedAt, requestedUrl: requestedUrl.href,
  syntheticInput: true, persistentProfile: false, clipboard: 'page-local test double; OS clipboard untouched',
  acceptedBuild: { path: buildPath }, publishedBuild: {}, checks: [], requests: [],
  pageErrors: [], consoleErrors: [], networkViolations: [], artifacts: [],
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const check = name => report.checks.push({ name, passed: true });
let browser;
let context;
let page;
let timedOut = false;
const totalDeadline = setTimeout(() => {
  timedOut = true;
  report.status = 'failed';
  report.error = { name: 'VerificationTimeout', message: 'Published verification exceeded the 180-second deadline' };
  const stop = () => {
    report.finishedAt = new Date().toISOString();
    try { writeFileSync(path.join(reportDir, 'verification.json'), JSON.stringify(report, null, 2) + '\n'); }
    catch (error) { console.error('Could not write timeout report: ' + error.message); }
    console.error('FAIL published verification: deadline exceeded');
    console.error('Report: ' + path.join(reportDir, 'verification.json'));
    process.exit(1);
  };
  // Closing the isolated browser normally releases its child processes. A hung
  // transport still must not leave this verification command waiting forever.
  setTimeout(stop, 5_000);
  Promise.resolve(browser?.close()).then(stop, stop);
}, 180_000);

async function fetchPublished(url, expectedBytes) {
  let current = new URL(url);
  const redirects = [];
  for (let count = 0; count < 6; count++) {
    assert.equal(current.origin, url.origin, 'Published redirects must stay on the requested origin');
    const response = await fetch(current, {
      redirect: 'manual', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(30_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      assert(location, 'Redirect has no Location header');
      const next = new URL(location, current);
      assert.equal(next.origin, url.origin, 'Published redirects must stay on the requested origin');
      redirects.push({ from: current.href, to: next.href, status: response.status });
      await response.body?.cancel();
      current = next;
      continue;
    }
    assert.equal(response.status, 200, 'The published page must return HTTP 200');
    assert.match(response.headers.get('content-type') || '', /text\/html/iu, 'The published page must be HTML');
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      assert(length <= expectedBytes + 1024, 'Published response is larger than the accepted HTML build');
      chunks.push(chunk);
    }
    return { url: current, bytes: Buffer.concat(chunks), redirects, status: response.status };
  }
  throw new Error('Too many published-page redirects');
}

async function saveScreenshot(locator, filename) {
  await locator.screenshot({ path: path.join(reportDir, filename), animations: 'disabled' });
  report.artifacts.push(filename);
}

async function noOverflow(label) {
  const sizes = await page.evaluate(() => ({
    viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth,
  }));
  assert(sizes.document <= sizes.viewport + 1 && sizes.body <= sizes.viewport + 1, label + ': page overflows horizontally');
}

async function assertEvidence(graphPanel, node, pack) {
  const inspector = graphPanel.getByRole('region', { name: 'Сведения об узле', exact: true });
  await expect(inspector.getByText(node.definition || node.summary, { exact: true })).toBeVisible();
  await expect(inspector.locator('blockquote[data-evidence-id]')).toHaveCount(node.evidenceIds.length);
  for (const id of node.evidenceIds) {
    const fragment = pack.excerpts.find(item => item.id === id);
    assert(fragment, 'Inspector evidence ID must exist in the export');
    const quote = inspector.locator(`blockquote[data-evidence-id="${id}"]`);
    await expect(quote).toBeVisible();
    assert.equal(await quote.textContent(), fragment.text, 'Inspector quote must match the lecture exactly');
    await expect(inspector.getByText('Фрагмент ' + id, { exact: true })).toBeVisible();
  }
}

function assertPackage(pack) {
  assert.equal(pack.schemaVersion, '1.0');
  assert.equal(pack.title, title);
  assert.deepEqual(pack.provenance, { method: 'Локальные правила', reviewed: true, requiredTerms: [] });
  assert.deepEqual(pack.topics.map(node => node.name), ['Цели и проверка результата', 'Работа команды', 'Управление рисками']);
  assert.deepEqual(pack.terms.map(node => node.name), ['Цель проекта', 'Показатель', 'Задача проекта', 'Риск проекта']);
  const topicIds = new Set(pack.topics.map(node => node.id));
  const nodeIds = new Set([...pack.topics, ...pack.terms].map(node => node.id));
  const evidenceIds = new Set(pack.excerpts.map(fragment => fragment.id));
  assert.equal(nodeIds.size, pack.topics.length + pack.terms.length);
  for (const fragment of pack.excerpts) assert(lecture.includes(fragment.text), 'Evidence must come from the synthetic lecture');
  for (const node of [...pack.topics, ...pack.terms, ...pack.links]) {
    assert(node.evidenceIds.length > 0, 'Every exported claim must cite the lecture');
    for (const id of node.evidenceIds) assert(evidenceIds.has(id), 'Unknown exported evidence ID');
  }
  for (const term of pack.terms) {
    assert(term.definition.trim(), 'Exported terms require definitions');
    assert(term.topicIds.length > 0, 'Exported terms require a topic');
    for (const id of term.topicIds) {
      assert(topicIds.has(id), 'Term belongs to an unknown topic');
      assert(pack.links.some(edge => edge.from === id && edge.to === term.id && edge.relation === 'содержит термин'));
    }
  }
  for (const edge of pack.links) assert(nodeIds.has(edge.from) && nodeIds.has(edge.to), 'Dangling graph edge');
  assert.deepEqual(new Set(pack.graph.nodes.map(node => node.id)), nodeIds);
  assert.deepEqual(pack.graph.edges, pack.links);
  assert.deepEqual(Object.keys(pack.prompts).sort(), ['evaluator', 'feedback', 'tutor']);
  for (const prompt of Object.values(pack.prompts)) {
    assert.deepEqual(JSON.parse(prompt.split(marker)[1]), {
      title: pack.title, topics: pack.topics, terms: pack.terms, links: pack.links, excerpts: pack.excerpts,
    }, 'Prompt context must match the reviewed package');
  }
  assert.deepEqual(pack.sources, []);
}

async function openPrompts() {
  await page.getByRole('tab', { name: 'Промпты', exact: true }).click();
  return page.getByRole('tabpanel', { name: 'Промпты', exact: true });
}

try {
  const accepted = await readFile(buildPath);
  report.acceptedBuild.sha256 = sha256(accepted);
  report.acceptedBuild.bytes = accepted.length;
  const published = await fetchPublished(requestedUrl, accepted.length);
  report.publishedBuild = {
    url: published.url.href, sha256: sha256(published.bytes), bytes: published.bytes.length,
    status: published.status, redirects: published.redirects,
  };
  assert.equal(report.publishedBuild.sha256, report.acceptedBuild.sha256, 'Published HTML differs from the accepted build');
  check('HTTP bytes match accepted build SHA-256');

  browser = await chromium.launch({ headless: true });
  report.environment = { node: process.version, platform: process.platform, chromium: browser.version() };
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 }, locale: 'ru-RU', timezoneId: 'Europe/Moscow',
    acceptDownloads: true, serviceWorkers: 'block',
  });
  page = await context.newPage();
  page.setDefaultTimeout(7_000);
  page.setDefaultNavigationTimeout(30_000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') report.consoleErrors.push(message.text());
  });
  page.on('requestfailed', request => report.networkViolations.push({ url: request.url(), reason: request.failure()?.errorText || 'Request failed' }));
  let allowedDocumentRequests = 0;
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
    const entry = { url: url.href, method: request.method(), type: request.resourceType() };
    report.requests.push(entry);
    let reason = '';
    if (url.origin !== published.url.origin) reason = 'Cross-origin network request';
    else if (/(?:^|\/)api(?:\/|$)/u.test(url.pathname)) reason = 'Static publication must not call a remote API';
    else if (request.method() !== 'GET' || !request.isNavigationRequest() || request.resourceType() !== 'document' ||
      request.frame() !== page.mainFrame() || url.href !== published.url.href || allowedDocumentRequests !== 0) {
      reason = 'Unexpected network request: the accepted build is a single inline HTML document';
    }
    if (reason) {
      report.networkViolations.push({ ...entry, reason });
      await route.abort('blockedbyclient');
      return;
    }
    allowedDocumentRequests++;
    await route.continue();
  });
  await page.addInitScript(() => {
    window.__publishedClipboardWrites = [];
    window.__publishedClipboardFallbacks = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async text => { window.__publishedClipboardWrites.push(text); } },
    });
    document.execCommand = command => {
      window.__publishedClipboardFallbacks.push(command);
      return false;
    };
  });

  const navigation = await page.goto(published.url.href, { waitUntil: 'networkidle' });
  assert(navigation && navigation.status() === 200, 'Browser navigation must load the published page successfully');
  report.publishedBuild.browserSha256 = sha256(await navigation.body());
  assert.equal(report.publishedBuild.browserSha256, report.acceptedBuild.sha256, 'Browser received different HTML bytes');
  await expect(page.getByRole('heading', { name: 'Подготовьте занятие по вашей лекции', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Текст лекции', { exact: true })).toHaveValue('');
  await expect(page.getByText('В этой версии текст разбирается по правилам. Проверьте предложенные темы и определения.', { exact: true })).toBeVisible();
  check('Fresh browser uses the static local-rules path');

  await page.getByLabel(/^Название занятия/u).fill(title);
  await page.getByLabel('Текст лекции', { exact: true }).fill(lecture);
  await page.getByRole('button', { name: 'Подготовить содержание', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Проверьте, чему будет учить тьютор', level: 1 })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /^Включить тему /u })).toHaveCount(3);
  await expect(page.getByRole('checkbox', { name: 'Включить термин Показатель', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Посмотреть результат', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Материалы занятия готовы', level: 1 })).toBeVisible();
  await noOverflow('Desktop result');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(reportDir, 'desktop-result.png'), fullPage: true, animations: 'disabled' });
  report.artifacts.push('desktop-result.png');
  check('Lecture → review → result on the published site');

  const pendingDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать файл занятия', exact: true }).click();
  const download = await pendingDownload;
  assert.match(download.suggestedFilename(), /\.json$/u);
  assert.equal(await download.failure(), null);
  const packagePath = path.join(reportDir, 'downloaded-lesson.json');
  await download.saveAs(packagePath);
  report.artifacts.push('downloaded-lesson.json');
  const pack = JSON.parse(await readFile(packagePath, 'utf8'));
  assertPackage(pack);
  report.package = { topics: pack.topics.length, terms: pack.terms.length, edges: pack.graph.edges.length, excerpts: pack.excerpts.length };
  check('Downloaded JSON has coherent graph, evidence and prompt contexts');

  const trigger = page.getByRole('button', { name: 'Для подключения тьютора: граф, промпты и источники', exact: true });
  const card = page.locator('section').filter({ has: trigger });
  await trigger.click();
  const graph = page.getByRole('tabpanel', { name: 'Граф знаний', exact: true });
  const canvas = graph.getByRole('region', { name: 'Граф знаний: узлы и связи', exact: true });
  await expect(canvas.getByRole('button', { name: /^(Термин|Тема): /u })).toHaveCount(pack.graph.nodes.length);
  const paths = canvas.locator('path[data-graph-edge]');
  await expect(paths).toHaveCount(pack.graph.edges.length);
  const drawn = await paths.evaluateAll(nodes => nodes.map(node => ({ from: node.dataset.from, to: node.dataset.to, relation: node.dataset.relation })));
  assert.deepEqual(new Set(drawn.map(edge => JSON.stringify(edge))),
    new Set(pack.graph.edges.map(({ from, to, relation }) => JSON.stringify({ from, to, relation }))));
  assert(await paths.evaluateAll(nodes => nodes.every(node => node.getTotalLength() > 0 && getComputedStyle(node).stroke !== 'none')));
  const measure = pack.terms.find(term => term.name === 'Показатель');
  await canvas.getByRole('button', { name: 'Термин: Показатель', exact: true }).click();
  await assertEvidence(graph, measure, pack);
  await saveScreenshot(card, 'desktop-graph.png');
  check('Visual graph renders exported nodes and edges with exact lecture citations');

  const prompts = await openPrompts();
  const expectedWrites = [];
  for (const [label, key] of [['Ведение занятия', 'tutor'], ['Оценка ответа', 'evaluator'], ['Обратная связь', 'feedback']]) {
    await prompts.getByRole('button', { name: label, exact: true }).click();
    const [instruction, rawContext] = pack.prompts[key].split(marker);
    await expect(prompts.getByRole('region', { name: 'Текст инструкции', exact: true })).toHaveText(instruction);
    await prompts.getByRole('button', { name: 'Копировать текст', exact: true }).click();
    await expect(prompts.getByRole('button', { name: 'Текст скопирован', exact: true })).toBeVisible();
    expectedWrites.push(instruction);
    await prompts.getByText('Данные курса в этом промпте', { exact: true }).click();
    await prompts.getByRole('button', { name: 'Копировать JSON', exact: true }).click();
    await expect(prompts.getByRole('button', { name: 'JSON скопирован', exact: true })).toBeVisible();
    expectedWrites.push(JSON.stringify(JSON.parse(rawContext), null, 2));
    assert.deepEqual(await page.evaluate(() => window.__publishedClipboardWrites), expectedWrites);
    assert.deepEqual(await page.evaluate(() => window.__publishedClipboardFallbacks), []);
  }
  report.clipboardWrites = expectedWrites.map(text => ({ bytes: Buffer.byteLength(text), sha256: sha256(text) }));
  await prompts.getByText('Данные курса в этом промпте', { exact: true }).click();
  await saveScreenshot(card, 'desktop-prompts.png');
  check('Both copy controls receive exact text and JSON for all three instructions');

  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow('Mobile prompt reader');
  await saveScreenshot(card, 'mobile-prompts-390.png');
  await page.getByRole('tab', { name: 'Граф знаний', exact: true }).click();
  await canvas.getByRole('button', { name: 'Термин: Задача проекта', exact: true }).click();
  await assertEvidence(graph, pack.terms.find(term => term.name === 'Задача проекта'), pack);
  await noOverflow('Mobile graph');
  await saveScreenshot(card, 'mobile-graph-390.png');
  check('390px layout has no page overflow and graph node selection works');

  await page.waitForLoadState('networkidle');
  assert.deepEqual(report.pageErrors, [], 'Browser raised runtime exceptions');
  assert.deepEqual(report.consoleErrors, [], 'Browser logged console errors');
  assert.deepEqual(report.networkViolations, [], 'Static site attempted unexpected network access');
  assert.equal(report.requests.length, 1, 'Single-file static build should make only its initial document request');
  check('No browser errors, remote API calls, foreign hosts or additional network requests');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  if (!timedOut) report.error = { name: error.name, message: error.message, stack: error.stack };
  if (page && !page.isClosed()) {
    try {
      await page.screenshot({ path: path.join(reportDir, 'failure.png'), animations: 'disabled' });
      report.artifacts.push('failure.png');
    } catch { /* The JSON error remains available even if the browser closed. */ }
  }
  process.exitCode = 1;
} finally {
  try { await context?.close(); } catch (error) { report.cleanupError = error.message; process.exitCode = 1; report.status = 'failed'; }
  try { await browser?.close(); } catch (error) { report.cleanupError = error.message; process.exitCode = 1; report.status = 'failed'; }
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(reportDir, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  if (!timedOut) clearTimeout(totalDeadline);
}

console.log(`${report.status === 'passed' ? 'PASS' : 'FAIL'} published verification: ${report.checks.length} checks — ${requestedUrl.href}`);
console.log(`Report: ${path.join(reportDir, 'verification.json')}`);
if (report.error) console.error(report.error.message);
