import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        inspect: resolve(import.meta.dirname, 'inspect.html'),
        bench: resolve(import.meta.dirname, 'bench.html'),
      },
    },
  },
});
