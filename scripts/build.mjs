import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
await mkdir(path.join(out,'vendor'), { recursive: true });
for (const file of ['index.html','style.css','app.js','home.js','home.css','state.js','pairing.js','pairing.css','remote.js','remote.css','vendor/qrcode.js','vendor/QRCode-LICENSE','danmaku.js','danmaku.css','player.js','vendor/dplayer-1.27.1.min.js','vendor/DPlayer-LICENSE','favicon.svg','manifest.webmanifest','_headers','_routes.json','.assetsignore']) await copyFile(path.join(root,'src',file),path.join(out,file));
const modules=[];
for(const file of ['catalog-data.js','adapter.js','jev-session.js','title-match.js','catalog.js','danmaku-server.js','pairing-server.js','remote-server.js','sync-server.js','worker.js']){
  let code=(await readFile(path.join(root,'src',file),'utf8')).replace(/^import .*;\n/gm,'');
  if(file!=='worker.js')code=code.replace(/^export (?!class WatchHistory)/gm,'');
  modules.push(code);
}
await writeFile(path.join(out,'_worker.js'), modules.join('\n'));
console.log('Built Cloudflare Pages assets and streaming Worker in dist/.');

