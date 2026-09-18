import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const alias = { '@core': resolve('src/core') };

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts') } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/preload/index.ts') } } }
  },
  renderer: {
    resolve: { alias },
    root: resolve('src/renderer'),
    build: {
      // Ship assets as files, never as data: URIs. The renderer's CSP allows
      // images only from 'self', so an inlined logo would be blocked.
      assetsInlineLimit: 0,
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          mini: resolve('src/renderer/mini.html')
        }
      }
    }
  }
});
