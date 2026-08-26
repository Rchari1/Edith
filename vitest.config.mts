import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@core': resolve('src/core') } },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
    /*
     * These are not unit tests. They start real chokidar watchers, bind real
     * TCP ports, and open real SQLite files. Run in parallel they contend for
     * FSEvents and CPU, which starves chokidar's write-stability polling and
     * intermittently times out the watcher tests - and it leaves a
     * check-then-bind race between files picking free ports.
     *
     * The whole suite runs in a few seconds, so serial files cost little and
     * remove an entire class of flake.
     */
    fileParallelism: false
  }
});
