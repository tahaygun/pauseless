import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    rollupOptions: { input: { main: 'index.html', bench: 'bench.html' } },
  },
  worker: { format: 'es' },
});
