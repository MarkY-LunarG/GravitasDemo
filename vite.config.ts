// Vite configuration for the browser target (index.html and src/browser.ts).
// The desktop target does not use Vite.

import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so that the build works from any folder on a web server.
  base: './',
  build: {
    outDir: 'dist-web',
    // WebGPU browsers support modern JavaScript.
    target: 'es2022',
  },
});
