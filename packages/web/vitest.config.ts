import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [svelte()],
  // Svelte 5 components need the browser build of the runtime under test.
  resolve: { conditions: ['browser'] },
  test: { environment: 'jsdom', include: ['test/**/*.test.ts'] },
});
