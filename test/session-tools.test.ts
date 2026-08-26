import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Vault } from '@core/vault/vault.js';
import { SqliteSearchProvider } from '@core/vault/search.js';
import { SessionWatcher } from '@core/watcher/index.js';
import { WatcherSessionSource } from '@core/sessions/source.js';
import { BrainServer, findFreePort } from '@core/mcp/server.js';
import { tmpDir, rm, line, meta } from './helpers.js';

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
}

const SESSION_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const SESSION_B = 'bbbbbbbb-1111-2222-3333-444444444444';

describe('session review tools', () => {
  let root: string;
  let vaultDir: string;
  let vault: Vault;
  let server: BrainServer;
  let client: Client;

  beforeAll(async () => {
    root = tmpDir('sb-sess-root-');
    vaultDir = tmpDir('sb-sess-vault-');
    const project = path.join(root, '-Users-u-app');
    fs.mkdirSync(project, { recursive: true });

    fs.writeFileSync(path.join(project, `${SESSION_A}.jsonl`), [
      line({ uuid: 'a1', parent: null, role: 'user', text: 'how should we rank search results?', ts: '2026-08-20T10:00:00.000Z' }),
      line({ uuid: 'a2', parent: 'a1', role: 'assistant', text: 'weight the title column above the body', ts: '2026-08-20T10:01:00.000Z' }),
      line({ uuid: 'a3', parent: 'a2', role: 'user', text: 'do that', ts: '2026-08-20T10:02:00.000Z' }),
      line({ uuid: 'a4', parent: 'a3', role: 'assistant', text: 'done', ts: '2026-08-20T10:03:00.000Z' }),
      meta('ai-title', { aiTitle: 'Search Ranking' }),
      meta('last-prompt', { leafUuid: 'a4' })
    ].join('\n'));

    fs.writeFileSync(path.join(project, `${SESSION_B}.jsonl`), [
      line({ uuid: 'b1', parent: null, role: 'user', text: 'unrelated later session', ts: '2026-08-24T10:00:00.000Z' }),
      line({ uuid: 'b2', parent: 'b1', role: 'assistant', text: 'ok', ts: '2026-08-24T10:01:00.000Z' }),
      meta('ai-title', { aiTitle: 'Later Work' }),
      meta('last-prompt', { leafUuid: 'b2' })
    ].join('\n'));

    vault = new Vault(vaultDir, new SqliteSearchProvider(path.join(vaultDir, 'index.db')));
    await vault.init();
    // Session A has already been captured; B has not.
    await vault.upsert({
      id: 'bm25-weighting',
      title: 'BM25 Weighting',
      body: 'Weight the title column above the body.',
      source: { session: SESSION_A, project: '-Users-u-app', at: '2026-08-20T10:00:00.000Z' }
    });

    const watcher = new SessionWatcher({ projectsRoot: root });
    server = new BrainServer(vault, { port: await findFreePort(4950) }, new WatcherSessionSource(watcher, vault));
    await server.start();

    client = new Client({ name: 'session-tools-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url!)));
  });

  afterAll(async () => {
    await client.close();
    await server.stop();
    vault.close();
    rm(root);
    rm(vaultDir);
  });

  it('advertises the session tools alongside the note tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'list_notes', 'list_sessions', 'read_note', 'read_session', 'save_note', 'search_brain'
    ]);
  });

  it('lists sessions newest first with their own titles', async () => {
    const out = textOf(await client.callTool({ name: 'list_sessions', arguments: {} }));
    expect(out).toContain('Later Work');
    expect(out).toContain('Search Ranking');
    expect(out.indexOf('Later Work')).toBeLessThan(out.indexOf('Search Ranking'));
  });

  it('marks which sessions are already captured', async () => {
    const out = textOf(await client.callTool({ name: 'list_sessions', arguments: {} }));
    expect(out).toContain('already captured');
    expect(out).toContain('1 not yet captured');
  });

  it('can return only the sessions not yet captured', async () => {
    const out = textOf(await client.callTool({ name: 'list_sessions', arguments: { unsaved_only: true } }));
    expect(out).toContain('Later Work');
    expect(out).not.toContain('Search Ranking');
  });

  it('reads a transcript with tool noise stripped', async () => {
    const out = textOf(await client.callTool({ name: 'read_session', arguments: { id: SESSION_A } }));
    expect(out).toContain('how should we rank search results?');
    expect(out).toContain('weight the title column above the body');
  });

  it('accepts an id prefix', async () => {
    const out = textOf(await client.callTool({ name: 'read_session', arguments: { id: SESSION_A.slice(0, 8) } }));
    expect(out).toContain('how should we rank search results?');
  });

  it('fails gracefully on an unknown session', async () => {
    const out = textOf(await client.callTool({ name: 'read_session', arguments: { id: 'nope' } }));
    expect(out).toContain('no session');
    expect(out).toContain('list_sessions');
  });

  it('omits the session tools entirely when no source is configured', async () => {
    const bare = new BrainServer(vault, { port: await findFreePort(4970) });
    await bare.start();
    const c = new Client({ name: 'bare', version: '1.0.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(bare.url!)));
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).not.toContain('list_sessions');
    expect(tools.map((t) => t.name)).toContain('search_brain');
    await c.close();
    await bare.stop();
  });
});
