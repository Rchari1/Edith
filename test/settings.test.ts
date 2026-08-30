import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadSettings, saveSettings, mergeSettings, defaultSettings } from '../src/main/settings.js';
import { tmpDir, rm } from './helpers.js';

const dirs: string[] = [];
function dir(): string {
  const d = tmpDir('sb-settings-');
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rm(d);
});

describe('loadSettings', () => {
  it('keeps values that are the right type', async () => {
    const d = dir();
    const file = path.join(d, 'settings.json');
    await saveSettings(file, { ...defaultSettings(d), model: 'claude-sonnet-5', port: 5000 });
    const s = await loadSettings(file, d);
    expect(s.model).toBe('claude-sonnet-5');
    expect(s.port).toBe(5000);
  });

  it('falls back to the default when a field is the wrong type', async () => {
    // The failure this guards: a non-string vaultPath makes path.join throw
    // during startup, and the IPC handlers are registered after startup - so
    // the app opens with nothing behind it and no way to correct itself.
    const d = dir();
    const file = path.join(d, 'settings.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ vaultPath: 12345, port: 'nope', autoDistill: 'yes', minTurns: null, apiKey: [] })
    );
    const s = await loadSettings(file, d);
    const defaults = defaultSettings(d);
    expect(s.vaultPath).toBe(defaults.vaultPath);
    expect(s.port).toBe(defaults.port);
    expect(s.autoDistill).toBe(defaults.autoDistill);
    expect(s.minTurns).toBe(defaults.minTurns);
    expect(s.apiKey).toBe(defaults.apiKey);
    expect(typeof s.vaultPath).toBe('string');
  });

  it('treats an empty vault path as no vault path', async () => {
    const d = dir();
    const file = path.join(d, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ vaultPath: '   ' }));
    const s = await loadSettings(file, d);
    expect(s.vaultPath).toBe(defaultSettings(d).vaultPath);
  });

  it('survives a file that is not an object', async () => {
    const d = dir();
    for (const body of ['null', '[]', '"a string"', '{ not json', '']) {
      const file = path.join(d, `s-${Math.random()}.json`);
      fs.writeFileSync(file, body);
      const s = await loadSettings(file, d);
      expect(s).toEqual(defaultSettings(d));
    }
  });

  it('uses the defaults when there is no file at all', async () => {
    const d = dir();
    expect(await loadSettings(path.join(d, 'missing.json'), d)).toEqual(defaultSettings(d));
  });
});

describe('mergeSettings', () => {
  it('applies a well-formed patch', () => {
    const base = defaultSettings('/tmp/x');
    expect(mergeSettings(base, { minTurns: 9 }).minTurns).toBe(9);
  });

  it('ignores a field arriving with the wrong type', () => {
    const base = defaultSettings('/tmp/x');
    const out = mergeSettings(base, { vaultPath: 12345, minTurns: 'lots' });
    expect(out.vaultPath).toBe(base.vaultPath);
    expect(out.minTurns).toBe(base.minTurns);
  });

  it('does not let a patch empty the vault path', () => {
    const base = defaultSettings('/tmp/x');
    expect(mergeSettings(base, { vaultPath: '' }).vaultPath).toBe(base.vaultPath);
  });
});
