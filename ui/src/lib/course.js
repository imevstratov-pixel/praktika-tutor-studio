import TutorEngine from './engine.mjs';

export const MAX_TEXT = 32000;
export const SAVE_VERSION = 2;
const MAX_SAVE = 1200000;
const normalize = value => value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru');
const hasText = value => typeof value === 'string' && Boolean(value.trim());
const isId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value);
const uniq = values => [...new Set(values)];
const record = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype || proto === null) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(d => !d.get && !d.set);
};

function requiredList(value) {
  const names = typeof value === 'string' ? value.split(/[,;\n]/u) : Array.isArray(value) ? value : [];
  const seen = new Set();
  return names.filter(hasText).map(name => name.trim()).filter(name => {
    const key = normalize(name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function validateDraft(draft, excludedIds = [], requiredNames = []) {
  const errors = [];
  const add = (id, field, message) => errors.push({ id, field, message });
  if (!record(draft) || !['topics', 'terms', 'excerpts', 'links'].every(key => Array.isArray(draft[key]))) {
    return [{ id: '', field: 'draft', message: 'Добавьте текст лекции и подготовьте черновик занятия.' }];
  }
  const excluded = new Set(Array.isArray(excludedIds) ? excludedIds : []);
  const topics = draft.topics.filter(node => record(node) && !excluded.has(node.id));
  const terms = draft.terms.filter(node => record(node) && !excluded.has(node.id));
  const allIds = new Set();
  for (const node of [...draft.excerpts, ...draft.topics, ...draft.terms]) {
    if (!record(node) || !isId(node.id) || allIds.has(node.id)) {
      add(typeof node?.id === 'string' ? node.id : '', 'id', 'В черновике повторяется или повреждён идентификатор. Подготовьте черновик заново.');
    } else allIds.add(node.id);
  }
  const fragments = new Map(draft.excerpts.filter(node => record(node) && hasText(node.text)).map(node => [node.id, node.text]));
  const activeTopics = new Set(topics.map(node => node.id));
  const selectedIds = new Set([...topics, ...terms].map(node => node.id));
  const knownNodeIds = new Set([...draft.topics, ...draft.terms].filter(record).map(node => node.id));
  if (!topics.length) add('', 'topics', 'Оставьте хотя бы одну тему занятия.');
  if (!terms.length) add('', 'terms', 'Добавьте хотя бы один термин и его определение.');

  function checkEvidence(node) {
    if (!Array.isArray(node.evidenceIds) || !node.evidenceIds.length ||
        node.evidenceIds.some(id => !fragments.has(id))) {
      add(node.id || '', 'evidenceIds', 'Выберите фрагмент лекции, который подтверждает формулировку.');
    }
  }
  const selectedNames = new Set();
  for (const topic of topics) {
    if (!hasText(topic.name)) add(topic.id, 'name', 'Укажите название темы.');
    else {
      const key = 'topic:' + normalize(topic.name);
      if (selectedNames.has(key)) add(topic.id, 'name', 'Такая тема уже включена в занятие.');
      selectedNames.add(key);
    }
    if (!hasText(topic.summary)) add(topic.id, 'summary', 'Запишите, что слушатель должен понять по этой теме.');
    checkEvidence(topic);
  }
  for (const term of terms) {
    if (!hasText(term.name)) add(term.id, 'name', 'Укажите название термина.');
    else {
      const key = 'term:' + normalize(term.name);
      if (selectedNames.has(key)) add(term.id, 'name', 'Такой термин уже включён в занятие.');
      selectedNames.add(key);
    }
    if (!hasText(term.definition)) add(term.id, 'definition', 'Уточните определение термина по лекции.');
    checkEvidence(term);
    if (!Array.isArray(term.topicIds) || !term.topicIds.some(id => activeTopics.has(id))) {
      add(term.id, 'topicIds', 'Выберите для термина тему, включённую в занятие.');
    }
  }
  for (const name of requiredList(requiredNames)) {
    if (!terms.some(term => hasText(term.name) && normalize(term.name) === normalize(name))) {
      const match = draft.terms.find(term => record(term) && hasText(term.name) && normalize(term.name) === normalize(name));
      add(match?.id || '', 'required', 'Включите обязательный термин «' + name + '».');
    }
  }
  for (const link of draft.links) {
    if (!record(link) || !knownNodeIds.has(link.from) || !knownNodeIds.has(link.to)) {
      add('', 'links', 'В одной из связей отсутствует тема или термин.');
      continue;
    }
    if (!selectedIds.has(link.from) || !selectedIds.has(link.to)) continue;
    if (link.from === link.to || !hasText(link.relation)) {
      add(link.from, 'links', 'Укажите отношение между двумя разными понятиями.');
    }
    checkEvidence({ ...link, id: link.from });
  }
  return errors;
}

function safeSources(value) {
  if (!Array.isArray(value) || value.length > 50) return null;
  const result = [];
  for (const source of value) {
    if (!record(source) || !hasText(source.name) || source.name.length > 300 ||
        typeof source.url !== 'string' || source.url.length > 2048 ||
        (source.detail !== undefined && (typeof source.detail !== 'string' || source.detail.length > 3000))) return null;
    try {
      const url = new URL(source.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    } catch { return null; }
    result.push({ name: source.name, url: source.url, detail: source.detail || '' });
  }
  return result;
}

export function createPackage(draft, excludedIds = [], sources = [], method = '', requiredNames = []) {
  const errors = validateDraft(draft, excludedIds, requiredNames);
  if (errors.length) {
    const error = new Error(errors[0].message);
    error.issues = errors;
    throw error;
  }
  const cleanSources = safeSources(sources);
  if (!cleanSources) throw new Error('Проверьте названия и адреса источников.');
  const excluded = new Set(excludedIds);
  const topics = draft.topics.filter(node => !excluded.has(node.id));
  const activeTopics = new Set(topics.map(node => node.id));
  const terms = draft.terms.filter(node => !excluded.has(node.id)).map(node => ({
    ...node, topicIds: uniq(node.topicIds.filter(id => activeTopics.has(id)))
  }));
  const selected = new Set([...topics, ...terms].map(node => node.id));
  // Membership edges follow the current topic selector, including edits after extraction.
  const termIds = new Set(terms.map(term => term.id));
  const links = draft.links.filter(link => selected.has(link.from) && selected.has(link.to) &&
    !(activeTopics.has(link.from) && termIds.has(link.to) && link.relation === 'содержит термин'))
    .map(link => ({ ...link, evidenceIds: [...link.evidenceIds] }));
  for (const term of terms) {
    for (const topicId of term.topicIds) {
      const existing = links.find(link => link.from === topicId && link.to === term.id && link.relation === 'содержит термин');
      if (existing) existing.evidenceIds = uniq([...existing.evidenceIds, ...term.evidenceIds]);
      else links.push({ from: topicId, to: term.id, relation: 'содержит термин', evidenceIds: [...term.evidenceIds] });
    }
  }
  const evidenceIds = new Set([...topics, ...terms, ...links].flatMap(node => node.evidenceIds));
  const pack = TutorEngine.compile({
    title: draft.title, topics, terms, links,
    excerpts: draft.excerpts.filter(fragment => evidenceIds.has(fragment.id))
  });
  pack.sources = cleanSources;
  pack.provenance = {
    method: typeof method === 'string' ? method.slice(0, 300) : '',
    reviewed: true,
    requiredTerms: requiredList(requiredNames)
  };
  return pack;
}

export function preview(draft, excludedIds = []) {
  const excluded = new Set(excludedIds);
  const topics = (draft?.topics || []).filter(node => record(node) && !excluded.has(node.id) && hasText(node.name));
  const fragments = new Set((draft?.excerpts || []).filter(node => record(node) && hasText(node.text)).map(node => node.id));
  const term = (draft?.terms || []).find(node => record(node) && !excluded.has(node.id) &&
    hasText(node.name) && hasText(node.definition) && Array.isArray(node.evidenceIds) &&
    node.evidenceIds.some(id => fragments.has(id)) && Array.isArray(node.topicIds) &&
    topics.some(topic => node.topicIds.includes(topic.id)));
  const title = hasText(draft?.title) ? draft.title.trim() : 'материал лекции';
  const greeting = 'Здравствуйте! Давайте закрепим ' + (hasText(draft?.title) ? 'тему «' + title + '».' : title + '.');
  if (!term) return { greeting, question: '', expected: '', sourceIds: [] };
  const topic = topics.find(node => term.topicIds.includes(node.id));
  return {
    greeting,
    question: 'Как вы объясните своими словами, что означает «' + term.name.trim() + '» в теме «' + topic.name.trim() + '»?',
    expected: term.definition.trim(),
    sourceIds: uniq(term.evidenceIds.filter(id => fragments.has(id)))
  };
}

function string(value, limit) {
  if (typeof value !== 'string' || value.length > limit) throw new Error('Invalid string');
  return value;
}
function array(value, limit) {
  if (!Array.isArray(value) || value.length > limit) throw new Error('Invalid array');
  return value;
}
function identifiers(value, limit) {
  const result = array(value, limit);
  if (!result.every(isId) || new Set(result).size !== result.length) throw new Error('Invalid references');
  return [...result];
}
function restoreDraft(input) {
  if (input === null) return null;
  if (!record(input)) throw new Error('Invalid draft');
  const ids = new Set();
  function identity(node) {
    if (!record(node) || !isId(node.id) || ids.has(node.id)) throw new Error('Invalid identifier');
    ids.add(node.id);
    return { id: node.id };
  }
  const excerpts = array(input.excerpts, 600).map(node => ({
    ...identity(node), text: string(node.text, MAX_TEXT)
  }));
  const topics = array(input.topics, 100).map(node => ({
    ...identity(node), name: string(node.name, 300), summary: string(node.summary, 5000),
    evidenceIds: identifiers(node.evidenceIds, 600)
  }));
  const terms = array(input.terms, 200).map(node => ({
    ...identity(node), name: string(node.name, 300), definition: string(node.definition, MAX_TEXT),
    evidenceIds: identifiers(node.evidenceIds, 600), topicIds: identifiers(node.topicIds, 100)
  }));
  const fragmentIds = new Set(excerpts.map(node => node.id));
  const topicIds = new Set(topics.map(node => node.id));
  const nodeIds = new Set([...topics, ...terms].map(node => node.id));
  const links = array(input.links, 1000).map(link => {
    if (!record(link) || !nodeIds.has(link.from) || !nodeIds.has(link.to) || link.from === link.to) throw new Error('Invalid link');
    return { from: link.from, to: link.to, relation: string(link.relation, 300), evidenceIds: identifiers(link.evidenceIds, 600) };
  });
  if ([...topics, ...terms, ...links].some(node => node.evidenceIds.some(id => !fragmentIds.has(id))) ||
      terms.some(node => node.topicIds.some(id => !topicIds.has(id)))) throw new Error('Invalid reference');
  return { title: string(input.title, 200), excerpts, topics, terms, links };
}

export function parseSaved(data) {
  try {
    if (typeof data === 'string') {
      if (data.length > MAX_SAVE) return null;
      data = JSON.parse(data);
    }
    if (!record(data) || data.version !== SAVE_VERSION) return null;
    const title = string(data.title, 200);
    const text = string(data.text, MAX_TEXT);
    const required = string(data.required, 600);
    const method = data.method === undefined ? '' : string(data.method, 300);
    const exampleId = data.exampleId === null ? null : string(data.exampleId, 100);
    const stage = data.stage;
    if (![0, 1, 2].includes(stage)) return null;
    const draft = restoreDraft(data.draft);
    // A restored draft must still quote the material it was prepared from.
    if (draft && draft.excerpts.some(fragment => !text.includes(fragment.text))) return null;
    const excluded = identifiers(data.excluded, 300);
    const nodeIds = new Set(draft ? [...draft.topics, ...draft.terms].map(node => node.id) : []);
    if (excluded.some(id => !nodeIds.has(id)) || (stage > 0 && !draft)) return null;
    if (draft && draft.title !== title) return null;
    const sources = safeSources(data.sources);
    if (!sources) return null;
    const safeStage = stage === 2 && validateDraft(draft, excluded, required).length ? 1 : stage;
    return { title, text, required, exampleId, draft, excluded, stage: safeStage, sources, method };
  } catch { return null; }
}

export function serializeSaved(state) {
  if (!record(state)) return null;
  const parsed = parseSaved({
    version: SAVE_VERSION, title: state.title, text: state.text, required: state.required,
    exampleId: state.exampleId ?? null, draft: state.draft ?? null, excluded: state.excluded,
    stage: state.stage, sources: state.sources, method: state.method
  });
  if (!parsed) return null;
  const serialized = JSON.stringify({ version: SAVE_VERSION, ...parsed });
  return serialized.length <= MAX_SAVE ? serialized : null;
}
