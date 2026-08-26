import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Vault } from '@core/vault/vault.js';
import { SqliteSearchProvider } from '@core/vault/search.js';
import { buildPrimer, buildHookPayload } from '@core/context/primer.js';
import { registerSessionHook, unregisterSessionHook, HOOK_MARKER } from '@core/onboarding/hooks.js';
import { RetrievalStats } from '@core/mcp/stats.js';
import { tmpDir, rm } from './helpers.js';

describe('session primer', () => {
  let dir: string;
  let vault: Vault;

  beforeEach(async () => {
    dir = tmpDir('sb-primer-');
    vault = new Vault(dir, new SqliteSearchProvider(path.join(dir, 'index.db')));
    await vault.init();
  });
  afterEach(() => { vault.close(); rm(dir); });

  it('tells Claude to save when the brain is empty', () => {
    const p = buildPrimer(vault);
    expect(p).toContain('empty');
    expect(p).toContain('save_note');
  });

  it('names actual notes so Claude has something to match against', async () => {
    await vault.upsert({ id: 'sqlite-fts-ranking', title: 'SQLite FTS Ranking', body: 'bm25' });
    await vault.upsert({ id: 'port-binding', title: 'Port Binding', body: 'next free port' });

    const p = buildPrimer(vault);
    expect(p).toContain('sqlite-fts-ranking');
    expect(p).toContain('Port Binding');
    expect(p).toContain('2 notes');
    expect(p).toContain('search_brain');
  });

  it('says when NOT to search, not only when to', async () => {
    await vault.upsert({ id: 'a', title: 'A', body: 'x' });
    const p = buildPrimer(vault);
    // An earlier version pushed only one way and Claude searched on every message.
    expect(p).toMatch(/Do not search/i);
    expect(p).toContain('how are we doing');
    expect(p).toContain('Searching every message is as wrong as never searching.');
  });

  it('tells Claude results are reference rather than an agenda', async () => {
    await vault.upsert({ id: 'a', title: 'A', body: 'x' });
    const p = buildPrimer(vault);
    // The hijack bug: a note about a project was read as "resume that project".
    expect(p).toMatch(/not an agenda/i);
    expect(p).toContain('does not mean the user wants to resume that project');
    expect(p).toContain('never change what was asked');
  });

  it('does not tell Claude to mine sessions unprompted when empty', () => {
    const p = buildPrimer(vault);
    expect(p).toMatch(/Do not start that unprompted/i);
  });

  it('caps how many notes it names', async () => {
    for (let i = 0; i < 30; i++) await vault.upsert({ id: `note-${i}`, title: `Note ${i}`, body: 'x' });
    const p = buildPrimer(vault, { sample: 5 });
    expect(p).toContain('and 25 more');
  });

  it('carries no systemMessage, which SessionStart discards', () => {
    // The hooks reference lists SessionStart among events where "stdout is
    // used as context instead" - so a systemMessage here renders nowhere.
    const parsed = JSON.parse(buildHookPayload('PRIMER TEXT'));
    expect(parsed.hookSpecificOutput.additionalContext).toBe('PRIMER TEXT');
    expect(parsed.systemMessage).toBeUndefined();
  });

  it('emits the exact shape a SessionStart hook must return', () => {
    const parsed = JSON.parse(buildHookPayload(buildPrimer(vault)));
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(typeof parsed.hookSpecificOutput.additionalContext).toBe('string');
  });
});

