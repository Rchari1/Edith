import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { registerAll, unregisterAll, detectTargets, SERVER_KEY, LEGACY_SERVER_KEYS } from '@core/onboarding/register.js';
import { tmpDir, rm } from './helpers.js';

describe('MCP registration', () => {
  let home: string;
  let claudeJson: string;

  beforeEach(() => {
    home = tmpDir('sb-home-');
    claudeJson = path.join(home, '.claude.json');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  });

  afterEach(() => rm(home));

  it('preserves unrelated user state in ~/.claude.json', async () => {
    const original = {
      numStartups: 42,
      userID: 'abc',
      projects: { '/some/path': { allowedTools: ['Bash'] } },
      mcpServers: { existingServer: { type: 'stdio', command: 'foo' } }
    };
    fs.writeFileSync(claudeJson, JSON.stringify(original, null, 2));

    await registerAll('http://127.0.0.1:4319/mcp', home);
    const after = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));

    expect(after.numStartups).toBe(42);
    expect(after.userID).toBe('abc');
    expect(after.projects).toEqual(original.projects);
    expect(after.mcpServers.existingServer).toEqual(original.mcpServers.existingServer);
    expect(after.mcpServers[SERVER_KEY]).toEqual({ type: 'http', url: 'http://127.0.0.1:4319/mcp' });
  });

  it('backs the file up before the first modification', async () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ keep: true }));
    await registerAll('http://127.0.0.1:4319/mcp', home);
    const backup = `${claudeJson}.edith-backup`;
    expect(fs.existsSync(backup)).toBe(true);
    expect(JSON.parse(fs.readFileSync(backup, 'utf8'))).toEqual({ keep: true });
  });

  it('reports already-current on an unchanged re-run', async () => {
    fs.writeFileSync(claudeJson, '{}');
    const url = 'http://127.0.0.1:4319/mcp';
    await registerAll(url, home);
    const second = await registerAll(url, home);
    expect(second.find((r) => r.target === 'Claude Code')?.status).toBe('already-current');
  });

  it('updates the entry when the port changes', async () => {
    fs.writeFileSync(claudeJson, '{}');
    await registerAll('http://127.0.0.1:4319/mcp', home);
    await registerAll('http://127.0.0.1:4400/mcp', home);
    const after = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    expect(after.mcpServers[SERVER_KEY].url).toBe('http://127.0.0.1:4400/mcp');
  });

  it('recovers from a corrupt config rather than crashing', async () => {
    fs.writeFileSync(claudeJson, 'not json at all {{{');
    const results = await registerAll('http://127.0.0.1:4319/mcp', home);
    expect(results.find((r) => r.target === 'Claude Code')?.status).toBe('registered');
    expect(JSON.parse(fs.readFileSync(claudeJson, 'utf8')).mcpServers[SERVER_KEY]).toBeTruthy();
  });

  it('removes the entry from a previous name so tools are not duplicated', async () => {
    // A pre-rename install left a 'secondbrain' entry pointing at the same port.
    fs.writeFileSync(
      claudeJson,
      JSON.stringify({
        mcpServers: {
          secondbrain: { type: 'http', url: 'http://127.0.0.1:4319/mcp' },
          unrelated: { type: 'stdio', command: 'keep-me' }
        }
      })
    );

    const results = await registerAll('http://127.0.0.1:4319/mcp', home);
    const after = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));

    expect(after.mcpServers[SERVER_KEY]).toEqual({ type: 'http', url: 'http://127.0.0.1:4319/mcp' });
    for (const stale of LEGACY_SERVER_KEYS) expect(after.mcpServers[stale]).toBeUndefined();
    expect(after.mcpServers.unrelated).toBeTruthy();
    expect(results.find((r) => r.target === 'Claude Code')?.detail).toContain('removed');
  });

  it('does not report already-current while a stale entry still needs removing', async () => {
    const url = 'http://127.0.0.1:4319/mcp';
    fs.writeFileSync(
      claudeJson,
      JSON.stringify({ mcpServers: { [SERVER_KEY]: { type: 'http', url }, secondbrain: { type: 'http', url } } })
    );
    const results = await registerAll(url, home);
    expect(results.find((r) => r.target === 'Claude Code')?.status).toBe('registered');
    const after = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    expect(after.mcpServers.secondbrain).toBeUndefined();
  });

  it('unregister also clears entries from previous names', async () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { secondbrain: { type: 'http' } } }));
    await unregisterAll(home);
    const after = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    expect(after.mcpServers.secondbrain).toBeUndefined();
  });

  it('skips surfaces that are not installed', async () => {
    const results = await registerAll('http://127.0.0.1:4319/mcp', home);
    expect(results.find((r) => r.target === 'Claude Desktop')?.status).toBe('skipped');
  });

  it('detects Claude Code from the data dir alone', async () => {
    const found = await detectTargets(home);
    expect(found.find((t) => t.name === 'Claude Code')?.present).toBe(true);
  });

  it('removes only its own entry on unregister', async () => {
    fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { other: { type: 'stdio' } } }));
    await registerAll('http://127.0.0.1:4319/mcp', home);
    await unregisterAll(home);
    const after = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    expect(after.mcpServers.other).toBeTruthy();
    expect(after.mcpServers[SERVER_KEY]).toBeUndefined();
  });
});
