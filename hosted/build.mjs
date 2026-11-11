import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(new URL('../ui/package.json',import.meta.url));
const {rolldown}=await import(pathToFileURL(require.resolve('rolldown')).href);
const manifest=JSON.parse(await readFile(path.join(root,'.openai/hosting.json'),'utf8'));
assert(manifest.project_id && manifest.d1==='DB' && !manifest.static,'Hosted build requires its Worker manifest and DB binding');
const original=await readFile(path.join(root,'dist/index.html'),'utf8');
assert(original.includes('</head>')&&!/<meta\s[^>]*name=["']praktika-api["']/i.test(original),'Use the current regular UI production build');
const html=original.replace('</head>','<meta name="praktika-api" content="same-origin"></head>');
const notices=await readFile(path.join(root,'ui/THIRD_PARTY_NOTICES.txt'),'utf8');
const temporary=await mkdtemp(path.join(tmpdir(),'praktika-worker-'));
try {
  const entry=path.join(temporary,'entry.mjs');
  await writeFile(entry,`import {createWorker} from ${JSON.stringify(path.join(root,'hosted/worker.mjs'))};\nexport default createWorker({html:${JSON.stringify(html)},notices:${JSON.stringify(notices)}});\n`);
  await mkdir(path.join(root,'dist/server'),{recursive:true});
  const bundle=await rolldown({input:entry,platform:'browser',external:[],treeshake:true});
  try{await bundle.write({file:path.join(root,'dist/server/index.js'),format:'esm',minify:true,sourcemap:false});}finally{await bundle.close();}
  await mkdir(path.join(root,'dist/.openai'),{recursive:true});
  await writeFile(path.join(root,'dist/.openai/hosting.json'),JSON.stringify(manifest,null,2)+'\n');
  const artifact=await readFile(path.join(root,'dist/server/index.js'),'utf8');
  assert(!/pza_[A-Za-z0-9]{20,}/.test(artifact),'A provider credential must never enter a build');
  assert(!/from\s+["']node:/.test(artifact),'Worker contains a Node dependency');
  console.log(JSON.stringify({workerBytes:Buffer.byteLength(artifact),sameOriginApi:true,databaseBinding:'DB'}));
} finally {await rm(temporary,{recursive:true,force:true});}
