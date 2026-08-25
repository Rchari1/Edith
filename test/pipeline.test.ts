import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SessionWatcher } from '@core/watcher/index.js';
import { Vault } from '@core/vault/vault.js';
import { SqliteSearchProvider } from '@core/vault/search.js';
import { Distiller } from '@core/distiller/distiller.js';
import { BrainServer, findFreePort } from '@core/mcp/server.js';
import type { BrainEvent } from '@core/types.js';
import { tmpDir, rm, line, meta } from './helpers.js';

/**
 * Whole pipeline, end to end, with only the Anthropic call faked:
 * transcript on disk -> classify -> parse -> distill -> vault -> MCP -> lighting.
 */
describe('full pipeline', () => {
  let root: string;
  let vaultDir: string;
  let vault: Vault;
  let server: BrainServer;
  let client: Client;
  const events: BrainEvent[] = [];

  beforeAll(async () => {
    root = tmpDir('sb-projects-');
    vaultDir = tmpDir('sb-vault-');

    // A realistic project directory: one session, plus subagent noise and a memory dir.
    const project = path.join(root, '-Users-u-myapp');
    const sessionId = '11111111-2222-3333-4444-555555555555';
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(project, 'memory'), { recursive: true });
    fs.mkdirSync(path.join(project, sessionId, 'subagents', 'workflows', 'wf_a'), { recursive: true });

    fs.writeFileSync(
      path.join(project, `${sessionId}.jsonl`),
      [
        line({ uuid: 'a', parent: null, role: 'user', text: 'why is the port sometimes different?' }),
        line({ uuid: 'b', parent: 'a', role: 'assistant', text: 'because we bind the next free one', tools: ['Bash'] }),
        line({ uuid: 'c', parent: 'b', role: 'user', text: 'and the config follows it?' }),
        line({ uuid: 'd', parent: 'c', role: 'assistant', text: 'yes, we rewrite the config to match' }),
        line({ uuid: 'e', parent: 'd', role: 'user', text: 'good' }),
        line({ uuid: 'f', parent: 'e', role: 'assistant', text: 'done' }),
        meta('ai-title', { aiTitle: 'Port Binding' }),
        meta('last-prompt', { leafUuid: 'f' })
      ].join('\n')
    );

    // Noise that must NOT be treated as sessions.
    fs.writeFileSync(path.join(project, sessionId, 'subagents', 'workflows', 'wf_a', 'agent-x.jsonl'),
      line({ uuid: 's1', role: 'user', text: 'subagent chatter' }));
    fs.writeFileSync(path.join(project, sessionId, 'subagents', 'workflows', 'wf_a', 'journal.jsonl'), '{}');
    fs.writeFileSync(path.join(project, 'memory', 'MEMORY.md'), '- a memory');

    vault = new Vault(vaultDir, new SqliteSearchProvider(path.join(vaultDir, 'index.db')));
    await vault.init();

    const port = await findFreePort(4800);
    server = new BrainServer(vault, { port });
    server.bus.onEvent((e) => events.push(e));
    await server.start();

    client = new Client({ name: 'pipeline-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url!)));
  });

  afterAll(async () => {
    await client.close();
    await server.stop();
    vault.close();
    rm(root);
    rm(vaultDir);
  });

  it('finds exactly one session among the transcript files', async () => {
    const watcher = new SessionWatcher({ projectsRoot: root });
    const found = await watcher.scanExisting();
    expect(found).toHaveLength(1);
    expect(found[0]?.sessionId).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('parses the session and attaches its subagent transcript', async () => {
    const watcher = new SessionWatcher({ projectsRoot: root });
    const [entry] = await watcher.scanExisting();
    const session = await watcher.loadSession(entry!.file, entry!.projectSlug, entry!.sessionId);

    expect(session.title).toBe('Port Binding');
    expect(session.turns.length).toBeGreaterThanOrEqual(6);
    expect(session.subagents).toHaveLength(1);
    expect(session.subagents[0]?.turns[0]?.text).toBe('subagent chatter');
  });

  it('distills into the vault and becomes searchable over MCP', async () => {
    const watcher = new SessionWatcher({ projectsRoot: root });
    const [entry] = await watcher.scanExisting();
    const session = await watcher.loadSession(entry!.file, entry!.projectSlug, entry!.sessionId);

    const parse = vi.fn().mockResolvedValue({
      parsed_output: {
        concepts: [
          {
            id: 'dynamic-port-binding',
            title: 'Dynamic Port Binding',
            body: 'Bind the next free port and rewrite the MCP config to match, so a taken port is never fatal.',
            links: ['mcp-registration'],
            tags: ['networking']
          }
        ]
      },
      usage: { input_tokens: 900, output_tokens: 120 },
      stop_reason: 'end_turn'
    });
    const client_ = { messages: { parse } } as unknown as Anthropic;

    const result = await new Distiller(client_, vault).distill(session);
    expect(result.noteIds).toEqual(['dynamic-port-binding']);

    // The transcript reached the model.
    const prompt = parse.mock.calls[0]?.[0]?.messages?.[0]?.content as string;
    expect(prompt).toContain('next free one');

    events.length = 0;
    const res = await client.callTool({ name: 'search_brain', arguments: { query: 'port binding' } });
    const text = ((res as { content: Array<{ text?: string }> }).content ?? [])
      .map((c) => c.text ?? '')
      .join('');
    expect(text).toContain('dynamic-port-binding');

    // ...and the search lit the node up.
    const considered = events.find((e) => e.type === 'considered');
    expect(considered && 'noteIds' in considered && considered.noteIds).toContain('dynamic-port-binding');
  });

  it('records provenance pointing back at the real session', () => {
    const note = vault.get('dynamic-port-binding')!;
    expect(note.frontmatter.sources[0]?.session).toBe('11111111-2222-3333-4444-555555555555');
    expect(note.frontmatter.sources[0]?.project).toBe('-Users-u-myapp');
  });

  it('keeps a ghost node for the concept that does not exist yet', () => {
    const g = vault.graph();
    expect(g.nodes.find((n) => n.id === 'mcp-registration')?.missing).toBe(true);
  });

  it('picks up a brand new session written while watching', async () => {
    const watcher = new SessionWatcher({ projectsRoot: root, settleMs: 300 });
    await watcher.start();

    const newId = '99999999-8888-7777-6666-555555555555';
    const settled = new Promise<{ id: string; turns: unknown[] }>((resolve) =>
      watcher.once('session-settled', resolve)
    );

    fs.writeFileSync(
      path.join(root, '-Users-u-myapp', `${newId}.jsonl`),
      [
        line({ uuid: 'n1', parent: null, role: 'user', text: 'a brand new question' }),
        line({ uuid: 'n2', parent: 'n1', role: 'assistant', text: 'a brand new answer' }),
        meta('last-prompt', { leafUuid: 'n2' })
      ].join('\n')
    );

    const session = await settled;
    expect(session.id).toBe(newId);
    expect(session.turns).toHaveLength(2);
    await watcher.stop();
  }, 15000);
});
