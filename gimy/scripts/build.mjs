import {mkdir,copyFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.join(root,'dist');await mkdir(path.join(out,'vendor'),{recursive:true});
for(const file of await readdir(path.join(root,'src'))){if(/\.(?:html|css|svg)$/.test(file)||['app.js','home.js','state.js','pairing.js','remote.js','danmaku.js','player.js'].includes(file))await copyFile(path.join(root,'src',file),path.join(out,file));}
for(const file of await readdir(path.join(root,'src/vendor')))await copyFile(path.join(root,'src/vendor',file),path.join(out,'vendor',file));
await copyFile(path.join(root,'src/_headers'),path.join(out,'_headers'));
await copyFile(path.join(root,'node_modules/hls.js/dist/hls.light.min.js'),path.join(out,'vendor/hls.min.js'));
await copyFile(path.join(root,'node_modules/hls.js/LICENSE'),path.join(out,'vendor/Hls-LICENSE'));
console.log('Built Gimy TV assets. Worker modules are bundled by Wrangler.');
