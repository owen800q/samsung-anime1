// Assemble the Tizen widget from the Vite build and sign it when the Tizen CLI is
// available. Usage: npm run package [-- --profile <security-profile>]
// The widget starts through the over-the-air loader (../../ota): the build sits under
// app/, and newer builds are downloaded from the Worker's /tv-app/ in the background.
// TV_VERSION overrides the widget version (the release workflow sets it).
import { cpSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeWidget } from '../../ota/build.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const out = join(root, 'build');
const stage = join(out, 'widget');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = process.env.TV_VERSION || pkg.version;
const profileArg = process.argv.indexOf('--profile');
const profile = profileArg > 0 ? process.argv[profileArg + 1] : process.env.TIZEN_PROFILE;
// Updates come from the Worker the app talks to (same default as vite.config.js).
const origin = process.env.ANIME1_API || 'https://anime1.codeboxhk.com';

if (!existsSync(join(dist, 'index.html'))) throw new Error('dist/ is missing: run `npm run build` first');

rmSync(out, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const id = await writeWidget({
  dir: dist, html: readFileSync(join(dist, 'index.html'), 'utf8'), stage,
  key: 'anime1', origin, text: '已下載新版本，下次開啟時套用', updated: '已更新至新版本',
});
// Keep config.xml's version in step with package.json.
const config = readFileSync(join(root, 'tizen/config.xml'), 'utf8').replace(/(<widget[^>]*\sversion=")[^"]*"/, `$1${version}"`);
writeFileSync(join(stage, 'config.xml'), config);
cpSync(join(root, 'tizen/icon.png'), join(stage, 'icon.png'));

function hasTizen() {
  try { execFileSync('tizen', ['version'], { stdio: 'ignore' }); return true; } catch (_) { return false; }
}

if (hasTizen()) {
  const args = ['package', '-t', 'wgt', '-o', out];
  if (profile) args.push('-s', profile);
  args.push('--', stage);
  execFileSync('tizen', args, { stdio: 'inherit' });
  // The CLI names the file after <name>; sdb cannot transfer names with spaces.
  const built = readdirSync(out).find(f => f.endsWith('.wgt'));
  if (built !== 'Anime1TV.wgt') renameSync(join(out, built), join(out, 'Anime1TV.wgt'));
  console.log(`Signed widget: build/Anime1TV.wgt (v${version}, build ${id})`);
} else {
  // Unsigned archive for inspection or for signing later (`tizen package -t wgt -s <profile> -- build/widget`).
  const target = join(out, 'Anime1TV-unsigned.wgt');
  execFileSync('zip', ['-qr', target, '.'], { cwd: stage });
  console.log(`Tizen CLI not found. Unsigned widget: build/Anime1TV-unsigned.wgt (v${version}, build ${id})`);
  console.log('A TV only installs signed widgets — see README「打包与安装」.');
}
