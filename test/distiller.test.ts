import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { Vault } from '@core/vault/vault.js';
import { SqliteSearchProvider } from '@core/vault/search.js';
import { Distiller } from '@core/distiller/distiller.js';
import { DistillQueue } from '@core/distiller/queue.js';
import type { Session } from '@core/types.js';
import { tmpDir, rm } from './helpers.js';

function fakeSession(id = 'sess-1', turns = 8): Session {
  return {
    id,
    projectSlug: '-Users-u-proj',
    cwd: '/Users/u/proj',
    gitBranch: 'main',
    title: 'Test Session',
    startedAt: '2026-08-25T10:00:00.000Z',
    endedAt: '2026-08-25T11:00:00.000Z',
    turns: Array.from({ length: turns }, (_, i) => ({
      uuid: `u${i}`,
      parentUuid: i === 0 ? null : `u${i - 1}`,
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `turn ${i}`,
      toolsUsed: [],
      timestamp: '2026-08-25T10:00:00.000Z'
    })),
    subagents: [],
    sourcePath: '/tmp/x.jsonl',
    malformedLines: 0
  };
}

/** Minimal stand-in for the Anthropic client: only messages.parse is used. */
function clientReturning(concepts: unknown[], extra: Record<string, unknown> = {}) {
  const parse = vi.fn().mockResolvedValue({
    parsed_output: { concepts },
    usage: { input_tokens: 1200, output_tokens: 300 },
    stop_reason: 'end_turn',
    ...extra
  });
  return { client: { messages: { parse } } as unknown as Anthropic, parse };
}

describe('Distiller', () => {
  let dir: string;
  let vault: Vault;

  beforeEach(async () => {
    dir = tmpDir('sb-distill-');
    vault = new Vault(dir, new SqliteSearchProvider(path.join(dir, 'index.db')));
    await vault.init();
  });

  afterEach(() => {
    vault.close();
    rm(dir);
  });

  it('writes concepts as notes with provenance', async () => {
    const { client } = clientReturning([
      { id: 'esm-electron-interop', title: 'ESM Electron Interop', body: 'Why CJS main is safer.', links: ['electron'], tags: ['electron'] }
    ]);
    const result = await new Distiller(client, vault).distill(fakeSession());

    expect(result.skipped).toBe(false);
    expect(result.noteIds).toEqual(['esm-electron-interop']);

    const note = vault.get('esm-electron-interop')!;
    expect(note.frontmatter.origin).toBe('distilled');
    expect(note.frontmatter.sources[0]?.session).toBe('sess-1');
    expect(note.body).toContain('CJS main');
  });

  it('skips a session it has already distilled', async () => {
    const { client, parse } = clientReturning([{ id: 'a', title: 'A', body: 'b', links: [], tags: [] }]);
    const d = new Distiller(client, vault);
    await d.distill(fakeSession());
    const second = await d.distill(fakeSession());

    expect(second.skipped).toBe(true);
    expect(second.reason).toBe('already distilled');
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('does not spend a call on a trivially short session', async () => {
    const { client, parse } = clientReturning([]);
    const result = await new Distiller(client, vault, { minTurns: 6 }).distill(fakeSession('short', 3));
    expect(result.skipped).toBe(true);
    expect(parse).not.toHaveBeenCalled();
  });

  it('handles a session that taught nothing', async () => {
    const { client } = clientReturning([]);
    const result = await new Distiller(client, vault).distill(fakeSession());
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no durable concepts found');
    expect(vault.size()).toBe(0);
  });

  it('handles a refusal without writing anything', async () => {
    const { client } = clientReturning([{ id: 'x', title: 'X', body: 'y', links: [], tags: [] }], {
      stop_reason: 'refusal'
    });
    const result = await new Distiller(client, vault).distill(fakeSession());
    expect(result.skipped).toBe(true);
    expect(vault.size()).toBe(0);
  });

  it('passes existing note ids so the model can reuse them', async () => {
    await vault.upsert({ id: 'existing-idea', title: 'Existing Idea', body: 'prior' });
    const { client, parse } = clientReturning([]);
    await new Distiller(client, vault).distill(fakeSession());

    const prompt = parse.mock.calls[0]?.[0]?.messages?.[0]?.content as string;
    expect(prompt).toContain('existing-idea');
  });

  it('deepens an existing note when the model reuses its id', async () => {
    await vault.upsert({ id: 'shared', title: 'Shared', body: 'First pass.' });
    const { client } = clientReturning([
      { id: 'shared', title: 'Shared', body: 'Second pass.', links: [], tags: [] }
    ]);
    await new Distiller(client, vault).distill(fakeSession('sess-2'));

    const note = vault.get('shared')!;
    expect(note.body).toContain('First pass.');
    expect(note.body).toContain('Second pass.');
  });
});

describe('DistillQueue', () => {
  let dir: string;
  let vault: Vault;

  beforeEach(async () => {
    dir = tmpDir('sb-queue-');
    vault = new Vault(dir, new SqliteSearchProvider(path.join(dir, 'index.db')));
    await vault.init();
  });

  afterEach(() => {
    vault.close();
    rm(dir);
  });

  it('retries a transient failure and then succeeds', async () => {
    const parse = vi
      .fn()
      .mockRejectedValueOnce(new Error('503 overloaded'))
      .mockResolvedValue({
        parsed_output: { concepts: [{ id: 'ok', title: 'OK', body: 'made it', links: [], tags: [] }] },
        usage: {},
        stop_reason: 'end_turn'
      });
    const client = { messages: { parse } } as unknown as Anthropic;
    const queue = new DistillQueue(new Distiller(client, vault), { baseDelayMs: 5 });

    const done = new Promise((resolve) => queue.once('done', resolve));
    queue.enqueue(fakeSession('retry-me'));
    await done;

    expect(parse).toHaveBeenCalledTimes(2);
    expect(vault.get('ok')).not.toBeNull();
  });

  it('parks a permanently failing session instead of looping forever', async () => {
    const parse = vi.fn().mockRejectedValue(new Error('401 bad key'));
    const client = { messages: { parse } } as unknown as Anthropic;
    const queue = new DistillQueue(new Distiller(client, vault), { maxAttempts: 3, baseDelayMs: 5 });

    const failed = new Promise<{ attempts: number }>((resolve) => queue.once('failed', resolve));
    queue.enqueue(fakeSession('doomed'));
    const info = await failed;

    expect(info.attempts).toBe(3);
    expect(queue.stats().failed).toBe(1);
  });

  it('ignores a duplicate enqueue of the same session', async () => {
    const { client, parse } = clientReturning([]);
    const queue = new DistillQueue(new Distiller(client, vault), { baseDelayMs: 5 });
    const session = fakeSession('dupe');

    const done = new Promise((resolve) => queue.once('done', resolve));
    queue.enqueue(session);
    queue.enqueue(session);
    queue.enqueue(session);
    await done;

    expect(parse).toHaveBeenCalledTimes(1);
  });
});