describe('SessionStart hook registration', () => {
  let home: string;
  let settings: string;

  beforeEach(() => {
    home = tmpDir('sb-hook-home-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    settings = path.join(home, '.claude', 'settings.json');
  });
  afterEach(() => rm(home));

  it('adds the hook without disturbing other settings', async () => {
    fs.writeFileSync(settings, JSON.stringify({ model: 'opus', permissions: { allow: ['Bash'] } }));
    const r = await registerSessionHook('http://127.0.0.1:4319/context', home);
    expect(r.status).toBe('registered');

    const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
    expect(after.model).toBe('opus');
    expect(after.permissions.allow).toEqual(['Bash']);
    expect(after.hooks.SessionStart[0].hooks[0].command).toContain(HOOK_MARKER);
  });

  it('leaves somebody else\'s SessionStart hooks alone', async () => {
    fs.writeFileSync(settings, JSON.stringify({
      hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'other-tool init' }] }] }
    }));
    await registerSessionHook('http://127.0.0.1:4319/context', home);

    const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
    expect(after.hooks.SessionStart).toHaveLength(2);
    expect(JSON.stringify(after)).toContain('other-tool init');
  });

  it('backs the file up before first modification', async () => {
    fs.writeFileSync(settings, JSON.stringify({ keep: true }));
    await registerSessionHook('http://127.0.0.1:4319/context', home);
    expect(JSON.parse(fs.readFileSync(`${settings}.edith-backup`, 'utf8'))).toEqual({ keep: true });
  });

  it('reports already-current on an unchanged rerun', async () => {
    const url = 'http://127.0.0.1:4319/context';
    await registerSessionHook(url, home);
    expect((await registerSessionHook(url, home)).status).toBe('already-current');
  });

  it('replaces its own entry when the port changes, without duplicating', async () => {
    await registerSessionHook('http://127.0.0.1:4319/context', home);
    await registerSessionHook('http://127.0.0.1:4400/context', home);

    const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
    const ours = after.hooks.SessionStart.filter((e: { hooks: Array<{ command: string }> }) =>
      e.hooks.some((h) => h.command.includes(HOOK_MARKER))
    );
    expect(ours).toHaveLength(1);
    expect(JSON.stringify(ours)).toContain('4400');
  });

  it('tolerates a corrupt settings file', async () => {
    fs.writeFileSync(settings, 'not json {{{');
    const r = await registerSessionHook('http://127.0.0.1:4319/context', home);
    expect(r.status).toBe('registered');
  });

  it('removes only its own hook on unregister', async () => {
    fs.writeFileSync(settings, JSON.stringify({
      hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'other-tool init' }] }] }
    }));
    await registerSessionHook('http://127.0.0.1:4319/context', home);
    await unregisterSessionHook(home);

    const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
    expect(JSON.stringify(after)).toContain('other-tool init');
    expect(JSON.stringify(after)).not.toContain(HOOK_MARKER);
  });

  it('does not leave an empty hooks object behind', async () => {
    fs.writeFileSync(settings, JSON.stringify({ model: 'opus' }));
    await registerSessionHook('http://127.0.0.1:4319/context', home);
    await unregisterSessionHook(home);

    const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
    expect(after.hooks).toBeUndefined();
    expect(after.model).toBe('opus');
  });
});

describe('RetrievalStats', () => {
  it('reports coverage across sessions', () => {
    const s = new RetrievalStats();
    s.record({ type: 'session-active', sessionId: 'aaa', project: 'p', at: 1000 });
    s.record({ type: 'considered', noteIds: ['n1'], query: 'x', at: 1100 });
    s.record({ type: 'session-active', sessionId: 'bbb', project: 'p', at: 2000 });
    // bbb never touches the brain

    const r = s.report();
    expect(r.sessionsSeen).toBe(2);
    expect(r.sessionsThatUsedBrain).toBe(1);
    expect(r.coverage).toBe('1/2 (50%)');
    expect(r.totals.searches).toBe(1);
  });

  it('attributes a call to the session that was active', () => {
    const s = new RetrievalStats();
    s.record({ type: 'session-active', sessionId: 'aaa', project: 'p', at: 1000 });
    s.record({ type: 'session-active', sessionId: 'bbb', project: 'p', at: 2000 });
    s.record({ type: 'opened', noteIds: ['n'], at: 2100 });

    const per = s.report().perSession;
    expect(per.find((p) => p.session === 'bbb')?.reads).toBe(1);
    expect(per.find((p) => p.session === 'aaa')?.reads).toBe(0);
  });

  it('ignores calls with no recent session, rather than misattributing them', () => {
    const s = new RetrievalStats();
    s.record({ type: 'session-active', sessionId: 'aaa', project: 'p', at: 1000 });
    s.record({ type: 'considered', noteIds: [], query: 'x', at: 1000 + 60 * 60_000 });
    expect(s.report().totals.searches).toBe(0);
  });

  it('reports zero coverage cleanly with no sessions at all', () => {
    expect(new RetrievalStats().report().coverage).toBe('0/0 (0%)');
  });
});
