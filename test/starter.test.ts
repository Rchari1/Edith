import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Forge } from '@core/forge/forge.js';
import { seedStarterSkills } from '@core/forge/starter.js';
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
  let forge: Forge;

  beforeEach(async () => {
    vault = tmpDir('sb-starter-vault-');
    bundled = tmpDir('sb-starter-bundle-');
    forge = new Forge(vault);
    await forge.init();
    bundle(bundled, 'analyze-codebase', 'Analyze Codebase');
    bundle(bundled, 'review-a-pr', 'Review A PR');
    bundle(bundled, 'brainstorm', 'Brainstorm');
  });
  afterEach(() => { rm(vault); rm(bundled); });

  it('seeds the kit as proposals, not installed skills', async () => {
    const r = await seedStarterSkills(forge, bundled, vault);
    expect(r.seeded.sort()).toEqual(['analyze-codebase', 'brainstorm', 'review-a-pr']);
    expect(forge.counts().proposed).toBe(3);
    expect(forge.get('review-a-pr')?.status).toBe('proposed');
    expect(forge.get('review-a-pr')?.body).toBe('step one');
  });

  it('seeds each skill only once', async () => {
    await seedStarterSkills(forge, bundled, vault);
    const second = await seedStarterSkills(forge, bundled, vault);
    expect(second.seeded).toEqual([]);
    expect(second.skipped).toHaveLength(3);
    expect(forge.counts().proposed).toBe(3);
  });

  it('does not re-offer something the user rejected', async () => {
    await seedStarterSkills(forge, bundled, vault);
    await forge.setStatus('brainstorm', 'rejected');

    await seedStarterSkills(forge, bundled, vault);
    expect(forge.get('brainstorm')?.status).toBe('rejected');
    expect(forge.counts().proposed).toBe(2);
  });

  it('offers a newly added starter skill without re-offering answered ones', async () => {
    await seedStarterSkills(forge, bundled, vault);
    await forge.setStatus('brainstorm', 'rejected');

    bundle(bundled, 'capture-this-session', 'Capture This Session');
    const r = await seedStarterSkills(forge, bundled, vault);

    expect(r.seeded).toEqual(['capture-this-session']);
    expect(forge.get('brainstorm')?.status).toBe('rejected');
  });

  it('bypasses the pending cap, so a new queue is not full before any work', async () => {
    const small = new Forge(vault, 2);
    await small.init();
    const r = await seedStarterSkills(small, bundled, vault);
    expect(r.seeded).toHaveLength(3);
    expect(small.counts().proposed).toBe(3);
  });

  it('the cap still applies to Claude after seeding', async () => {
    const small = new Forge(vault, 2);
    await small.init();
    await seedStarterSkills(small, bundled, vault);

    const extra = await small.propose({ title: 'Extra', description: 'x', body: 'y' });
    expect(extra.proposal).toBeNull();
    expect(extra.reason).toMatch(/queue is full/i);
  });

  it('one malformed starter file does not stop the others', async () => {
    fs.writeFileSync(path.join(bundled, 'broken.md'), '---\n: : :\n---\nbody');
    const r = await seedStarterSkills(forge, bundled, vault);
    expect(r.seeded).toEqual(expect.arrayContaining(['analyze-codebase', 'review-a-pr']));
  });

  it('is a no-op when no bundle is present', async () => {
    const r = await seedStarterSkills(forge, path.join(bundled, 'nope'), vault);
    expect(r.seeded).toEqual([]);
    expect(forge.counts().proposed).toBe(0);
  });
});
