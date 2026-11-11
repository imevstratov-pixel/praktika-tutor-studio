import {spawnSync} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
async function discover(folder) {
  const found=[];
  for(const entry of await readdir(new URL('../'+folder+'/',import.meta.url),{withFileTypes:true})) {
    if(entry.isDirectory()) found.push(...await discover(folder+'/'+entry.name));
    else if(entry.isFile()&&entry.name.endsWith('.test.mjs'))found.push(folder+'/'+entry.name);
  }
  return found;
}
const files=(await discover('tests')).sort();
if(!files.length)throw Error('No unit tests discovered');
files.push('../local/server.test.mjs');
files.push('../hosted/worker.test.mjs');
const tap=process.argv.includes('--tap');
const child=spawnSync(process.execPath,['--test','--test-concurrency=1','--test-reporter='+ (tap?'tap':'spec'),...files],{cwd:root,stdio:'inherit'});
process.exitCode=child.status??1;
