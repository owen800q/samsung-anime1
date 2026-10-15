// Publish the TV app build for over-the-air updates: copies tv/dist into the Worker's
// assets as dist/tv-app/ (manifest.json and v/<build id>/). Installed apps check the
// manifest in the background and switch to a new build on their next launch.
// Run by the Worker build (wrangler.jsonc) after `vite build`.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeUpdate } from '../../ota/build.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const id = await writeUpdate({ dir: dist, html: readFileSync(join(dist, 'index.html'), 'utf8'), out: join(root, '..', 'dist') });
console.log(`TV app build ${id} published to dist/tv-app/.`);
