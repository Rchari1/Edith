import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { Vault } from '@core/vault/vault.js';
import { SqliteSearchProvider } from '@core/vault/search.js';
import { serializeNote, parseNote, slugify } from '@core/vault/note.js';
import { tmpDir, rm } from './helpers.js';

describe('slugify', () => {
  it('produces stable kebab ids', () => {
    expect(slugify('SQLite FTS5 Ranking!')).toBe('sqlite-fts5-ranking');
    expect(slugify('  --weird__input--  ')).toBe('weird-input');
    expect(slugify('')).toBe('untitled');
  });
});

describe('note serialization', () => {
  it('round-trips through disk format', () => {
    const note = {
      frontmatter: {
        id: 'a-note',
        title: "Claude's: tricky title",
        type: 'concept' as const,
        created: '2026-08-25',
        updated: '2026-08-25',
        sources: [{ session: 's1', project: 'p1', at: '2026-08-25T10:00:00Z' }],
        links: ['other-note'],
        origin: 'distilled' as const,
        tags: ['testing']
      },
      body: 'Body text.',
      path: '/tmp/a-note.md'
    };
    const round = parseNote(serializeNote(note), note.path, 'a-note');
    expect(round.frontmatter).toEqual(note.frontmatter);
    expect(round.body).toBe('Body text.');
  });

  it('preserves dates written on an earlier day', () => {
    // YAML turns an unquoted 2026-01-02 into a Date; if that is not coerced back
    // the note silently gets stamped with today's date on every reload.
    const raw = `---\nid: old\ntitle: Old Note\ncreated: 2026-01-02\nupdated: 2026-01-03\n---\nbody`;
    const n = parseNote(raw, '/tmp/old.md', 'old');
    expect(n.frontmatter.created).toBe('2026-01-02');
    expect(n.frontmatter.updated).toBe('2026-01-03');
  });

  it('survives a serialize/parse cycle without date drift', () => {
    const first = parseNote(`---\nid: d\ntitle: D\ncreated: 2025-06-01\nupdated: 2025-06-01\n---\nb`, '/tmp/d.md', 'd');
    const second = parseNote(serializeNote(first), '/tmp/d.md', 'd');
    expect(second.frontmatter.created).toBe('2025-06-01');
  });

  it('tolerates hand-edited frontmatter with wrong types', () => {
    const raw = `---\nid: x\ntitle: 123\nlinks: "not-a-list"\nsources: garbage\n---\nbody`;
    const n = parseNote(raw, '/tmp/x.md', 'x');
    expect(n.frontmatter.links).toEqual([]);
    expect(n.frontmatter.sources).toEqual([]);
    expect(n.frontmatter.origin).toBe('human');
  });
});

