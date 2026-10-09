// Builds dist-offline/: the site as plain files that open by double-clicking index.html — no server,
// no internet. Run: npm run build:offline
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'vite';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'dist-offline');

await build({ root, mode: 'offline' });

// Vite always emits a module script tag; file:// only runs classic scripts. The bundle is an IIFE, so a
// deferred classic script behaves the same (runs after parsing, in order).
const htmlPath = resolve(out, 'index.html');
let html = readFileSync(htmlPath, 'utf8');
html = html.replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/, '<script defer src="$1"></script>');
html = html.replace(/ crossorigin(?=[ >])/g, '');
if (html.includes('type="module"')) throw new Error('module script left in index.html');
writeFileSync(htmlPath, html);

// fetch() can't read local files, so the model travels as a script that defines a base64 string.
const glb = readFileSync(resolve(root, 'public/models/mq-9_reaper.glb'));
writeFileSync(resolve(out, 'model.js'), `window.__WILCO_MODEL_B64="${glb.toString('base64')}";\n`);
rmSync(resolve(out, 'models/mq-9_reaper.glb')); // the copy from public/ is unused offline; keep the licence

writeFileSync(
  resolve(out, 'README.txt'),
  `Wilco Defense — offline concept

Open index.html in Chrome, Edge, Firefox or Safari (double-click). No internet or server needed.
Keep all files together: index.html, model.js and the assets/, fonts/, ui/, design/, models/ folders.

Scroll, arrow keys or swipe move between the five screens.
?step=3 after index.html opens a screen directly; ?overlay lays the Figma mockup over the page.

3D model: "MQ-9 Reaper" by Tyler V Howell (https://sketchfab.com/TVHowell), CC-BY-4.0 —
https://sketchfab.com/3d-models/mq-9-reaper-eff549610fee4f20904f7b388a3a0830
`,
);
console.log('dist-offline ready');
