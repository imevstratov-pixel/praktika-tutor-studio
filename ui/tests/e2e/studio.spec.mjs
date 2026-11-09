import { test as base, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// These tests use the production page and its real local extraction path.
// No successful AI response is mocked; the server is started with provider=off.
const STORAGE = 'praktika.lesson.v2';
const TITLE = 'Автобус и пересадка — учебный проект';
const LECTURE = `# Цели и проверка результата
Цель проекта — это изменение для конкретной группы людей к установленному сроку. В вымышленном посёлке команда хочет, чтобы к июню девять рейсов из десяти приезжали к станции за пять минут до электрички. Показатель — это величина, по которой проверяют достижение цели. В примере считают долю рейсов, приехавших вовремя. Контрольная точка помогает команде проверить ход работы: в заранее выбранный день команда сравнивает фактическое число своевременных рейсов с планом.

# Работа команды
Задача проекта — это часть работы, которая приближает команду к нужному изменению. Команда изучит задержки и вместе с перевозчиком испытает другое расписание. У каждой части работы есть исполнитель и срок. Все числа и события этого учебного примера вымышлены.

# Управление рисками
Риск проекта — это возможное событие, способное помешать достижению цели. Дорожные работы могут увеличить время поездки. Команда заранее уточняет даты ремонта и проверяет объезд. Это помогает подготовить меры до возникновения задержки.`;

const REPLACEMENT = `# Работа библиотеки
Читательский запрос — это сформулированная потребность посетителя в информации. В вымышленной библиотеке посетитель ищет книги об истории посёлка. Библиотекарь уточняет период, подбирает подходящие издания и проверяет, помогают ли они ответить на вопрос.`;

// Every scenario fails on browser exceptions and unexpected console errors.
// Expected negative HTTP responses, if added, must be allowed in that test only.
const test = base.extend({
  browserDiagnostics: [async ({ page }, use) => {
    const errors = [];
    const onPageError = error => errors.push('pageerror: ' + error.message);
    const onConsole = message => {
      if (message.type() === 'error') errors.push('console.error: ' + message.text());
    };
    page.on('pageerror', onPageError);
    page.on('console', onConsole);
    await use();
    page.off('pageerror', onPageError);
    page.off('console', onConsole);
    expect(errors, 'The production page must not emit browser exceptions or console errors').toEqual([]);
  }, { auto: true }],
});

const mainHeading = (page, text) => page.getByRole('heading', { level: 1, name: text });
const reviewHeading = page => mainHeading(page, 'Проверьте, чему будет учить тьютор');
const readyHeading = page => mainHeading(page, 'Материалы занятия готовы');
const nav = page => page.getByRole('navigation', { name: 'Подготовка занятия' });
const notice = (page, title) => page.getByRole('alert').filter({
  hasText: title, hasNot: page.getByRole('alert'),
});
const termRow = (page, name) => page.getByRole('article').filter({
  has: page.getByRole('checkbox', { name: 'Включить термин ' + name, exact: true }),
});
const topicRow = (page, name) => page.getByRole('article').filter({
  has: page.getByRole('checkbox', { name: 'Включить тему ' + name, exact: true }),
});

async function inputLecture(page, { title = TITLE, text = LECTURE, required = '' } = {}) {
  await page.goto('/');
  await expect(mainHeading(page, 'Подготовьте занятие по вашей лекции')).toBeVisible();
  await page.getByLabel(/^Название занятия/u).fill(title);
  await page.getByLabel('Текст лекции', { exact: true }).fill(text);
  if (required) {
    await page.getByRole('button', { name: 'Есть термины, которые важно сохранить?' }).click();
    await page.getByLabel('Обязательные термины', { exact: true }).fill(required);
  }
}

async function prepare(page, options) {
  await inputLecture(page, options);
  await page.getByRole('button', { name: 'Подготовить содержание', exact: true }).click();
  await expect(reviewHeading(page)).toBeVisible();
  await expect(reviewHeading(page)).toBeFocused();
}

async function finish(page) {
  await page.getByRole('button', { name: 'Посмотреть результат', exact: true }).click();
  await expect(readyHeading(page)).toBeVisible();
  await expect(readyHeading(page)).toBeFocused();
}

async function downloadPackage(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать файл занятия', exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.json$/u);
  expect(await download.failure()).toBeNull();
  const filename = await download.path();
  expect(filename).toBeTruthy();
  return JSON.parse(await readFile(filename, 'utf8'));
}

function assertPackageCoherent(pack, originalText = LECTURE) {
  expect(pack.schemaVersion).toBe('1.0');
  expect(pack.provenance).toMatchObject({ method: 'Локальные правила', reviewed: true });
  expect(pack.topics.length).toBeGreaterThan(0);
  expect(pack.terms.length).toBeGreaterThan(0);
  const topicIds = new Set(pack.topics.map(topic => topic.id));
  const nodeIds = new Set([...topicIds, ...pack.terms.map(term => term.id)]);
  const evidenceIds = new Set(pack.excerpts.map(fragment => fragment.id));
  expect(nodeIds.size).toBe(pack.topics.length + pack.terms.length);
  for (const fragment of pack.excerpts) expect(originalText).toContain(fragment.text);
  for (const record of [...pack.topics, ...pack.terms, ...pack.links]) {
    expect(record.evidenceIds.length).toBeGreaterThan(0);
    for (const id of record.evidenceIds) expect(evidenceIds.has(id)).toBe(true);
  }
  for (const term of pack.terms) {
    expect(term.definition.trim()).not.toBe('');
    expect(term.topicIds.length).toBeGreaterThan(0);
    for (const id of term.topicIds) {
      expect(topicIds.has(id)).toBe(true);
      expect(pack.links).toContainEqual(expect.objectContaining({ from: id, to: term.id, relation: 'содержит термин' }));
    }
  }
  for (const link of pack.links) {
    expect(nodeIds.has(link.from)).toBe(true);
    expect(nodeIds.has(link.to)).toBe(true);
  }
  expect(new Set(pack.graph.nodes.map(node => node.id))).toEqual(nodeIds);
  expect(pack.graph.edges).toEqual(pack.links);
  expect(Object.keys(pack.prompts).sort()).toEqual(['evaluator', 'feedback', 'tutor']);
  for (const prompt of Object.values(pack.prompts)) {
    expect(prompt).toContain('Используй только содержание курса');
    const course = JSON.parse(prompt.split('Данные курса\n')[1]);
    expect(course).toEqual({
      title: pack.title, topics: pack.topics, terms: pack.terms,
      links: pack.links, excerpts: pack.excerpts,
    });
  }
}

async function expectNoHorizontalOverflow(page) {
  const measurements = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(measurements.document).toBeLessThanOrEqual(measurements.viewport + 1);
  expect(measurements.body).toBeLessThanOrEqual(measurements.viewport + 1);
}

async function elementMetrics(locator) {
  return locator.evaluate(element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const horizontalPadding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const horizontalBorder = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
    return {
      width: rect.width,
      innerWidth: rect.width - horizontalPadding - horizontalBorder,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      fontSize: parseFloat(style.fontSize),
      lineHeight: parseFloat(style.lineHeight),
    };
  });
}

