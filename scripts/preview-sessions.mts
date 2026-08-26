import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Vault } from '../src/core/vault/vault.js';
import { SqliteSearchProvider } from '../src/core/vault/search.js';
import { SessionWatcher } from '../src/core/watcher/index.js';
import { WatcherSessionSource } from '../src/core/sessions/source.js';
import { BrainServer, findFreePort } from '../src/core/mcp/server.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edith-sess-'));
const vault = new Vault(dir, new SqliteSearchProvider(path.join(dir, 'index.db')));
await vault.init();

const watcher = new SessionWatcher({ projectsRoot: path.join(os.homedir(), '.claude', 'projects') });
const server = new BrainServer(vault, { port: await findFreePort(4980) }, new WatcherSessionSource(watcher, vault));
await server.start();
const client = new Client({ name: 'preview', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(server.url!)));

const r = await client.callTool({ name: 'list_sessions', arguments: { limit: 6 } });
console.log(((r as { content: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join(''));

await client.close();
await server.stop();
vault.close();
fs.rmSync(dir, { recursive: true, force: true });
