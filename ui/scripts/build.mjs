import {spawnSync} from 'node:child_process';
import {copyFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const child=spawnSync(process.execPath,['node_modules/vite/bin/vite.js','build'],{cwd:root,stdio:'inherit'});
if(child.status!==0)process.exit(child.status||1);
await mkdir(new URL('../../dist/',import.meta.url),{recursive:true});
await copyFile(new URL('../../dist-v2/index.html',import.meta.url),new URL('../../dist/index.html',import.meta.url));
for(const folder of ['dist','dist-v2']) {
  await copyFile(new URL('../THIRD_PARTY_NOTICES.txt',import.meta.url),new URL(`../../${folder}/THIRD_PARTY_NOTICES.txt`,import.meta.url));
}
