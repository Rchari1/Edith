import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@core': resolve('src/core') } },
  test: { environment: 'node', include: ['test/**/*.test.ts'], testTimeout: 20000 }
});
