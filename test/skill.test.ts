import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { installSkill, removeSkill, skillDir, SKILL_NAME } from '@core/onboarding/skill.js';
import { tmpDir, rm } from './helpers.js';

describe('/edith skill installation', () => {
  let home: string;
  let source: string;

  beforeEach(() => {
    home = tmpDir('sb-skill-home-');
    source = tmpDir('sb-skill-src-');
    fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: edith\n---\nbody');
    fs.writeFileSync(path.join(source, 'status'), '#!/usr/bin/env python3\nprint("ok")\n');
  });
  afterEach(() => { rm(home); rm(source); });

  it('installs into the personal skills folder', async () => {
    const r = await installSkill(source, home);
    expect(r.status).toBe('installed');
    expect(r.dir).toBe(path.join(home, '.claude', 'skills', SKILL_NAME));
    expect(fs.existsSync(path.join(r.dir, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(r.dir, 'status'))).toBe(true);
  });

  it('makes the status script executable', async () => {
    const r = await installSkill(source, home);
    expect(fs.statSync(path.join(r.dir, 'status')).mode & 0o111).toBeGreaterThan(0);
  });

  it('reports already-current when nothing changed', async () => {
    await installSkill(source, home);
    expect((await installSkill(source, home)).status).toBe('already-current');
  });

  it('overwrites an outdated copy on upgrade', async () => {
    await installSkill(source, home);
    fs.writeFileSync(path.join(source, 'status'), '#!/usr/bin/env python3\nprint("v2")\n');

    const r = await installSkill(source, home);
    expect(r.status).toBe('installed');
    expect(fs.readFileSync(path.join(skillDir(home), 'status'), 'utf8')).toContain('v2');
  });

  it('touches nothing outside its own directory', async () => {
    const settings = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ model: 'opus' }));

    await installSkill(source, home);
    expect(JSON.parse(fs.readFileSync(settings, 'utf8'))).toEqual({ model: 'opus' });
  });

  it('removes cleanly', async () => {
    await installSkill(source, home);
    await removeSkill(home);
    expect(fs.existsSync(skillDir(home))).toBe(false);
  });

  it('remove is safe when never installed', async () => {
    expect((await removeSkill(home)).status).toBe('installed');
  });
});
