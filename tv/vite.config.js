import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// The packaged TV app calls the deployed samsung-anime1 Worker directly (it runs from file://).
// Override with ANIME1_API=https://your-worker.example when building for another deployment.
const PRODUCTION_API = 'https://anime1.codeboxhk.com';
const TV_UA = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/6.0 TV Safari/537.36';

// Dev/preview: same-origin `/api` relayed to the Worker (ANIME1_DEV_API, default production),
// presenting the TV app's user agent so a desktop browser behaves like the TV.
function apiProxy() {
  const target = process.env.ANIME1_DEV_API || PRODUCTION_API;
  const strip = req => { req.removeHeader('origin'); req.removeHeader('referer'); req.setHeader('user-agent', TV_UA); };
  return {
    '/api': {
      target, changeOrigin: true, ws: true, secure: true,
      configure: proxy => { proxy.on('proxyReq', strip); proxy.on('proxyReqWs', strip); },
    },
  };
}

// Chromium 56 (Tizen 4.0) predates module scripts: ship one classic IIFE bundle.
function classicScript() {
  return {
    name: 'tv-classic-script',
    enforce: 'post',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(/<script type="module" crossorigin src=/g, '<script defer src=')
        .replace(/<link rel="stylesheet" crossorigin /g, '<link rel="stylesheet" ');
    },
  };
}

export default defineConfig(({ command }) => ({
  base: './',
  plugins: [classicScript()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // Empty in dev: requests stay on the dev server and go through the proxy above.
    __API_BASE__: JSON.stringify(process.env.ANIME1_API != null ? process.env.ANIME1_API : command === 'serve' ? '' : PRODUCTION_API),
  },
  esbuild: { jsxFactory: 'h', jsxFragment: 'Fragment', jsxInject: "import { h, Fragment } from 'preact'" },
  build: {
    target: 'chrome56',
    cssTarget: 'chrome56',
    modulePreload: false,
    assetsInlineLimit: 0,
    rollupOptions: { output: { format: 'iife', inlineDynamicImports: true } },
  },
  server: { host: true, port: 5181, proxy: apiProxy() },
  preview: { port: 4181, proxy: apiProxy() },
}));
