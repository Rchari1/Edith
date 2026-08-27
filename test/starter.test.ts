import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Forge } from '@core/forge/forge.js';
import { seedStarterSkills } from '@core/forge/starter.js';
import { listInstalled, updateInstalled, deleteInstalled } from '@core/forge/installed.js';
import { tmpDir, rm } from './helpers.js';

function bundle(dir: string, id: string, title: string): void {
  fs.writeFileSync(
    path.join(dir, `${id}.md`),
    `---\nid: ${id}\ntitle: '${title}'\ndescription: 'does a thing'\nrationale: 'because'\n---\n\nstep one`
  );
}

describe('starter kit', () => {
  let vault: string;
  let bundled: string;
  let home: string;

  beforeEach(() => {
    vault = tmpDir('sb-starter-vault-');
    bundled = tmpDir('sb-starter-bundle-');
    home = tmpDir('sb-starter-home-');
    bundle(bundled, 'analyze-codebase', 'Analyze Codebase');
    bundle(bundled, 'review-a-pr', 'Review A PR');
    bundle(bundled, 'brainstorm', 'Brainstorm');
  });
  afterEach(() => { rm(vault); rm(bundled); rm(home); });

  it('installs the kit so Edith works on first open', async () => {
    const r = await seedStarterSkills(bundled, vault, home);
    expect(r.seeded.sort()).toEqual(['analyze-codebase', 'brainstorm', 'review-a-pr']);

    const installed = await listInstalled(home);
    expect(installed.map((s) => s.id).sort()).toEqual(['analyze-codebase', 'brainstorm', 'review-a-pr']);
    expect(installed[0]?.origin).toBe('starter');
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'review-a-pr', 'SKILL.md'))).toBe(true);
  });

  it('installs each skill only once', async () => {
    await seedStarterSkills(bundled, vault, home);
    const second = await seedStarterSkills(bundled, vault, home);
    expect(second.seeded).toEqual([]);
    expect(second.skipped).toHaveLength(3);
  });

  it('does not resurrect a starter skill the user deleted', async () => {
    await seedStarterSkills(bundled, vault, home);
    await deleteInstalled('brainstorm', home);

    await seedStarterSkills(bundled, vault, home);
    // Reinstalling something the user removed would make the delete a lie.
    expect((await listInstalled(home)).map((s) => s.id)).not.toContain('brainstorm');
  });

  it('installs a newly added starter skill without resurrecting removed ones', async () => {
    await seedStarterSkills(bundled, vault, home);
    await deleteInstalled('brainstorm', home);

    bundle(bundled, 'capture-this-session', 'Capture This Session');
    const r = await seedStarterSkills(bundled, vault, home);

    expect(r.seeded).toEqual(['capture-this-session']);
    expect((await listInstalled(home)).map((s) => s.id)).not.toContain('brainstorm');
  });

  it("will not overwrite a skill the user wrote themselves", async () => {
    const dir = path.join(home, '.claude', 'skills', 'brainstorm');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: brainstorm\n---\nmine, hand written');

    const r = await seedStarterSkills(bundled, vault, home);
    expect(r.seeded).not.toContain('brainstorm');
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toContain('hand written');
  });

  it('one malformed starter file does not stop the others', async () => {
    fs.writeFileSync(path.join(bundled, 'broken.md'), '---\n: : :\n---\nbody');
    const r = await seedStarterSkills(bundled, vault, home);
    expect(r.seeded).toEqual(expect.arrayContaining(['analyze-codebase', 'review-a-pr']));
  });

  it('is a no-op when no bundle is present', async () => {
    const r = await seedStarterSkills(path.join(bundled, 'nope'), vault, home);
    expect(r.seeded).toEqual([]);
    expect(await listInstalled(home)).toEqual([]);
  });
});

