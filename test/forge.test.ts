import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Forge } from '@core/forge/forge.js';
import { installProposal, uninstallProposal, renderSkill, FORGED_BY } from '@core/forge/install.js';
import { Vault } from '@core/vault/vault.js';
import { SqliteSearchProvider } from '@core/vault/search.js';
import { buildPrimer } from '@core/context/primer.js';
import { tmpDir, rm } from './helpers.js';

const draft = {
  title: 'Add An MCP Tool',
  description: 'Steps to add a new tool to the Edith MCP server.',
  body: '1. Register it in tools.ts\n2. Write the description\n3. Add a test',
  rationale: 'You have done this three times across two sessions.',
  sources: ['mcp-registration']
};

describe('Forge', () => {
  let dir: string;
  let forge: Forge;

  beforeEach(async () => {
    dir = tmpDir('sb-forge-');
    forge = new Forge(dir);
    await forge.init();
  });
  afterEach(() => rm(dir));

  it('queues a proposal without installing anything', async () => {
    const { proposal } = await forge.propose(draft);
    expect(proposal?.id).toBe('add-an-mcp-tool');
    expect(proposal?.status).toBe('proposed');
    expect(forge.counts()).toEqual({ proposed: 1, accepted: 0, rejected: 0 });
  });

  it('survives a reload from disk', async () => {
    await forge.propose(draft);
    const reopened = new Forge(dir);
    await reopened.init();
    expect(reopened.get('add-an-mcp-tool')?.rationale).toContain('three times');
  });

  it('does not re-queue something the user already rejected', async () => {
    await forge.propose(draft);
    await forge.setStatus('add-an-mcp-tool', 'rejected');

    const second = await forge.propose(draft);
    expect(second.proposal).toBeNull();
    expect(second.reason).toMatch(/rejected/i);
    expect(forge.counts().proposed).toBe(0);
  });

  it('does not re-queue something already accepted', async () => {
    await forge.propose(draft);
    await forge.setStatus('add-an-mcp-tool', 'accepted', '/somewhere');
    const second = await forge.propose(draft);
    expect(second.proposal).toBeNull();
    expect(second.reason).toMatch(/accepted/i);
  });

  it('lets a better draft replace a pending one', async () => {
    await forge.propose(draft);
    await forge.propose({ ...draft, body: 'a much better body' });
    expect(forge.counts().proposed).toBe(1);
    expect(forge.get('add-an-mcp-tool')?.body).toBe('a much better body');
  });

  it('restores a decided proposal to the queue', async () => {
    await forge.propose(draft);
    await forge.setStatus('add-an-mcp-tool', 'accepted', '/x');
    await forge.restore('add-an-mcp-tool');

    const p = forge.get('add-an-mcp-tool')!;
    expect(p.status).toBe('proposed');
    expect(p.installedAt).toBeUndefined();
  });

  it('lists oldest first, so the queue is reviewed in order', async () => {
    await forge.propose({ ...draft, title: 'First' });
    await new Promise((r) => setTimeout(r, 5));
    await forge.propose({ ...draft, title: 'Second' });
    expect(forge.list('proposed').map((p) => p.title)).toEqual(['First', 'Second']);
  });

  it('ignores a malformed proposal rather than hiding the queue', async () => {
    await forge.propose(draft);
    fs.writeFileSync(path.join(forge.dir, 'broken.md'), '---\n: : :\n---\nbody');
    await forge.reload();
    expect(forge.get('add-an-mcp-tool')).not.toBeNull();
  });
});

describe('forge installation', () => {
  let home: string;
  let dir: string;
  let forge: Forge;

  beforeEach(async () => {
    home = tmpDir('sb-forge-home-');
    dir = tmpDir('sb-forge-vault-');
    forge = new Forge(dir);
    await forge.init();
  });
  afterEach(() => { rm(home); rm(dir); });

  it('writes a real SKILL.md that Claude Code would load', async () => {
    const { proposal } = await forge.propose(draft);
    const r = await installProposal(proposal!, home);
    expect(r.status).toBe('installed');

    const file = path.join(home, '.claude', 'skills', 'add-an-mcp-tool', 'SKILL.md');
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('name: add-an-mcp-tool');
    expect(content).toContain('Register it in tools.ts');
    expect(content).toContain(FORGED_BY);
  });

  it("refuses to overwrite a skill Edith did not create", async () => {
    const dirPath = path.join(home, '.claude', 'skills', 'add-an-mcp-tool');
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'SKILL.md'), '---\nname: mine\n---\nhand written');

    const { proposal } = await forge.propose(draft);
    const r = await installProposal(proposal!, home);

    expect(r.status).toBe('conflict');
    expect(fs.readFileSync(path.join(dirPath, 'SKILL.md'), 'utf8')).toContain('hand written');
  });

  it('replaces its own earlier version happily', async () => {
    const { proposal } = await forge.propose(draft);
    await installProposal(proposal!, home);
    const { proposal: v2 } = await forge.propose({ ...draft, body: 'updated steps' });
    // propose() refuses while pending only for decided states; this one is still proposed
    const r = await installProposal(v2 ?? proposal!, home);
    expect(r.status).toBe('installed');
  });

  it('uninstall removes only skills Edith forged', async () => {
    const { proposal } = await forge.propose(draft);
    await installProposal(proposal!, home);
    expect((await uninstallProposal('add-an-mcp-tool', home)).detail).toBe('removed');

    const dirPath = path.join(home, '.claude', 'skills', 'handmade');
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'SKILL.md'), 'mine');
    expect((await uninstallProposal('handmade', home)).status).toBe('conflict');
  });

  it('renders frontmatter Claude Code can parse', () => {
    const skill = renderSkill({
      id: 'x', title: 'X', description: 'multi\nline\ndesc', body: 'do it',
      rationale: '', sources: [], status: 'proposed', created: '2026-01-01'
    });
    // A newline inside the description would break the YAML frontmatter.
    expect(skill.split('\n').filter((l) => l.startsWith('description:'))).toHaveLength(1);
    expect(skill).not.toMatch(/description: multi\nline/);
  });
});

describe('discoverability', () => {
  it('the primer tells Claude that Edith forges skills', async () => {
    const dir = tmpDir('sb-primer-forge-');
    const vault = new Vault(dir, new SqliteSearchProvider(path.join(dir, 'index.db')));
    await vault.init();

    // Empty and populated primers both have to mention it: the failure mode was
    // Claude reaching for generic skill-authoring guidance because the primer
    // never said Edith could do this.
    expect(buildPrimer(vault)).toContain('propose_skill');
    await vault.upsert({ id: 'a', title: 'A', body: 'x' });
    const populated = buildPrimer(vault);
    expect(populated).toContain('propose_skill');
    expect(populated).toMatch(/names Edith directly/i);

    vault.close();
    rm(dir);
  });
});
