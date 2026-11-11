import {config, analyze, Problem, readBounded} from '../local/analysis.mjs';

const LIMIT = 20;
const BODY_LIMIT = 200000;
const PROVIDER = 'Polza AI · Gemini 2.5 Flash';
const UNAVAILABLE = 'Модель недоступна';
const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
};
const unavailable = () => new Problem(503, 'Сервис ИИ временно недоступен. Попробуйте позже.');
const cancelled = signal => {
  if (signal.aborted) throw new Problem(499, 'Обработка отменена.');
};
function json(status, value) {
  return new Response(JSON.stringify(value), {status, headers:{...HEADERS, 'Content-Type':'application/json; charset=utf-8'}});
}
function settingsFor(env) {
  if (typeof env?.TUTOR_API_KEY !== 'string' || !env.TUTOR_API_KEY.trim() || typeof env?.DB?.prepare !== 'function') throw unavailable();
  // The public client and deployment variables cannot select another endpoint/model.
  return config({
    TUTOR_PROVIDER:'compatible', TUTOR_API_BASE:'https://polza.ai/api/v1/',
    TUTOR_MODEL:'google/gemini-2.5-flash', TUTOR_JSON_MODE:'schema',
    TUTOR_API_KEY:env.TUTOR_API_KEY.trim(),
  });
}
async function initialize(db) {
  // Schema creation belongs to migrations; no user material is stored here.
  await db.prepare('INSERT OR IGNORE INTO demo_budget (id, total_used) VALUES (1, 0)').run();
}
async function budget(db) {
  const row = await db.prepare('SELECT total_used FROM demo_budget WHERE id = 1').first();
  if (!row || !Number.isSafeInteger(row.total_used) || row.total_used < 0 || row.total_used > LIMIT) throw unavailable();
  return row;
}
async function reserve(db, token) {
  // One SQLite statement is the cross-instance admission decision. The lease is
  // longer than analysis.mjs's 180-second upstream deadline, using database time.
  const row = await db.prepare(`UPDATE demo_budget
    SET total_used = total_used + 1, lease_token = ?1, lease_expires_at = unixepoch() + 210
    WHERE id = 1 AND total_used < 20
      AND (lease_token IS NULL OR lease_expires_at <= unixepoch())
    RETURNING total_used`).bind(token).first();
  if (row) return;
  const current = await budget(db);
  throw new Problem(429, current.total_used >= LIMIT
    ? 'Общий лимит демо — 20 запусков ИИ — исчерпан.'
    : 'Сейчас уже обрабатывается один текст. Дождитесь завершения и попробуйте ещё раз.');
}
async function release(db, token) {
  await db.prepare(`UPDATE demo_budget SET lease_token = NULL, lease_expires_at = NULL
    WHERE id = 1 AND lease_token = ?1`).bind(token).run();
}

async function inputFrom(request) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > BODY_LIMIT)) throw new Problem(413, 'Текст слишком большой.');
  cancelled(request.signal);
  if (!request.body) throw new Problem(400, 'Некорректный JSON.');
  // Cancel a slow incoming stream as well as an upstream request. readBounded
  // remains the common UTF-8 decoder and byte-limit implementation.
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30000)]);
  const reader = request.body.getReader();
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(new Problem(request.signal.aborted ? 499 : 408,
      request.signal.aborted ? 'Обработка отменена.' : 'Не удалось дождаться текста. Попробуйте ещё раз.'));
    signal.addEventListener('abort', abort, {once:true});
  });
  async function* chunks() {
    try {
      while (true) {
        if (signal.aborted) {
          cancelled(request.signal);
          throw new Problem(408, 'Не удалось дождаться текста. Попробуйте ещё раз.');
        }
        const {value, done} = await Promise.race([reader.read(), stopped]);
        if (done) return;
        yield value;
      }
    } finally {
      signal.removeEventListener('abort', abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const raw = await readBounded(chunks(), BODY_LIMIT, 413);
  cancelled(request.signal);
  let input;
  try { input = JSON.parse(raw); } catch { throw new Problem(400, 'Некорректный JSON.'); }
  // These input guards mirror analyze(), so invalid requests never reserve a run.
  if (!input || typeof input.text !== 'string' || (input.title !== undefined && typeof input.title !== 'string')) throw new Problem(400, 'Нужны текст и строка заголовка.');
  if (input.text.length > 32000 || (input.title || '').length > 200) throw new Problem(413, 'Допустимо до 32 000 знаков текста и до 200 знаков в названии.');
  if (input.text.trim().length < 30) throw new Problem(422, 'Добавьте хотя бы 30 знаков учебного текста.');
  return {text:input.text, title:input.title};
}

export function createWorker({html, notices}) {
  if (typeof html !== 'string' || typeof notices !== 'string') throw new TypeError('Нужны HTML и текст лицензий.');
  return {
    async fetch(request, env) {
      try {
        const url = new URL(request.url);
        const path = url.pathname;
        if (path === '/api/status') {
          if (request.method !== 'GET') throw new Problem(405, 'Метод не поддерживается.');
          try {
            settingsFor(env);
            await initialize(env.DB);
            const row = await budget(env.DB);
            return json(200, {ai:true, provider:PROVIDER, remaining:LIMIT-row.total_used, limit:LIMIT});
          } catch {
            return json(200, {ai:false, provider:UNAVAILABLE, remaining:0, limit:LIMIT});
          }
        }
        if (path === '/api/structure') {
          if (request.method !== 'POST') throw new Problem(405, 'Метод не поддерживается.');
          // This prevents cross-site browser submissions; it is not authentication.
          if (request.headers.get('origin') !== url.origin) throw new Problem(403, 'Запрос разрешён только со страницы студии.');
          if (!/^application\/json(?:\s*;|$)/iu.test(request.headers.get('content-type') || '')) throw new Problem(415, 'Ожидается JSON.');
          const input = await inputFrom(request);
          const settings = settingsFor(env);
          await initialize(env.DB);
          cancelled(request.signal);
          const token = crypto.randomUUID();
          await reserve(env.DB, token);
          try {
            cancelled(request.signal);
            return json(200, await analyze(settings, input, request.signal));
          } finally {
            // Never refund: a cancelled/failed provider call can still be billed.
            // If cleanup fails the stored lease blocks further calls until expiry.
            await release(env.DB, token).catch(() => {});
          }
        }
        if (path === '/api' || path.startsWith('/api/')) throw new Problem(404, 'Адрес не найден.');
        if (!['GET', 'HEAD'].includes(request.method)) throw new Problem(405, 'Метод не поддерживается.');
        const content = path === '/' || path === '/index.html' ? {body:html, type:'text/html; charset=utf-8'}
          : path === '/THIRD_PARTY_NOTICES.txt' ? {body:notices, type:'text/plain; charset=utf-8'} : null;
        if (!content) throw new Problem(404, 'Файл не найден.');
        return new Response(request.method === 'HEAD' ? null : content.body, {headers:{...HEADERS, 'Content-Type':content.type}});
      } catch (error) {
        return json(error instanceof Problem ? error.status : 503,
          {error:error instanceof Problem ? error.message : 'Сервис временно недоступен. Попробуйте позже.'});
      }
    },
  };
}