async function expectUsesAvailableWidth(content, container, minimumRatio) {
  await expect(content).toBeVisible();
  await expect.poll(async () => {
    const [contentMetrics, containerMetrics] = await Promise.all([
      elementMetrics(content), elementMetrics(container),
    ]);
    return contentMetrics.width / containerMetrics.innerWidth;
  }, { message: 'Readable content should use the available width instead of a fixed narrow column' }).toBeGreaterThanOrEqual(minimumRatio);
  const metrics = await elementMetrics(content);
  expect(metrics.scrollWidth, 'Content should wrap instead of requiring horizontal scrolling').toBeLessThanOrEqual(metrics.clientWidth + 1);
}

async function expectNodeEvidence(graphPanel, node, pack) {
  const inspector = graphPanel.getByRole('region', { name: 'Сведения об узле', exact: true });
  await expect(inspector).toBeVisible();
  await expect(inspector.getByText(node.definition || node.summary, { exact: true })).toBeVisible();
  await expect(inspector.locator('blockquote[data-evidence-id]')).toHaveCount(node.evidenceIds.length);
  for (const evidenceId of node.evidenceIds) {
    const excerpt = pack.excerpts.find(item => item.id === evidenceId);
    const quote = inspector.locator('blockquote[data-evidence-id]').filter({ hasText: excerpt.text });
    await expect(quote).toHaveAttribute('data-evidence-id', evidenceId);
    expect(await quote.textContent(), 'Graph citations must preserve the exact original lecture excerpt').toBe(excerpt.text);
    await expect(inspector.getByText('Фрагмент ' + evidenceId, { exact: true })).toBeVisible();
  }
}

async function installClipboardProbe(page, mode) {
  // The operating-system clipboard is never read or written by these tests.
  // Only this page's browser APIs are replaced, before the application loads.
  await page.addInitScript(mode => {
    window.__clipboardProbe = { writes: [], fallbacks: [] };
    window.__resolveClipboardWrites = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async text => {
          window.__clipboardProbe.writes.push(text);
          if (mode === 'deferred') return new Promise(resolve => window.__resolveClipboardWrites.push(resolve));
          if (mode !== 'success') throw new DOMException('Clipboard denied for this test', 'NotAllowedError');
        },
      },
    });
    document.execCommand = command => {
      const field = document.activeElement;
      window.__clipboardProbe.fallbacks.push({ command, text: field?.value });
      return command === 'copy' && mode === 'fallback';
    };
  }, mode);
}

async function preparePrompts(page) {
  await prepare(page);
  await finish(page);
  const pack = await downloadPackage(page);
  await page.getByRole('button', { name: 'Для подключения тьютора: граф, промпты и источники', exact: true }).click();
  await page.getByRole('tab', { name: 'Промпты', exact: true }).click();
  return { pack, prompts: page.getByRole('tabpanel', { name: 'Промпты', exact: true }) };
}

