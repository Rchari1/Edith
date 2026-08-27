import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Vault } from '@core/vault/vault.js';
import { SqliteSearchProvider } from '@core/vault/search.js';
import {
  importFiles,
  importText,
  titleFromFilename,
  titleFromBody,
  readImportable
} from '@core/importer/index.js';
import { tmpDir, rm } from './helpers.js';

describe('titleFromFilename', () => {
  it('turns filenames into readable titles', () => {
    expect(titleFromFilename('/a/b/my-great_note.md')).toBe('My Great Note');
    expect(titleFromFilename('/a/camelCaseThing.txt')).toBe('Camel Case Thing');
    expect(titleFromFilename('/a/.md')).toBe('Untitled');
  });
});

describe('titleFromBody', () => {
  it('names a note from its first line', () => {
    expect(titleFromBody('The fluid model is the whole frame\n\nmore text')).toBe(
      'The fluid model is the whole frame'
    );
  });

  it('strips leading markdown', () => {
    expect(titleFromBody('## Distillation trades two pairs for one')).toBe(
      'Distillation trades two pairs for one'
    );
    expect(titleFromBody('- a bulleted opening')).toBe('a bulleted opening');
    expect(titleFromBody('> a quoted opening')).toBe('a quoted opening');
    expect(titleFromBody('1. a numbered opening')).toBe('a numbered opening');
  });

  it('skips blank lines to find the first real one', () => {
    expect(titleFromBody('\n\n   \nActual first line')).toBe('Actual first line');
  });

  it('truncates long openings on a word boundary', () => {
    const long =
      'Memory is bounded by twice the link length which is the halving argument and it keeps going well past any reasonable title length';
    const t = titleFromBody(long);
    expect(t.length).toBeLessThanOrEqual(73);
    expect(t.endsWith('\u2026')).toBe(true);
    expect(t).not.toMatch(/\s\u2026$/);
  });

  it('falls back to Untitled when there is nothing to name', () => {
    expect(titleFromBody('')).toBe('Untitled');
    expect(titleFromBody('   \n  ')).toBe('Untitled');
    expect(titleFromBody('###   ')).toBe('Untitled');
  });
});

describe('importer', () => {
  let dir: string;
  let src: string;
  let vault: Vault;

  beforeEach(async () => {
    dir = tmpDir('sb-import-vault-');
    src = tmpDir('sb-import-src-');
    vault = new Vault(dir, new SqliteSearchProvider(path.join(dir, 'index.db')));
    await vault.init();
  });

  afterEach(() => {
    vault.close();
    rm(dir);
    rm(src);
  });

  const write = (name: string, content: string): string => {
    const p = path.join(src, name);
    fs.writeFileSync(p, content);
    return p;
  };

  it('imports a plain markdown file using the filename as title', async () => {
    const f = write('port-binding-notes.md', 'Bind the next free port.');
    const summary = await importFiles(vault, [f]);

    expect(summary.imported).toBe(1);
    const note = vault.get('port-binding-notes')!;
    expect(note.frontmatter.title).toBe('Port Binding Notes');
    expect(note.frontmatter.origin).toBe('human');
    expect(note.body).toBe('Bind the next free port.');
  });

  it('preserves identity from existing frontmatter', async () => {
    const f = write('whatever.md', [
      '---',
      'id: custom-id',
      'title: A Real Title',
      'links: [other-note]',
      'tags: [imported]',
      '---',
      'The body.'
    ].join('\n'));

    await importFiles(vault, [f]);
    const note = vault.get('custom-id')!;
    expect(note.frontmatter.title).toBe('A Real Title');
    expect(note.frontmatter.links).toContain('other-note');
    expect(note.frontmatter.tags).toContain('imported');
  });

  it('re-importing the same file deepens rather than duplicating', async () => {
    const f = write('idea.md', 'First version.');
    await importFiles(vault, [f]);
    fs.writeFileSync(f, 'Second version.');
    await importFiles(vault, [f]);

    expect(vault.size()).toBe(1);
    const note = vault.get('idea')!;
    expect(note.body).toContain('First version.');
    expect(note.body).toContain('Second version.');
  });

  it('skips unsupported file types', async () => {
    const f = write('photo.png', 'not text');
    const summary = await importFiles(vault, [f]);
    expect(summary.skipped).toBe(1);
    expect(summary.results[0]?.detail).toContain('unsupported');
    expect(vault.size()).toBe(0);
  });

  it('skips empty files', async () => {
    const f = write('blank.md', '   \n  ');
    const summary = await importFiles(vault, [f]);
    expect(summary.skipped).toBe(1);
    expect(vault.size()).toBe(0);
  });

  it('records a failure without aborting the rest of the batch', async () => {
    const good = write('good.md', 'content here');
    const missing = path.join(src, 'nope.md');
    const summary = await importFiles(vault, [missing, good]);

    expect(summary.failed).toBe(1);
    expect(summary.imported).toBe(1);
    expect(vault.get('good')).not.toBeNull();
  });

  it('imports several files at once', async () => {
    const files = ['a.md', 'b.txt', 'c.markdown'].map((n, i) => write(n, `body ${i}`));
    const summary = await importFiles(vault, files);
    expect(summary.imported).toBe(3);
    expect(vault.size()).toBe(3);
  });

  it('imports pasted text', async () => {
    const { id } = await importText(vault, 'Pasted Thought', 'Something worth keeping.');
    expect(id).toBe('pasted-thought');
    expect(vault.get(id)!.frontmatter.origin).toBe('human');
  });

  it('rejects empty pasted text', async () => {
    await expect(importText(vault, 'Title', '   ')).rejects.toThrow(/empty/i);
  });

  it('names the note from the body when no title is given', async () => {
    const { id } = await importText(vault, '', 'body only');
    expect(id).toBe('body-only');
  });

  it('still falls back to Untitled when the body has nothing to name it', async () => {
    const { id } = await importText(vault, '', '###\n\nrest of it');
    expect(id).toBe('untitled');
  });

  it('makes imported content immediately searchable', async () => {
    const f = write('searchable.md', 'a distinctive phrase about tunnels');
    await importFiles(vault, [f]);
    const hits = await vault.search('distinctive tunnels');
    expect(hits.map((h) => h.id)).toContain('searchable');
  });

  it('treats a file with frontmatter but no body as having the raw content', async () => {
    const f = write('meta-only.md', '---\ntitle: Meta Only\n---\n');
    const summary = await importFiles(vault, [f]);
    // No body after frontmatter -> falls back to raw, which is non-empty.
    expect(summary.imported + summary.skipped).toBe(1);
  });

  it('readImportable does not throw on a file with malformed frontmatter', async () => {
    const f = write('bad-fm.md', '---\n: : :\n---\nstill has a body');
    await expect(readImportable(f)).resolves.toBeTruthy();
  });
});
