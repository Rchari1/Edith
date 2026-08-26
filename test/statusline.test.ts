import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { installStatusLine, removeStatusLine, scriptPath, STATUSLINE_MARKER } from '@core/onboarding/statusline.js';
import { tmpDir, rm } from './helpers.js';

describe('status line installation', () => {
  let home: string;
  let settings: string;
  let source: string;

  beforeEach(() => {
    home = tmpDir('sb-sl-home-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    settings = path.join(home, '.claude', 'settings.json');
    const srcDir = tmpDir('sb-sl-src-');
    source = path.join(srcDir, 'edith-status');
    fs.writeFileSync(source, '#!/usr/bin/env python3\nprint("edith")\n');
  });
  afterEach(() => rm(home));

  it('installs the script and points settings at it', async () => {
    fs.writeFileSync(settings, JSON.stringify({ model: 'opus' }));
    const r = await installStatusLine(source, home);
    expect(r.status).toBe('installed');

    const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
    expect(after.model).toBe('opus');
    expect(after.statusLine.type).toBe('command');
    expect(after.statusLine.command).toContain(STATUSLINE_MARKER);
    expect(fs.existsSync(scriptPath(home))).toBe(true);
  });

  it('makes the installed script executable', async () => {
    await installStatusLine(source, home);
    expect(fs.statSync(scriptPath(home)).mode & 0o111).toBeGreaterThan(0);
  });

  it("refuses to clobber somebody else's status line", async () => {
    const theirs = { type: 'command', command: '~/.claude/my-own-bar.sh' };
    fs.writeFileSync(settings, JSON.stringify({ statusLine: theirs }));

    const r = await installStatusLine(source, home);
    expect(r.status).toBe('skipped');
    expect(r.detail).toMatch(/already configured/i);

    const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
    expect(after.statusLine).toEqual(theirs);
  });

  it('backs settings up before first modification', async () => {
    fs.writeFileSync(settings, JSON.stringify({ keep: true }));
    await installStatusLine(source, home);
    expect(JSON.parse(fs.readFileSync(`${settings}.edith-backup`, 'utf8'))).toEqual({ keep: true });
  });

  it('reports already-current on an unchanged rerun', async () => {
    await installStatusLine(source, home);
    expect((await installStatusLine(source, home)).status).toBe('already-current');
  });

  it('removes its own entry and the script', async () => {
    fs.writeFileSync(settings, JSON.stringify({ model: 'opus' }));
    await installStatusLine(source, home);
    await removeStatusLine(home);

    const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
    expect(after.statusLine).toBeUndefined();
    expect(after.model).toBe('opus');
    expect(fs.existsSync(scriptPath(home))).toBe(false);
  });

  it("will not remove a status line that is not ours", async () => {
    const theirs = { type: 'command', command: 'my-bar.sh' };
    fs.writeFileSync(settings, JSON.stringify({ statusLine: theirs }));
    const r = await removeStatusLine(home);
    expect(r.status).toBe('skipped');
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine).toEqual(theirs);
  });

  it('tolerates a corrupt settings file', async () => {
    fs.writeFileSync(settings, 'not json {{{');
    expect((await installStatusLine(source, home)).status).toBe('installed');
  });
});
