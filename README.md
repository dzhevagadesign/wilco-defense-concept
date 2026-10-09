# Wilco Defense — desktop concept

Live: https://dzhevagadesign.github.io/wilco-defense-concept/ (desktop; deployed from `main` by GitHub Actions)

Five-screen scroll concept with a real-time MQ-9 Reaper (three.js + Vite). The plane changes pose on every
screen, leans towards the cursor, and spins its propeller up while the screen changes.

```bash
npm install
npx vite --port 5370
```

- `/` — the site. `?step=3` opens a screen directly, `?overlay` lays the Figma mockup over the page.
- `/viewer.html` — orbit viewer with the same lighting and console diagnostics of the model.

Offline copy that opens by double-clicking `index.html` (no server, no internet):

```bash
npm run build:offline
```

It writes `dist-offline/`: one classic script instead of ES modules, the model as `model.js` (base64), fonts
self-hosted. Zip that folder to hand it over.

Tunables live at the top of `src/site.js` (poses, timings, cursor response) and `src/scene.js` (lighting,
paint grade, propeller).

## Credits

3D model: "MQ-9 Reaper" (https://sketchfab.com/3d-models/mq-9-reaper-eff549610fee4f20904f7b388a3a0830)
by Tyler V Howell (https://sketchfab.com/TVHowell), licensed under CC-BY-4.0
(http://creativecommons.org/licenses/by/4.0/). The runtime paint grade is applied in code; the file is unmodified.
