import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import type { Vault, UpsertInput } from '../vault/vault.js';
import { slugify } from '../vault/note.js';

/** File types accepted for direct import. */
export const IMPORTABLE_EXTENSIONS = ['.md', '.markdown', '.txt', '.mdx'];

export interface ImportResult {
  file: string;
  id?: string;
  status: 'imported' | 'skipped' | 'failed';
  detail?: string;
}

export interface ImportSummary {
  imported: number;
  skipped: number;
  failed: number;
  results: ImportResult[];
}

/** Derive a readable title from a filename: `my-note_v2.md` -> `My Note V2`. */
export function titleFromFilename(filePath: string): string {
  const base = path.basename(filePath).replace(/\.[^.]+$/, '');
  const words = base.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  if (!words) return 'Untitled';
  return words
    .split(/\s+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Read a file into an upsert payload.
 *
 * A file that already carries frontmatter - a note exported from another
 * Markdown app, or a note from another Edith vault - keeps its identity, so
 * re-importing deepens the existing note rather than creating a duplicate.
 */
export async function readImportable(filePath: string): Promise<UpsertInput> {
  const raw = await fs.readFile(filePath, 'utf8');

  // gray-matter throws on malformed YAML. A single bad header should cost the
  // file its metadata, not its content - importing someone's vault must not
  // silently drop a note because its frontmatter is broken.
  let d: Record<string, unknown> = {};
  let body = raw.trim();
  try {
    const parsed = matter(raw);
    d = parsed.data as Record<string, unknown>;
    body = parsed.content.trim() || raw.trim();
  } catch {
    // keep the raw text; no usable frontmatter
  }

  const title = (typeof d.title === 'string' && d.title.trim()) || titleFromFilename(filePath);
  const id = typeof d.id === 'string' && d.id.trim() ? slugify(d.id) : slugify(title);

  const links = Array.isArray(d.links) ? d.links.filter((l): l is string => typeof l === 'string') : [];
  const tags = Array.isArray(d.tags) ? d.tags.filter((t): t is string => typeof t === 'string') : [];

  return { id, title, body, links, tags, origin: 'human' };
}

/** Import files directly as notes, preserving any frontmatter they carry. */
export async function importFiles(vault: Vault, files: string[]): Promise<ImportSummary> {
  const results: ImportResult[] = [];

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!IMPORTABLE_EXTENSIONS.includes(ext)) {
      results.push({ file, status: 'skipped', detail: `unsupported type ${ext || '(none)'}` });
      continue;
    }
    try {
      const input = await readImportable(file);
      if (!input.body.trim()) {
        results.push({ file, status: 'skipped', detail: 'file is empty' });
        continue;
      }
      const note = await vault.upsert(input);
      results.push({ file, id: note.frontmatter.id, status: 'imported' });
    } catch (err) {
      results.push({ file, status: 'failed', detail: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    imported: results.filter((r) => r.status === 'imported').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results
  };
}

/**
 * Name a note from its own first line.
 *
 * Pasted text almost never arrives with a title, and asking for one puts a
 * required field in front of the fastest path into the app. A heading or an
 * opening sentence is what someone would have typed anyway, so take that and
 * let them rename it later by editing the note.
 */
export function titleFromBody(body: string): string {
  const first = body
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!first) return 'Untitled';

  // Strip the markdown that would otherwise end up inside the title.
  const clean = first
    .replace(/^#{1,6}(?:\s+|$)/, '')
    .replace(/^[-*+](?:\s+|$)/, '')
    .replace(/^>(?:\s+|$)/, '')
    .replace(/^\d+[.)](?:\s+|$)/, '')
    .trim();
  if (!clean) return 'Untitled';
  if (clean.length <= 72) return clean;

  // Cut on a word boundary rather than mid-word.
  const cut = clean.slice(0, 72);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).trim()}\u2026`;
}

/** Save pasted text as a single note, verbatim. */
export async function importText(vault: Vault, title: string, body: string): Promise<{ id: string }> {
  const clean = body.trim();
  if (!clean) throw new Error('Nothing to import - the text is empty.');
  const note = await vault.upsert({
    title: title.trim() || titleFromBody(clean),
    body: clean,
    origin: 'human'
  });
  return { id: note.frontmatter.id };
}