describe('installed skills', () => {
  let bundled: string;
  let vault: string;
  let home: string;

  beforeEach(async () => {
    bundled = tmpDir('sb-inst-bundle-');
    vault = tmpDir('sb-inst-vault-');
    home = tmpDir('sb-inst-home-');
    bundle(bundled, 'review-a-pr', 'Review A PR');
    await seedStarterSkills(bundled, vault, home);
  });
  afterEach(() => { rm(bundled); rm(vault); rm(home); });

  it('lists only skills Edith installed', async () => {
    const mine = path.join(home, '.claude', 'skills', 'my-own');
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, 'SKILL.md'), '---\nname: my-own\n---\nhand written');

    const listed = await listInstalled(home);
    // A delete button must never be offered for something the user wrote.
    expect(listed.map((s) => s.id)).toEqual(['review-a-pr']);
  });

  it('edits the body in place, keeping the skill loadable', async () => {
    const updated = await updateInstalled('review-a-pr', { body: 'new steps' }, home);
    expect(updated?.body).toBe('new steps');

    const raw = fs.readFileSync(path.join(home, '.claude', 'skills', 'review-a-pr', 'SKILL.md'), 'utf8');
    expect(raw).toContain('name: review-a-pr');
    expect(raw).toContain('new steps');
    expect(raw).toContain('edith-forge');
  });

  it('keeps a multi-line description on one line, so the frontmatter stays valid', async () => {
    await updateInstalled('review-a-pr', { description: 'line one\nline two' }, home);
    const raw = fs.readFileSync(path.join(home, '.claude', 'skills', 'review-a-pr', 'SKILL.md'), 'utf8');
    expect(raw.split('\n').filter((l) => l.startsWith('description:'))).toHaveLength(1);
  });

  it('deletes its own skills', async () => {
    expect((await deleteInstalled('review-a-pr', home)).ok).toBe(true);
    expect(await listInstalled(home)).toEqual([]);
  });

  it("refuses to delete a skill the user wrote", async () => {
    const mine = path.join(home, '.claude', 'skills', 'my-own');
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, 'SKILL.md'), 'hand written');

    const r = await deleteInstalled('my-own', home);
    expect(r.ok).toBe(false);
    expect(fs.existsSync(path.join(mine, 'SKILL.md'))).toBe(true);
  });
});

describe('starter kit respects the forge', () => {
  let bundled: string;
  let vault: string;
  let home: string;

  beforeEach(() => {
    bundled = tmpDir('sb-resp-bundle-');
    vault = tmpDir('sb-resp-vault-');
    home = tmpDir('sb-resp-home-');
    bundle(bundled, 'brainstorm', 'Brainstorm');
    bundle(bundled, 'review-a-pr', 'Review A PR');
  });
  afterEach(() => { rm(bundled); rm(vault); rm(home); });

  it('never installs a skill the user rejected in the deck', async () => {
    const forge = new Forge(vault);
    await forge.init();
    await forge.propose({ title: 'Brainstorm', description: 'x', body: 'y', id: 'brainstorm' });
    await forge.setStatus('brainstorm', 'rejected');

    const r = await seedStarterSkills(bundled, vault, home, forge);

    // Declining a proposal and finding it installed anyway would make the
    // review step decorative.
    expect(r.seeded).toEqual(['review-a-pr']);
    expect((await listInstalled(home)).map((s) => s.id)).not.toContain('brainstorm');
  });

  it('does not reconsider a rejected skill on later launches', async () => {
    const forge = new Forge(vault);
    await forge.init();
    await forge.propose({ title: 'Brainstorm', description: 'x', body: 'y', id: 'brainstorm' });
    await forge.setStatus('brainstorm', 'rejected');

    await seedStarterSkills(bundled, vault, home, forge);
    const second = await seedStarterSkills(bundled, vault, home, forge);
    expect(second.seeded).toEqual([]);
  });

  it('still installs an accepted or unseen skill normally', async () => {
    const forge = new Forge(vault);
    await forge.init();
    const r = await seedStarterSkills(bundled, vault, home, forge);
    expect(r.seeded.sort()).toEqual(['brainstorm', 'review-a-pr']);
  });
});