test('@smoke лекция → проверка → результат → проверенный JSON и описание', async ({ page, request }, testInfo) => {
  const status = await request.get('/api/status');
  expect(status.ok()).toBe(true);
  expect(await status.json()).toMatchObject({ ai: false });
  await prepare(page, { required: 'Цель проекта' });
  await expect(page.getByRole('checkbox', { name: 'Включить термин Цель проекта', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Включить термин Цель проекта', exact: true })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: /^Включить тему /u })).toHaveCount(3);
  await finish(page);
  await expect(page.getByRole('heading', { name: 'Первый вопрос слушателю', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'На какое определение опирается вопрос', exact: true }).click();
  await expect(page.getByRole('region', { name: 'На какое определение опирается вопрос', exact: true })
    .getByText('изменение для конкретной группы людей к установленному сроку.', { exact: true })).toBeVisible();
  const pack = await downloadPackage(page);
  expect(pack.title).toBe(TITLE);
  expect(pack.topics.map(topic => topic.name)).toEqual(['Цели и проверка результата', 'Работа команды', 'Управление рисками']);
  expect(pack.terms.map(term => term.name)).toEqual(['Цель проекта', 'Показатель', 'Задача проекта', 'Риск проекта']);
  expect(pack.provenance.requiredTerms).toEqual(['Цель проекта']);
  expect(pack.sources).toEqual([]);
  assertPackageCoherent(pack);
  const descriptionPending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать описание', exact: true }).click();
  const description = await descriptionPending;
  expect(description.suggestedFilename()).toBe('Описание занятия.txt');
  const descriptionText = await readFile(await description.path(), 'utf8');
  expect(descriptionText).toContain(TITLE);
  expect(descriptionText).toContain('Цель проекта — изменение');
  expect(descriptionText).toContain('ПРИМЕР ПЕРВОГО ВОПРОСА');
  await page.screenshot({ path: testInfo.outputPath('готовое-занятие-desktop.png'), fullPage: true, animations: 'disabled' });
});

test('обязательный термин без определения блокирует результат; правка снимает блокировку', async ({ page }) => {
  await prepare(page, { required: 'Контрольная точка' });
  const row = termRow(page, 'Контрольная точка');
  const definition = row.getByLabel('Как тьютор должен понимать термин', { exact: true });
  await expect(definition).toHaveValue('');
  await expect(row.getByRole('checkbox')).toBeChecked();
  await expect(row.getByRole('checkbox')).toBeDisabled();
  await expect(nav(page).getByRole('button', { name: /Получите материалы/u })).toBeDisabled();
  await page.getByRole('button', { name: 'Посмотреть результат', exact: true }).click();
  await expect(reviewHeading(page)).toBeVisible();
  await expect(notice(page, 'Нужно уточнение')).toContainText('Уточните определение термина по лекции.');
  await expect(definition).toBeFocused();
  await definition.fill('Заранее выбранный день, когда команда сравнивает фактическое число своевременных рейсов с планом.');
  await row.getByLabel('Тема занятия', { exact: true }).selectOption({ label: 'Цели и проверка результата' });
  const evidence = row.getByLabel('Основание в лекции', { exact: true });
  const evidenceId = await evidence.locator('option').filter({ hasText: 'Цель проекта — это изменение' }).getAttribute('value');
  await evidence.selectOption(evidenceId);
  await finish(page);
  const pack = await downloadPackage(page);
  expect(pack.terms).toContainEqual(expect.objectContaining({ name: 'Контрольная точка', definition: expect.stringContaining('Заранее выбранный день') }));
  expect(pack.provenance.requiredTerms).toEqual(['Контрольная точка']);
  assertPackageCoherent(pack);
});

test('изменение текста сбрасывает старую проверку и создаёт материалы по новой лекции', async ({ page }) => {
  await prepare(page);
  await finish(page);
  await nav(page).getByRole('button', { name: /Добавьте лекцию/u }).click();
  await page.getByLabel('Текст лекции', { exact: true }).fill(REPLACEMENT);
  await expect(nav(page).getByRole('button', { name: /Проверьте содержание/u })).toBeDisabled();
  await expect(nav(page).getByRole('button', { name: /Получите материалы/u })).toBeDisabled();
  await page.reload();
  await expect(page.getByLabel('Текст лекции', { exact: true })).toHaveValue(REPLACEMENT);
  await expect(nav(page).getByRole('button', { name: /Получите материалы/u })).toBeDisabled();
  await page.getByRole('button', { name: 'Подготовить содержание', exact: true }).click();
  await expect(reviewHeading(page)).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Включить термин Риск проекта', exact: true })).toHaveCount(0);
  await finish(page);
  const pack = await downloadPackage(page);
  expect(pack.terms.map(term => term.name)).toEqual(['Читательский запрос']);
  assertPackageCoherent(pack, REPLACEMENT);
});

for (const input of ['название', 'обязательные термины']) {
  test(`изменение поля «${input}» требует повторной проверки`, async ({ page }) => {
    await prepare(page);
    await finish(page);
    await nav(page).getByRole('button', { name: /Добавьте лекцию/u }).click();
    if (input === 'название') await page.getByLabel(/^Название занятия/u).fill('Новое название занятия');
    else {
      await page.getByRole('button', { name: 'Есть термины, которые важно сохранить?' }).click();
      await page.getByLabel('Обязательные термины', { exact: true }).fill('Риск проекта');
    }
    await expect(nav(page).getByRole('button', { name: /Проверьте содержание/u })).toBeDisabled();
    await expect(nav(page).getByRole('button', { name: /Получите материалы/u })).toBeDisabled();
    await page.getByRole('button', { name: 'Подготовить содержание', exact: true }).click();
    await expect(reviewHeading(page)).toBeVisible();
    await finish(page);
    const pack = await downloadPackage(page);
    if (input === 'название') expect(pack.title).toBe('Новое название занятия');
    else expect(pack.provenance.requiredTerms).toEqual(['Риск проекта']);
    assertPackageCoherent(pack);
  });
}

test('исключённая тема и её термины не остаются в графе, вопросе и промптах', async ({ page }) => {
  await prepare(page);
  await page.getByRole('checkbox', { name: 'Включить тему Управление рисками', exact: true }).uncheck();
  await expect(page.getByRole('checkbox', { name: 'Включить термин Риск проекта', exact: true })).not.toBeChecked();
  await finish(page);
  await expect(page.getByRole('heading', { name: 'Управление рисками', exact: true })).toHaveCount(0);
  const pack = await downloadPackage(page);
  expect(pack.topics.map(topic => topic.name)).not.toContain('Управление рисками');
  expect(pack.terms.map(term => term.name)).not.toContain('Риск проекта');
  expect(JSON.stringify(pack.graph)).not.toContain('Риск проекта');
  for (const prompt of Object.values(pack.prompts)) expect(prompt).not.toContain('Риск проекта');
  assertPackageCoherent(pack);
});

test('исключённый термин отсутствует в словаре, графе и контексте промптов', async ({ page }) => {
  await prepare(page);
  await page.getByRole('checkbox', { name: 'Включить термин Цель проекта', exact: true }).uncheck();
  await finish(page);
  await expect(page.getByText(/что означает «Цель проекта»/u)).toHaveCount(0);
  const pack = await downloadPackage(page);
  expect(pack.terms.map(term => term.name)).not.toContain('Цель проекта');
  expect(pack.graph.nodes.filter(node => node.type === 'term').map(node => node.label)).not.toContain('Цель проекта');
  // Original excerpts may still mention the excluded term; the approved glossary must not.
  assertPackageCoherent(pack);
});

test('перенос термина в другую тему обновляет связи экспортируемого графа', async ({ page }) => {
  await prepare(page);
  const row = termRow(page, 'Показатель');
  await row.getByRole('button', { name: 'Изменить', exact: true }).click();
  await row.getByLabel('Тема занятия', { exact: true }).selectOption({ label: 'Работа команды' });
  await finish(page);
  const pack = await downloadPackage(page);
  const term = pack.terms.find(term => term.name === 'Показатель');
  const oldTopic = pack.topics.find(topic => topic.name === 'Цели и проверка результата');
  const newTopic = pack.topics.find(topic => topic.name === 'Работа команды');
  expect(term.topicIds).toEqual([newTopic.id]);
  expect(pack.links).not.toContainEqual(expect.objectContaining({ from: oldTopic.id, to: term.id, relation: 'содержит термин' }));
  assertPackageCoherent(pack);
});

test('правка определения и выбранный этап сохраняются после перезагрузки', async ({ page }) => {
  await prepare(page);
  const row = termRow(page, 'Цель проекта');
  await row.getByRole('button', { name: 'Изменить', exact: true }).click();
  const definition = 'Изменение для определённой группы людей, которое команда должна получить к заданному сроку.';
  await row.getByLabel('Как тьютор должен понимать термин', { exact: true }).fill(definition);
  await page.reload();
  await expect(reviewHeading(page)).toBeVisible();
  await expect(termRow(page, 'Цель проекта').getByText(definition, { exact: true })).toBeVisible();
  await finish(page);
  await page.reload();
  await expect(readyHeading(page)).toBeVisible();
  const pack = await downloadPackage(page);
  expect(pack.terms.find(term => term.name === 'Цель проекта').definition).toBe(definition);
  assertPackageCoherent(pack);
});

for (const [description, saved] of [
  ['оборванный JSON', '{"version":2,"stage":'],
  ['неверная структура', JSON.stringify({ version: 2, stage: 2, draft: { topics: [] } })],
  ['неизвестная версия', JSON.stringify({ version: 999, title: 'Старый черновик', stage: 2 })],
]) {
  test(`повреждённый черновик (${description}) безопасно открывает пустое занятие`, async ({ page }) => {
    await page.goto('/');
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: STORAGE, value: saved });
    await page.reload();
    await expect(mainHeading(page, 'Подготовьте занятие по вашей лекции')).toBeVisible();
    await expect(page.getByLabel('Текст лекции', { exact: true })).toHaveValue('');
    await expect(page.getByLabel(/^Название занятия/u)).toHaveValue('');
    await expect(nav(page).getByRole('button', { name: /Получите материалы/u })).toBeDisabled();
    await page.getByLabel('Текст лекции', { exact: true }).fill(LECTURE);
    await page.getByRole('button', { name: 'Подготовить содержание', exact: true }).click();
    await expect(reviewHeading(page)).toBeVisible();
    await finish(page);
    assertPackageCoherent(await downloadPackage(page));
  });
}

test('новое занятие: отмена сохраняет правки, подтверждение очищает их и после reload', async ({ page }) => {
  await prepare(page);
  await page.getByRole('button', { name: 'Новое занятие', exact: true }).click();
  const confirmation = notice(page, 'Начать новое занятие?');
  await expect(confirmation).toBeVisible();
  await page.getByRole('button', { name: 'Оставить текущий черновик', exact: true }).click();
  await expect(reviewHeading(page)).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /^Включить тему /u })).toHaveCount(3);
  await finish(page);
  expect((await downloadPackage(page)).title).toBe(TITLE);
  await page.getByRole('button', { name: 'Новое занятие', exact: true }).click();
  await page.getByRole('button', { name: 'Начать новое', exact: true }).click();
  await expect(mainHeading(page, 'Подготовьте занятие по вашей лекции')).toBeVisible();
  await expect(page.getByLabel('Текст лекции', { exact: true })).toHaveValue('');
  await expect(page.getByLabel(/^Название занятия/u)).toHaveValue('');
  await page.reload();
  await expect(page.getByLabel('Текст лекции', { exact: true })).toHaveValue('');
  await expect(nav(page).getByRole('button', { name: /Проверьте содержание/u })).toBeDisabled();
});

