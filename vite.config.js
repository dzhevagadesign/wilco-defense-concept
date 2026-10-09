import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// GitHub Pages serves the repo under /wilco-defense-concept/; the deploy workflow sets PAGES_BASE.
export default defineConfig({
  base: process.env.PAGES_BASE || '/',
  build: {
    rollupOptions: {
      input: {
        site: resolve(import.meta.dirname, 'index.html'),
        viewer: resolve(import.meta.dirname, 'viewer.html'),
      },
    },
  },
});
