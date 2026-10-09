import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const page = (name) => resolve(import.meta.dirname, name);

export default defineConfig(({ mode }) => {
  // Offline build (scripts/build-offline.mjs): opened from disk via file://, so relative paths and one classic
  // (non-module) script — browsers refuse module scripts from file://. The viewer page is left out.
  if (mode === 'offline') {
    return {
      base: './',
      build: {
        outDir: 'dist-offline',
        modulePreload: false,
        cssCodeSplit: false, // one linked stylesheet; with IIFE output Vite would otherwise inline CSS into the JS
        rollupOptions: {
          input: page('index.html'),
          output: {
            format: 'iife',
            inlineDynamicImports: true,
            entryFileNames: 'assets/site.js',
            assetFileNames: 'assets/[name][extname]',
          },
        },
      },
    };
  }

  // GitHub Pages serves the repo under /wilco-defense-concept/; the deploy workflow sets PAGES_BASE.
  return {
    base: process.env.PAGES_BASE || '/',
    build: {
      rollupOptions: {
        input: { site: page('index.html'), viewer: page('viewer.html') },
      },
    },
  };
});
