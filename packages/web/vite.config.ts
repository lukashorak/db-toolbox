import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

const api = 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [svelte()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': api, '/mcp': api, '/healthz': api, '/readyz': api },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
});
