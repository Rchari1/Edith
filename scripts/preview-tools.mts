/** Render the MCP tool output so we can eyeball the formatting. */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Vault } from '../src/core/vault/vault.js';
import { SqliteSearchProvider } from '../src/core/vault/search.js';
import { BrainServer, findFreePort } from '../src/core/mcp/server.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-preview-'));
const vault = new Vault(dir, new SqliteSearchProvider(path.join(dir, 'index.db')));
await vault.init();

await vault.upsert({ id: 'electron-run-as-node-trap', title: 'Electron Run As Node Trap',
  body: 'The VS Code extension host exports ELECTRON_RUN_AS_NODE=1 and children inherit it, so Electron silently runs as plain Node and require("electron") returns a path string.',
  links: ['electron-esm-interop', 'mcp-registration'], origin: 'claude' });
await vault.upsert({ id: 'yaml-date-coercion', title: 'YAML Date Coercion',
  body: 'gray-matter parses an unquoted YAML date into a Date object, not a string, so a typeof check silently restamps every note with today.',
  links: ['electron-run-as-node-trap'], tags: ['yaml'], origin: 'distilled',
  source: { session: 'abc', project: '-Users-u-app', at: '2026-08-25T10:00:00Z' } });
await vault.upsert({ id: 'dynamic-port-binding', title: 'Dynamic Port Binding',
  body: 'Bind the next free port and rewrite the MCP config to match, so a taken port is never fatal.', origin: 'human' });

const server = new BrainServer(vault, { port: await findFreePort(4900) });
await server.start();
const client = new Client({ name: 'preview', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(server.url!)));

const show = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args });
  const t = ((r as { content: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('');
  console.log(`\n${'='.repeat(60)}\n${name}(${JSON.stringify(args)})\n${'='.repeat(60)}`);
  console.log(t);
};

await show('search_brain', { query: 'electron node date' });
await show('read_note', { id: 'yaml-date-coercion' });
await show('list_notes', {});
await show('save_note', { title: 'Tunnel Needed For Browser', body: 'claude.ai connects from Anthropic servers, so localhost is unreachable.', links: ['dynamic-port-binding'] });
await show('read_note', { id: 'electron-run-as-node' });

await client.close();
await server.stop();
vault.close();
fs.rmSync(dir, { recursive: true, force: true });
