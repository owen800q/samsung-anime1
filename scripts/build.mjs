import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
await mkdir(out, { recursive: true });
for (const file of ['index.html','style.css','app.js','home.js','home.css','state.js','favicon.svg','_headers','_routes.json','.assetsignore']) await copyFile(path.join(root,'src',file),path.join(out,file));
const modules=[];
for(const file of ['catalog-data.js','adapter.js','catalog.js','sync-server.js','worker.js']){
  let code=(await readFile(path.join(root,'src',file),'utf8')).replace(/^import .*;\n/gm,'');
  if(file!=='worker.js')code=code.replace(/^export (?!class WatchHistory)/gm,'');
  modules.push(code);
}
await writeFile(path.join(out,'_worker.js'), modules.join('\n'));
console.log('Built Cloudflare Pages assets and streaming Worker in dist/.');
