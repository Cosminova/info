import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5178,
  },
  // Top-level await in main.js keeps the startup path linear; both esbuild and
  // rollup need an ES2022+ target to emit it.
  esbuild: { target: 'esnext' },
  build: {
    target: 'esnext',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        // index: the 3D solar system. sky: the same catalogues seen from a
        // point on Earth's surface.
        index: fileURLToPath(new URL('index.html', import.meta.url)),
        sky: fileURLToPath(new URL('sky.html', import.meta.url)),
      },
    },
  },
});
