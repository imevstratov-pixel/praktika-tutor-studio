import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { Problem, config, readBounded, selectedModel, providerLabel, analyze } from './analysis.mjs';
export { excerptsFrom, validateGraph } from './analysis.mjs';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const LOCAL = '127.0.0.1';

const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8','.ico':'image/x-icon'};
function json(res,status,value) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(value));
}

export function makeServer(env) {
  const settings = config(env);
  let busy = false;
  const server = createServer(async(req,res) => {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"base-uri 'none'; frame-ancestors 'none'; object-src 'none'");
    try {
      const host = req.headers.host;
      const port = server.address().port;
      if (![LOCAL + ':' + port, 'localhost:' + port].includes(host)) throw new Problem(403,'Недопустимый адрес.');
      const origin = 'http://' + host;
      let pathname;
      try { pathname = decodeURIComponent(new URL(req.url, origin).pathname); } catch { throw new Problem(400,'Недопустимый адрес.'); }
      if (pathname === '/api/status' && req.method === 'GET') {
        const model = await selectedModel(settings).catch(()=>null);
        return json(res,200,{ai:Boolean(model),provider:providerLabel(settings,model)});
      }
      if (pathname === '/api/structure' && req.method === 'POST') {
        if (req.headers.origin !== origin) throw new Problem(403,'Запрос разрешён только из локальной студии.');
        if (!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type'] || '')) throw new Problem(415,'Ожидается JSON.');
        if (busy) throw new Problem(429,'Уже обрабатывается один текст. Дождитесь завершения.');
        busy = true;
        const cancellation = new AbortController();
        const cancel = () => {
          if (!res.writableEnded) cancellation.abort();
        };
        res.once('close', cancel);
        try {
          if (Number(req.headers['content-length'] || 0) > 200000) throw new Problem(413,'Текст слишком большой.');
          const body = await readBounded(req,200000,413);
          let input;
          try { input = JSON.parse(body); } catch { throw new Problem(400,'Некорректный JSON.'); }
          return json(res,200,await analyze(settings,input,cancellation.signal));
        } finally {
          res.removeListener('close', cancel);
          busy = false;
        }
      }
      if (!['GET','HEAD'].includes(req.method)) throw new Problem(405,'Метод не поддерживается.');
      if (pathname.startsWith('/api/') || pathname.includes('\0') || pathname.includes('\\')) throw new Problem(404,'Адрес не найден.');
      const root = await realpath(DIST);
      const target = await realpath(resolve(root,'.' + (pathname === '/' ? '/index.html' : pathname))).catch(()=>null);
      if (!target || !target.startsWith(root + sep) || !mime[extname(target)]) throw new Problem(404,'Файл не найден.');
      const data = await readFile(target);
      res.writeHead(200,{'Content-Type':mime[extname(target)],'Content-Length':data.length});
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (err) {
      if (!res.headersSent && !res.destroyed) json(res,err instanceof Problem ? err.status : 500,{error:err instanceof Problem ? err.message : 'Не удалось обработать запрос.'});
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return {server,settings};
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const {server,settings} = makeServer(process.env);
    server.once('error',err => {
      console.error(err.code === 'EADDRINUSE' ? 'Этот порт занят. Закройте предыдущую студию или задайте TUTOR_PORT.' : 'Не удалось запустить локальный сервер.');
      process.exitCode = 1;
    });
    server.listen(settings.port,LOCAL,() => {
      const page = 'http://' + LOCAL + ':' + settings.port;
      console.log('Студия открыта по адресу ' + page + '\nДля остановки нажмите Ctrl+C.');
      if (process.argv.includes('--open') && process.platform === 'darwin') spawn('/usr/bin/open',[page],{stdio:'ignore'}).on('error',()=>{});
    });
  } catch { console.error('Проверьте TUTOR_PROVIDER, TUTOR_MODEL, TUTOR_API_BASE, TUTOR_JSON_MODE и TUTOR_PORT (см. local/README.md).'); process.exitCode = 1; }
}