test('загрузка MD и отказ от неподдерживаемого файла сохраняют исходный текст', async ({ page }) => {
  await page.goto('/');
  const upload = page.getByLabel('Файл лекции', { exact: true });
  await upload.setInputFiles({ name: 'Учебная лекция.md', mimeType: 'text/markdown', buffer: Buffer.from(LECTURE) });
  await expect(page.getByLabel('Текст лекции', { exact: true })).toHaveValue(LECTURE);
  await expect(page.getByLabel(/^Название занятия/u)).toHaveValue('Учебная лекция');
  await upload.setInputFiles({ name: 'неподдерживаемый.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7') });
  await expect(notice(page, 'Нужно уточнение')).toContainText('Выберите файл TXT или MD размером до 130 КБ.');
  await expect(page.getByLabel('Текст лекции', { exact: true })).toHaveValue(LECTURE);
  await page.getByRole('button', { name: 'Подготовить содержание', exact: true }).click();
  await expect(reviewHeading(page)).toBeVisible();
  await finish(page);
  expect((await downloadPackage(page)).title).toBe('Учебная лекция');
});

test('русские названия элементов и управление клавиатурой', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(page).toHaveTitle('Практика — подготовка занятия');
  await expect(page.getByRole('progressbar', { name: 'Этап подготовки' })).toHaveAttribute('aria-valuetext', 'Шаг 1 из 3');
  for (const label of ['Загрузить файл', 'Подготовить содержание', 'Попробовать на готовом примере', 'Новое занятие']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
  const lecture = page.getByLabel('Текст лекции', { exact: true });
  await lecture.focus();
  await page.keyboard.insertText('Коротко');
  await page.getByRole('button', { name: 'Подготовить содержание', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(notice(page, 'Нужно уточнение')).toContainText('Добавьте от 45 до 32 000 знаков текста лекции.');
  await expect(lecture).toBeFocused();
  await lecture.fill(LECTURE);
  await page.getByRole('button', { name: 'Подготовить содержание', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(reviewHeading(page)).toBeFocused();
  const checkbox = page.getByRole('checkbox', { name: 'Включить термин Показатель', exact: true });
  await checkbox.focus();
  await page.keyboard.press('Space');
  await expect(checkbox).not.toBeChecked();
  await page.keyboard.press('Space');
  await expect(checkbox).toBeChecked();
  await page.getByRole('button', { name: 'Посмотреть результат', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(readyHeading(page)).toBeFocused();
  await page.getByRole('button', { name: 'Для подключения тьютора: граф, промпты и источники', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: 'Граф знаний', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Граф знаний', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Промпты', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Ведение занятия', exact: true })).toBeVisible();
});

test('предупреждения об ошибке и сбросе доступны без вложенных повторных объявлений', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Подготовить содержание', exact: true }).click();
  const error = notice(page, 'Нужно уточнение');
  await expect(error).toBeVisible();
  await expect(error).toContainText('Добавьте от 45 до 32 000 знаков текста лекции.');
  await expect(page.locator('[role="alert"] [role="alert"]')).toHaveCount(0);
  await expect(page.getByLabel('Текст лекции', { exact: true })).toBeFocused();

  await page.getByLabel('Текст лекции', { exact: true }).fill(LECTURE);
  await page.getByRole('button', { name: 'Новое занятие', exact: true }).click();
  const confirmation = notice(page, 'Начать новое занятие?');
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText('Текущий черновик и ваши правки будут удалены.');
  await expect(page.locator('[role="alert"] [role="alert"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Начать новое', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Оставить текущий черновик', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByLabel('Текст лекции', { exact: true })).toHaveValue(LECTURE);
});

for (const viewport of [
  { name: 'desktop 1440', width: 1440, height: 1000 },
  { name: 'medium 1024', width: 1024, height: 900 },
  { name: 'mobile 390', width: 390, height: 844 },
]) {
  test.describe(`технические материалы: ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    test('граф, источники и все три промпта читаются на ширину карточки', async ({ page }, testInfo) => {
      await prepare(page);
      await finish(page);
      const pack = await downloadPackage(page);
      const trigger = page.getByRole('button', { name: 'Для подключения тьютора: граф, промпты и источники', exact: true });
      const card = page.locator('section').filter({ has: trigger });
      await trigger.click();
      await card.scrollIntoViewIfNeeded();
      const downloads = page.getByRole('complementary').filter({
        has: page.getByRole('heading', { name: 'Сохраните результат', exact: true }),
      });
      await expect.poll(async () => {
        const [downloadsBox, cardBox] = await Promise.all([downloads.boundingBox(), card.boundingBox()]);
        return downloadsBox.y + downloadsBox.height - cardBox.y;
      }, { message: 'The download panel must stay above the technical card and never cover its content while scrolling' }).toBeLessThanOrEqual(1);
      await expectUsesAvailableWidth(card, page.getByRole('main'), 0.95);

      await page.getByRole('tab', { name: 'Граф знаний', exact: true }).click();
      const graph = page.getByRole('tabpanel', { name: 'Граф знаний', exact: true });
      await expectUsesAvailableWidth(graph, card, 0.85);
      const canvas = graph.getByRole('region', { name: 'Граф знаний: узлы и связи', exact: true });
      await expect(canvas.getByRole('button', { name: 'Тема: Цели и проверка результата', exact: true })).toBeVisible();
      await canvas.getByRole('button', { name: 'Термин: Показатель', exact: true }).click();
      await expectNodeEvidence(graph, pack.terms.find(term => term.name === 'Показатель'), pack);
      await expectNoHorizontalOverflow(page);
      await card.screenshot({ path: testInfo.outputPath(`graph-${viewport.width}.png`), animations: 'disabled' });

      await page.getByRole('tab', { name: 'Источники', exact: true }).click();
      const sources = page.getByRole('tabpanel', { name: 'Источники', exact: true });
      await expectUsesAvailableWidth(sources, card, 0.85);
      await expect(sources).toContainText('Источник — текст лекции, который вы добавили на первом шаге.');
      await expectNoHorizontalOverflow(page);

      await page.getByRole('tab', { name: 'Промпты', exact: true }).click();
      const prompts = page.getByRole('tabpanel', { name: 'Промпты', exact: true });
      await expectUsesAvailableWidth(prompts, card, 0.85);
      const instruction = prompts.getByRole('region', { name: 'Текст инструкции', exact: true });
      const choices = [
        ['Ведение занятия', 'tutor'],
        ['Оценка ответа', 'evaluator'],
        ['Обратная связь', 'feedback'],
      ];
      await expect(prompts.getByRole('button', { name: 'Ведение занятия', exact: true })).toHaveAttribute('aria-pressed', 'true');
      for (const [label, key] of choices) {
        await prompts.getByRole('button', { name: label, exact: true }).click();
        for (const [otherLabel] of choices) {
          await expect(prompts.getByRole('button', { name: otherLabel, exact: true })).toHaveAttribute('aria-pressed', String(otherLabel === label));
        }
        const [expectedInstruction, expectedCourse] = pack.prompts[key].split('\n\nДанные курса\n');
        await expect(instruction).toHaveText(expectedInstruction);
        await expectUsesAvailableWidth(instruction, prompts, 0.9);
        const typography = await elementMetrics(instruction);
        expect(typography.fontSize).toBeGreaterThanOrEqual(14);
        expect(typography.lineHeight / typography.fontSize).toBeGreaterThanOrEqual(1.5);

        const course = prompts.getByRole('region', { name: 'Данные курса', exact: true });
        if (!await course.isVisible()) await prompts.getByText('Данные курса в этом промпте', { exact: true }).click();
        await expect(course).toBeVisible();
        expect(JSON.parse(await course.innerText())).toEqual(JSON.parse(expectedCourse));
        const courseMetrics = await elementMetrics(course);
        expect(courseMetrics.scrollWidth, 'Course JSON must wrap within the readable panel').toBeLessThanOrEqual(courseMetrics.clientWidth + 1);
        await expectNoHorizontalOverflow(page);

        const pendingDownload = page.waitForEvent('download');
        await prompts.getByRole('button', { name: 'Скачать промпт', exact: true }).click();
        const download = await pendingDownload;
        expect(await download.failure()).toBeNull();
        expect(await readFile(await download.path(), 'utf8')).toBe(pack.prompts[key]);
      }
      await prompts.getByText('Данные курса в этом промпте', { exact: true }).click();
      await expect(prompts.getByRole('region', { name: 'Данные курса', exact: true })).toBeHidden();
      await card.screenshot({ path: testInfo.outputPath(`prompt-reader-${viewport.width}.png`), animations: 'disabled' });
    });
  });
}

test.describe('мобильный экран 390px', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('@smoke все три шага и развёрнутые промпты доступны без горизонтального переполнения', async ({ page }, testInfo) => {
    await inputLecture(page);
    await expectNoHorizontalOverflow(page);
    await page.getByRole('button', { name: 'Подготовить содержание', exact: true }).click();
    await expect(reviewHeading(page)).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const topic = topicRow(page, 'Цели и проверка результата');
    await topic.getByRole('button', { name: 'Изменить тему Цели и проверка результата', exact: true }).click();
    await expect(topic.getByLabel('Что важно понять слушателю', { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await finish(page);
    await expectNoHorizontalOverflow(page);
    await page.getByRole('button', { name: 'Для подключения тьютора: граф, промпты и источники', exact: true }).click();
    await page.getByRole('tab', { name: 'Промпты', exact: true }).click();
    await page.getByRole('button', { name: 'Ведение занятия', exact: true }).click();
    await expectNoHorizontalOverflow(page);
    assertPackageCoherent(await downloadPackage(page));
    await page.screenshot({ path: testInfo.outputPath('готовое-занятие-mobile-390.png'), fullPage: true, animations: 'disabled' });
  });
});

test('связь «содержит термин» между двумя терминами видна в графе и сохранена в JSON', async ({ page }) => {
  const text = `# Термины учебного курса
Глоссарий — это список понятий курса с согласованными определениями. Термин — это слово или словосочетание с определённым смыслом в предметной области. Глоссарий содержит термины и объясняет их значения. В вымышленной лекции такой список помогает участникам одинаково понимать обсуждаемые понятия.`;
  await prepare(page, { title: 'Понятия и определения', text });
  await expect(page.getByRole('checkbox', { name: 'Включить термин Глоссарий', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Включить термин Термин', exact: true })).toBeChecked();
  await expect.poll(() => page.evaluate(key => {
    const saved = JSON.parse(localStorage.getItem(key));
    return saved?.draft?.terms.some(term => term.name === 'Глоссарий');
  }, STORAGE)).toBe(true);

  // Exercise a valid saved graph accepted by the course contract. The same
  // relation label can describe topic membership or a genuine term-to-term edge.
  const semanticLink = await page.evaluate(key => {
    const saved = JSON.parse(localStorage.getItem(key));
    const glossary = saved.draft.terms.find(term => term.name === 'Глоссарий');
    const term = saved.draft.terms.find(term => term.name === 'Термин');
    const link = {
      from: glossary.id, to: term.id, relation: 'содержит термин',
      evidenceIds: [...glossary.evidenceIds],
    };
    saved.draft.links.push(link);
    localStorage.setItem(key, JSON.stringify(saved));
    return link;
  }, STORAGE);
  await page.reload();
  await expect(reviewHeading(page)).toBeVisible();
  await finish(page);
  const pack = await downloadPackage(page);
  expect(pack.links).toContainEqual(semanticLink);
  expect(pack.graph.edges).toContainEqual(semanticLink);
  assertPackageCoherent(pack, text);

  await page.getByRole('button', { name: 'Для подключения тьютора: граф, промпты и источники', exact: true }).click();
  const graph = page.getByRole('tabpanel', { name: 'Граф знаний', exact: true });
  const canvas = graph.getByRole('region', { name: 'Граф знаний: узлы и связи', exact: true });
  const drawnEdges = await canvas.locator('path[data-graph-edge]').evaluateAll(paths => paths.map(path => ({
    from: path.dataset.from, to: path.dataset.to, relation: path.dataset.relation,
  })));
  expect(drawnEdges).toContainEqual({ from: semanticLink.from, to: semanticLink.to, relation: semanticLink.relation });
  await expect(canvas.getByRole('img', { name: 'Глоссарий — содержит термин → Термин', exact: true })).toBeAttached();
  const semanticPath = canvas.locator(`path[data-graph-edge][data-from="${semanticLink.from}"][data-to="${semanticLink.to}"][data-relation="содержит термин"]`);
  await expect(semanticPath).toHaveCount(1);
  expect(await semanticPath.evaluate(path => {
    const style = getComputedStyle(path);
    return path.getTotalLength() > 0 && style.stroke !== 'none' && Number(style.opacity) > 0 && style.visibility !== 'hidden';
  }), 'The semantic relation must be a drawn, non-transparent SVG path').toBe(true);
  await canvas.getByRole('button', { name: 'Термин: Глоссарий', exact: true }).click();
  await expectNodeEvidence(graph, pack.terms.find(term => term.name === 'Глоссарий'), pack);
  await expect(graph.getByText('В лекции не найдены явные связи между понятиями.', { exact: false })).toHaveCount(0);
});

test('визуальный граф показывает все узлы и связи, определения и дословные цитаты лекции', async ({ page }) => {
  await prepare(page);
  await finish(page);
  const pack = await downloadPackage(page);
  await page.getByRole('button', { name: 'Для подключения тьютора: граф, промпты и источники', exact: true }).click();
  const graph = page.getByRole('tabpanel', { name: 'Граф знаний', exact: true });
  const canvas = graph.getByRole('region', { name: 'Граф знаний: узлы и связи', exact: true });
  await expect(canvas.getByRole('button', { name: /^(Термин|Тема): /u })).toHaveCount(pack.graph.nodes.length);
  const edges = canvas.locator('path[data-graph-edge]');
  await expect(edges).toHaveCount(pack.graph.edges.length);
  const rendered = await edges.evaluateAll(paths => paths.map(path => ({
    from: path.dataset.from, to: path.dataset.to, relation: path.dataset.relation,
  })));
  expect(rendered).toEqual(expect.arrayContaining(pack.graph.edges.map(({ from, to, relation }) => ({ from, to, relation }))));
  expect(await edges.evaluateAll(paths => paths.every(path => {
    const style = getComputedStyle(path);
    return path.getTotalLength() > 0 && /url\(#.+\)/u.test(path.getAttribute('marker-end') || '') &&
      style.stroke !== 'none' && Number(style.opacity) > 0 && style.visibility !== 'hidden';
  }))).toBe(true);

  for (const topic of pack.topics) {
    const button = canvas.getByRole('button', { name: 'Тема: ' + topic.name, exact: true });
    await expect(button).toHaveCount(1);
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expectNodeEvidence(graph, topic, pack);
  }
  for (const term of pack.terms) {
    const button = canvas.getByRole('button', { name: 'Термин: ' + term.name, exact: true });
    await expect(button).toHaveCount(1);
    await button.focus();
    await button.press('Enter');
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expectNodeEvidence(graph, term, pack);
  }

  await graph.getByLabel('Найти тему или термин', { exact: true }).fill('Показатель');
  await graph.getByRole('button', { name: 'Показать узел: Показатель', exact: true }).click();
  const measure = canvas.getByRole('button', { name: 'Термин: Показатель', exact: true });
  await expect(measure).toHaveAttribute('aria-pressed', 'true');
  await expectNodeEvidence(graph, pack.terms.find(term => term.name === 'Показатель'), pack);
  const inspector = graph.getByRole('region', { name: 'Сведения об узле', exact: true });
  await inspector.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => inspector.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const nextTopic = canvas.getByRole('button', { name: 'Тема: Работа команды', exact: true });
  await nextTopic.click();
  await expect(nextTopic).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => inspector.evaluate(element => element.scrollTop)).toBe(0);
  await expectNodeEvidence(graph, pack.topics.find(topic => topic.name === 'Работа команды'), pack);
  await expect(edges).toHaveCount(pack.graph.edges.length);

  const initialWidth = (await measure.boundingBox()).width;
  await graph.getByRole('button', { name: 'Увеличить граф', exact: true }).click();
  await expect.poll(async () => (await measure.boundingBox()).width).toBeGreaterThan(initialWidth);
  await graph.getByRole('button', { name: 'Масштаб 100%', exact: true }).click();
  await expect.poll(async () => Math.abs((await measure.boundingBox()).width - initialWidth)).toBeLessThanOrEqual(1);
  await expectNoHorizontalOverflow(page);
});

test('копирование передаёт точный текст инструкции и JSON выбранного промпта', async ({ page }) => {
  await installClipboardProbe(page, 'success');
  const { pack, prompts } = await preparePrompts(page);
  const expectedWrites = [];
  for (const [label, key] of [['Ведение занятия', 'tutor'], ['Оценка ответа', 'evaluator'], ['Обратная связь', 'feedback']]) {
    await prompts.getByRole('button', { name: label, exact: true }).click();
    await expect(prompts.getByRole('button', { name: 'Текст скопирован', exact: true })).toHaveCount(0);
    await expect(prompts.getByRole('button', { name: 'JSON скопирован', exact: true })).toHaveCount(0);
    const [instruction, context] = pack.prompts[key].split('\n\nДанные курса\n');
    await prompts.getByRole('button', { name: 'Копировать текст', exact: true }).click();
    expectedWrites.push(instruction);
    await expect(prompts.getByRole('button', { name: 'Текст скопирован', exact: true })).toBeVisible();
    await prompts.getByText('Данные курса в этом промпте', { exact: true }).click();
    await prompts.getByRole('button', { name: 'Копировать JSON', exact: true }).click();
    expectedWrites.push(JSON.stringify(JSON.parse(context), null, 2));
    await expect(prompts.getByRole('button', { name: 'JSON скопирован', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__clipboardProbe.writes)).toEqual(expectedWrites);
    expect(await page.evaluate(() => window.__clipboardProbe.fallbacks)).toEqual([]);
  }
});

test('копирование использует резервный способ с точными данными после отказа Clipboard API', async ({ page }) => {
  await installClipboardProbe(page, 'fallback');
  const { pack, prompts } = await preparePrompts(page);
  const [instruction, context] = pack.prompts.tutor.split('\n\nДанные курса\n');
  const formattedContext = JSON.stringify(JSON.parse(context), null, 2);
  await prompts.getByRole('button', { name: 'Копировать текст', exact: true }).click();
  await expect(prompts.getByRole('button', { name: 'Текст скопирован', exact: true })).toBeVisible();
  await prompts.getByText('Данные курса в этом промпте', { exact: true }).click();
  await prompts.getByRole('button', { name: 'Копировать JSON', exact: true }).click();
  await expect(prompts.getByRole('button', { name: 'JSON скопирован', exact: true })).toBeVisible();
  const probe = await page.evaluate(() => window.__clipboardProbe);
  expect(probe.writes).toEqual([instruction, formattedContext]);
  expect(probe.fallbacks).toEqual([{ command: 'copy', text: instruction }, { command: 'copy', text: formattedContext }]);
  await expect(prompts.getByRole('textbox', { name: /^Текст для ручного копирования/u })).toHaveCount(0);
});

test('отказ обоих способов копирования показывает выделенный текст без ложного успеха', async ({ page }) => {
  await installClipboardProbe(page, 'denied');
  const { pack, prompts } = await preparePrompts(page);
  const [instruction, context] = pack.prompts.tutor.split('\n\nДанные курса\n');
  await prompts.getByText('Данные курса в этом промпте', { exact: true }).click();
  const expected = [
    ['Копировать текст', instruction],
    ['Копировать JSON', JSON.stringify(JSON.parse(context), null, 2)],
  ];
  for (const [label, text] of expected) {
    await prompts.getByRole('button', { name: label, exact: true }).click();
    const manual = prompts.getByRole('textbox', { name: 'Текст для ручного копирования — ' + label, exact: true });
    await expect(manual).toBeVisible();
    await expect(manual).toHaveValue(text);
    await expect(manual).toHaveAttribute('readonly', '');
    await expect(manual).toBeFocused();
    expect(await manual.evaluate(field => [field.selectionStart, field.selectionEnd])).toEqual([0, text.length]);
    await expect(prompts.getByRole('button', { name: label, exact: true })).toBeVisible();
    await expect(prompts.getByRole('button', { name: /^(Текст|JSON) скопирован$/u })).toHaveCount(0);
  }
  await expect(prompts.getByRole('status').filter({ hasText: 'Не удалось скопировать автоматически.' })).toHaveCount(2);
  const probe = await page.evaluate(() => window.__clipboardProbe);
  expect(probe.writes).toEqual(expected.map(([, text]) => text));
  expect(probe.fallbacks).toEqual(expected.map(([, text]) => ({ command: 'copy', text })));
  await prompts.getByRole('button', { name: 'Оценка ответа', exact: true }).click();
  await expect(prompts.getByRole('textbox', { name: /^Текст для ручного копирования/u })).toHaveCount(0);
  await expect(prompts.getByRole('button', { name: /^(Текст|JSON) скопирован$/u })).toHaveCount(0);
});

test('смена инструкции во время копирования не показывает устаревший успех и не переносит фокус', async ({ page }) => {
  await installClipboardProbe(page, 'deferred');
  const { pack, prompts } = await preparePrompts(page);
  await prompts.getByRole('button', { name: 'Копировать текст', exact: true }).click();
  await expect(prompts.getByRole('button', { name: 'Копируем…', exact: true })).toHaveAttribute('aria-disabled', 'true');
  const evaluator = prompts.getByRole('button', { name: 'Оценка ответа', exact: true });
  await evaluator.click();
  await page.evaluate(() => window.__resolveClipboardWrites.shift()());
  // Wait for the resolved operation and a rendered frame, without timing sleeps.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(evaluator).toBeFocused();
  await expect(prompts.getByRole('button', { name: 'Текст скопирован', exact: true })).toHaveCount(0);
  await expect(prompts.getByRole('button', { name: 'Копировать текст', exact: true })).toBeVisible();
  await expect(prompts.getByRole('textbox', { name: /^Текст для ручного копирования/u })).toHaveCount(0);

  await prompts.getByRole('button', { name: 'Копировать текст', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__clipboardProbe.writes.length)).toBe(2);
  await page.evaluate(() => window.__resolveClipboardWrites.shift()());
  await expect(prompts.getByRole('button', { name: 'Текст скопирован', exact: true })).toBeVisible();
  const probe = await page.evaluate(() => window.__clipboardProbe);
  expect(probe.writes).toEqual([pack.prompts.tutor, pack.prompts.evaluator].map(prompt => prompt.split('\n\nДанные курса\n')[0]));
  expect(probe.fallbacks).toEqual([]);
});