describe('Vault', () => {
  let dir: string;
  let vault: Vault;

  beforeEach(async () => {
    dir = tmpDir();
    vault = new Vault(dir, new SqliteSearchProvider(path.join(dir, 'index.db')));
    await vault.init();
  });

  afterEach(() => {
    vault.close();
    rm(dir);
  });

  it('writes a note to disk and finds it by search', async () => {
    await vault.upsert({ title: 'SQLite FTS Ranking', body: 'Use bm25 with column weights.' });
    expect(fs.existsSync(path.join(dir, 'notes', 'sqlite-fts-ranking.md'))).toBe(true);

    const hits = await vault.search('bm25');
    expect(hits.map((h) => h.id)).toContain('sqlite-fts-ranking');
  });

  it('merges bodies instead of clobbering on re-upsert', async () => {
    await vault.upsert({ id: 'topic', title: 'Topic', body: 'First insight.' });
    await vault.upsert({ id: 'topic', title: 'Topic', body: 'Second insight.' });
    const note = vault.get('topic')!;
    expect(note.body).toContain('First insight.');
    expect(note.body).toContain('Second insight.');
  });

  it('does not duplicate an identical body', async () => {
    await vault.upsert({ id: 'topic', title: 'Topic', body: 'Same.' });
    await vault.upsert({ id: 'topic', title: 'Topic', body: 'Same.' });
    expect(vault.get('topic')!.body).toBe('Same.');
  });

  it('accumulates provenance across sessions without duplicates', async () => {
    const s1 = { session: 's1', project: 'p', at: '2026-01-01' };
    const s2 = { session: 's2', project: 'p', at: '2026-01-02' };
    await vault.upsert({ id: 't', title: 'T', body: 'a', source: s1 });
    await vault.upsert({ id: 't', title: 'T', body: 'b', source: s2 });
    await vault.upsert({ id: 't', title: 'T', body: 'c', source: s1 });
    expect(vault.get('t')!.frontmatter.sources).toHaveLength(2);
    expect(vault.hasSession('s2')).toBe(true);
    expect(vault.hasSession('nope')).toBe(false);
  });

  it('never links a note to itself', async () => {
    await vault.upsert({ id: 'self', title: 'Self', body: 'x', links: ['self', 'other'] });
    expect(vault.get('self')!.frontmatter.links).toEqual(['other']);
  });

  it('builds a graph with ghost nodes for dangling links', async () => {
    await vault.upsert({ id: 'a', title: 'A', body: 'x', links: ['b', 'ghost'] });
    await vault.upsert({ id: 'b', title: 'B', body: 'y' });

    const g = vault.graph();
    const ghost = g.nodes.find((n) => n.id === 'ghost');
    expect(ghost?.missing).toBe(true);
    expect(g.nodes.find((n) => n.id === 'a')?.missing).toBe(false);
    expect(g.edges).toHaveLength(2);
  });

  it('deduplicates reciprocal edges', async () => {
    await vault.upsert({ id: 'a', title: 'A', body: 'x', links: ['b'] });
    await vault.upsert({ id: 'b', title: 'B', body: 'y', links: ['a'] });
    expect(vault.graph().edges).toHaveLength(1);
  });

  it('survives a malformed note file on reload', async () => {
    await vault.upsert({ id: 'good', title: 'Good', body: 'fine' });
    fs.writeFileSync(path.join(dir, 'notes', 'broken.md'), '---\n: : bad yaml : :\n---\nbody');
    await vault.reload();
    expect(vault.get('good')).not.toBeNull();
  });

  it('rebuilds the index from disk after the db is deleted', async () => {
    await vault.upsert({ title: 'Durable Thing', body: 'searchable content here' });
    vault.close();

    fs.rmSync(path.join(dir, 'index.db'), { force: true });
    const rebuilt = new Vault(dir, new SqliteSearchProvider(path.join(dir, 'index.db')));
    await rebuilt.init();
    const hits = await rebuilt.search('searchable');
    expect(hits.map((h) => h.id)).toContain('durable-thing');
    rebuilt.close();
  });

  it('does not throw on FTS-hostile query text', async () => {
    await vault.upsert({ title: 'Quoting', body: 'content' });
    for (const q of ['"', 'a OR', 'NEAR(', "it's -- broken", '']) {
      await expect(vault.search(q)).resolves.toBeInstanceOf(Array);
    }
  });

  it('updateNote replaces the body instead of merging it', async () => {
    // upsert deliberately merges so a second session deepens a note. Editing
    // must not do that - deleting a sentence by hand has to stick.
    await vault.upsert({ id: 'editable', title: 'Editable', body: 'First line.\n\nSecond line.' });
    const updated = await vault.updateNote('editable', { body: 'First line.' });

    expect(updated?.body).toBe('First line.');
    expect(vault.get('editable')!.body).not.toContain('Second line.');
  });

  it('updateNote preserves provenance, links and created date', async () => {
    await vault.upsert({
      id: 'keeps',
      title: 'Keeps',
      body: 'body',
      links: ['other'],
      tags: ['t'],
      source: { session: 's1', project: 'p', at: '2026-01-01' }
    });
    const before = vault.get('keeps')!.frontmatter;
    const after = (await vault.updateNote('keeps', { body: 'new body' }))!.frontmatter;

    expect(after.sources).toEqual(before.sources);
    expect(after.links).toEqual(before.links);
    expect(after.tags).toEqual(before.tags);
    expect(after.created).toBe(before.created);
  });

  it('updateNote marks the note as human-edited', async () => {
    await vault.upsert({ id: 'byclaude', title: 'By Claude', body: 'x', origin: 'claude' });
    const after = await vault.updateNote('byclaude', { body: 'edited by a person' });
    expect(after?.frontmatter.origin).toBe('human');
  });

  it('updateNote can retitle without touching the body', async () => {
    await vault.upsert({ id: 'retitle', title: 'Old Title', body: 'unchanged' });
    const after = await vault.updateNote('retitle', { title: 'New Title' });
    expect(after?.frontmatter.title).toBe('New Title');
    expect(after?.body).toBe('unchanged');
  });

  it('updateNote survives a round trip through disk', async () => {
    await vault.upsert({ id: 'persist', title: 'Persist', body: 'original' });
    await vault.updateNote('persist', { body: 'rewritten' });
    await vault.reload();
    expect(vault.get('persist')!.body).toBe('rewritten');
  });

  it('updateNote returns null for an unknown id', async () => {
    expect(await vault.updateNote('nope', { body: 'x' })).toBeNull();
  });

  it('an edited note is searchable by its new text, not its old', async () => {
    await vault.upsert({ id: 'searchme', title: 'Search Me', body: 'aardvark' });
    await vault.updateNote('searchme', { body: 'zeppelin' });

    expect((await vault.search('zeppelin')).map((h) => h.id)).toContain('searchme');
    expect((await vault.search('aardvark')).map((h) => h.id)).not.toContain('searchme');
  });

  it('removes a note from disk and index', async () => {
    await vault.upsert({ id: 'temp', title: 'Temp', body: 'gone soon' });
    expect(await vault.remove('temp')).toBe(true);
    expect(vault.get('temp')).toBeNull();
    expect(await vault.search('gone')).toHaveLength(0);
    expect(await vault.remove('temp')).toBe(false);
  });
});
