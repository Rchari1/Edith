import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Vault } from '@core/vault/vault.js';
import { SqliteSearchProvider } from '@core/vault/search.js';
import { BrainServer, findFreePort } from '@core/mcp/server.js';
import type { BrainEvent } from '@core/types.js';
import { tmpDir, rm } from './helpers.js';

/** Read the text payload out of an MCP tool result. */
function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
}

describe('BrainServer over real MCP', () => {
  let dir: string;
  let vault: Vault;
  let server: BrainServer;
  let client: Client;
  const events: BrainEvent[] = [];

  beforeAll(async () => {
    dir = tmpDir('sb-mcp-');
    vault = new Vault(dir, new SqliteSearchProvider(path.join(dir, 'index.db')));
    await vault.init();
    await vault.upsert({
      id: 'bm25-weighting',
      title: 'BM25 Weighting',
      body: 'Weight the title column higher than the body so exact title matches win.',
      links: ['sqlite-fts']
    });

    const port = await findFreePort(4700);
    server = new BrainServer(vault, { port });
    server.bus.onEvent((e) => events.push(e));
    await server.start();

    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url!)));
  });

  afterAll(async () => {
    await client.close();
    await server.stop();
    vault.close();
    rm(dir);
  });

  it('advertises all four brain tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'list_notes',
      'read_note',
      'save_note',
      'search_brain'
    ]);
  });

  it('search_brain returns hits and emits a considered event', async () => {
    events.length = 0;
    const res = await client.callTool({ name: 'search_brain', arguments: { query: 'weighting' } });
    expect(textOf(res)).toContain('bm25-weighting');

    const considered = events.find((e) => e.type === 'considered');
    expect(considered).toBeTruthy();
    expect(considered && 'noteIds' in considered && considered.noteIds).toContain('bm25-weighting');
  });

  it('read_note returns the body and emits an opened event', async () => {
    events.length = 0;
    const res = await client.callTool({ name: 'read_note', arguments: { id: 'bm25-weighting' } });
    expect(textOf(res)).toContain('Weight the title column higher');
    expect(events.some((e) => e.type === 'opened')).toBe(true);
  });

  it('read_note on a missing id fails gracefully', async () => {
    const res = await client.callTool({ name: 'read_note', arguments: { id: 'does-not-exist' } });
    expect(textOf(res)).toContain('no note "does-not-exist"');
  });

  it('read_note suggests near matches for a wrong id', async () => {
    const res = await client.callTool({ name: 'read_note', arguments: { id: 'bm25-weighting-typo' } });
    const out = textOf(res);
    expect(out).toContain('Did you mean');
    expect(out).toContain('bm25-weighting');
  });

  it('search with no matches does not error', async () => {
    const res = await client.callTool({ name: 'search_brain', arguments: { query: 'zzzznothing' } });
    const out = textOf(res);
    expect(out).toContain('no match for "zzzznothing"');
    expect(out).toContain('note(s)');
  });

  it('search results carry a relevance bar and the note\'s links', async () => {
    const res = await client.callTool({ name: 'search_brain', arguments: { query: 'weighting' } });
    const out = textOf(res);
    expect(out).toContain('EDITH');
    expect(out).toMatch(/[\u2593\u2591]{5}/);      // five-block relevance bar
    expect(out).toContain('\u2192 sqlite-fts');     // outbound links rendered
  });

  it('list_notes renders an origin legend', async () => {
    const res = await client.callTool({ name: 'list_notes', arguments: {} });
    const out = textOf(res);
    expect(out).toContain('saved by Claude');
    expect(out).toContain('distilled');
    expect(out).toContain('written by hand');
  });

  it('save_note distinguishes a new note from a deepened one', async () => {
    const first = await client.callTool({
      name: 'save_note',
      arguments: { id: 'deepen-me', title: 'Deepen Me', body: 'First half.' }
    });
    expect(textOf(first)).toContain('note saved');

    const second = await client.callTool({
      name: 'save_note',
      arguments: { id: 'deepen-me', title: 'Deepen Me', body: 'Second half.' }
    });
    expect(textOf(second)).toContain('note deepened');
    expect(vault.get('deepen-me')!.body).toContain('First half.');
  });

  it('save_note writes to the vault and emits a saved event', async () => {
    events.length = 0;
    const res = await client.callTool({
      name: 'save_note',
      arguments: {
        title: 'Stateless MCP Mode',
        body: 'A fresh server per POST avoids request-id collisions between concurrent sessions.',
        links: ['bm25-weighting']
      }
    });
    expect(textOf(res)).toContain('stateless-mcp-mode');
    expect(events.some((e) => e.type === 'saved')).toBe(true);

    const saved = vault.get('stateless-mcp-mode');
    expect(saved?.frontmatter.origin).toBe('claude');
    expect(saved?.frontmatter.links).toContain('bm25-weighting');
  });

  it('a note saved by Claude is immediately searchable', async () => {
    const res = await client.callTool({ name: 'search_brain', arguments: { query: 'collisions' } });
    expect(textOf(res)).toContain('stateless-mcp-mode');
  });

  it('list_notes reflects everything in the vault', async () => {
    const res = await client.callTool({ name: 'list_notes', arguments: {} });
    const out = textOf(res);
    expect(out).toContain('bm25-weighting');
    expect(out).toContain('stateless-mcp-mode');
  });

  it('serves a health endpoint for onboarding to verify against', async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}/health`);
    const body = (await r.json()) as { ok: boolean; notes: number };
    expect(body.ok).toBe(true);
    expect(body.notes).toBeGreaterThan(0);
  });

  it('handles concurrent tool calls from separate clients', async () => {
    const others = await Promise.all(
      [0, 1, 2].map(async () => {
        const c = new Client({ name: 'concurrent', version: '1.0.0' });
        await c.connect(new StreamableHTTPClientTransport(new URL(server.url!)));
        return c;
      })
    );
    const results = await Promise.all(
      others.map((c) => c.callTool({ name: 'search_brain', arguments: { query: 'weighting' } }))
    );
    for (const r of results) expect(textOf(r)).toContain('bm25-weighting');
    await Promise.all(others.map((c) => c.close()));
  });
});
