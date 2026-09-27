import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// One origin for the browser: the mission server on :8000 and the reflex on :8001.
// '/ws/reflex' must come before '/ws' (first matching prefix wins).
export default defineConfig({
  server: {
    proxy: {
      '/ws/reflex': { target: 'ws://127.0.0.1:8001', ws: true },
      '/reflex': { target: 'http://127.0.0.1:8001', rewrite: (p) => p.replace(/^\/reflex/, '') },
      '/api': 'http://127.0.0.1:8000',
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
    },
  },
  build: {
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        inspect: resolve(import.meta.dirname, 'inspect.html'),
        bench: resolve(import.meta.dirname, 'bench.html'),
        capture: resolve(import.meta.dirname, 'capture.html'),
        connectome: resolve(import.meta.dirname, 'connectome.html'),
        flyviz: resolve(import.meta.dirname, 'flyviz.html'),
      },
    },
  },
});
