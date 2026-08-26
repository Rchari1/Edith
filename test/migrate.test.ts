import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { migrateLegacyUserData } from '../src/main/migrate.js';
import { tmpDir, rm } from './helpers.js';

describe('migrateLegacyUserData', () => {
  let parent: string;
  let legacy: string;
  let current: string;

  beforeEach(() => {
    parent = tmpDir('sb-appdata-');
    legacy = path.join(parent, 'secondbrain');
    current = path.join(parent, 'edith');
    fs.mkdirSync(path.join(legacy, 'vault', 'notes'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'vault', 'notes', 'a.md'), '---\nid: a\n---\nkept');
    fs.writeFileSync(path.join(legacy, 'settings.json'), '{"model":"claude-opus-5"}');
  });

  afterEach(() => rm(parent));

  it('carries the vault and settings across after a rename', async () => {
    const r = await migrateLegacyUserData(current);
    expect(r.migrated).toBe(true);
    expect(r.items).toEqual(['vault', 'settings.json']);
    expect(fs.readFileSync(path.join(current, 'vault', 'notes', 'a.md'), 'utf8')).toContain('kept');
    expect(fs.readFileSync(path.join(current, 'settings.json'), 'utf8')).toContain('opus');
  });

  it('leaves the old directory intact so nothing is lost on a bad run', async () => {
    await migrateLegacyUserData(current);
    expect(fs.existsSync(path.join(legacy, 'vault', 'notes', 'a.md'))).toBe(true);
  });

  it('never overwrites data that already exists in the new location', async () => {
    fs.mkdirSync(path.join(current, 'vault', 'notes'), { recursive: true });
    fs.writeFileSync(path.join(current, 'vault', 'notes', 'a.md'), 'NEWER');

    const r = await migrateLegacyUserData(current);
    expect(fs.readFileSync(path.join(current, 'vault', 'notes', 'a.md'), 'utf8')).toBe('NEWER');
    expect(r.items).not.toContain('vault');
  });

  it('is a no-op on a fresh install', async () => {
    rm(legacy);
    const r = await migrateLegacyUserData(current);
    expect(r.migrated).toBe(false);
  });

  it('is safe to run twice', async () => {
    await migrateLegacyUserData(current);
    const second = await migrateLegacyUserData(current);
    expect(second.migrated).toBe(false);
  });
});
