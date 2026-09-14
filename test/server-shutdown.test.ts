import { describe, it, expect } from 'vitest';
import net from 'node:net';
import path from 'node:path';
import { Vault } from '@core/vault/vault.js';
import { SqliteSearchProvider } from '@core/vault/search.js';
import { BrainServer, findFreePort } from '@core/mcp/server.js';
import { tmpDir, rm } from './helpers.js';

describe('BrainServer shutdown', () => {
  it('stops promptly while a client is holding a connection open', async () => {
    const dir = tmpDir('sb-stop-');
    const vault = new Vault(dir, new SqliteSearchProvider(path.join(dir, 'index.db')));
    await vault.init();
    const server = new BrainServer(vault, { port: await findFreePort(4800) });
    await server.start();

    // A request that never finishes arriving keeps its connection active, and an
    // active connection is exactly what server.close() on its own waits for. The
    // app's quit waits on stop(), so this is the difference between quitting and
    // hanging with the single-instance lock held.
    const socket = net.connect(server.port!, '127.0.0.1');
    socket.on('error', () => {});
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write('POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n');
    await new Promise((r) => setTimeout(r, 100));

    const outcome = await Promise.race([
      server.stop().then(() => 'stopped'),
      new Promise((r) => setTimeout(() => r('still waiting'), 2000))
    ]);

    socket.destroy();
    vault.close();
    rm(dir);
    expect(outcome).toBe('stopped');
  }, 15000);
});
