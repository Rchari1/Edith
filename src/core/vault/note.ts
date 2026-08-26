import matter from 'gray-matter';
import type { Note, NoteFrontmatter, NoteSource } from '../types.js';

/** Turn arbitrary text into a stable, filesystem-safe note id. */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'untitled';
}

/**
 * YAML parses an unquoted `2026-08-25` into a Date, not a string. Without this
 * coercion the `typeof === 'string'` guard fails and the note's real creation
 * date is silently replaced with today's on every reload.
 */
function asDateString(v: unknown, fallback: string): string {
  if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 10);
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return fallback;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function asSources(v: unknown): NoteSource[] {
  if (!Array.isArray(v)) return [];
  const out: NoteSource[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    if (typeof s.session === 'string') {
      out.push({
        session: s.session,
        project: typeof s.project === 'string' ? s.project : '',
        at: typeof s.at === 'string' ? s.at : s.at instanceof Date ? s.at.toISOString() : ''
      });
    }
  }
  return out;
}

/** Parse a note file. Tolerates hand-edited frontmatter with missing or wrong-typed fields. */
export function parseNote(raw: string, filePath: string, fallbackId: string): Note {
  const parsed = matter(raw);
  const d = parsed.data as Record<string, unknown>;
  const now = new Date().toISOString().slice(0, 10);

  const origin = d.origin;
  const frontmatter: NoteFrontmatter = {
    id: typeof d.id === 'string' && d.id ? d.id : fallbackId,
    title: typeof d.title === 'string' && d.title ? d.title : fallbackId,
    type: 'concept',
    created: asDateString(d.created, now),
    updated: asDateString(d.updated, now),
    sources: asSources(d.sources),
    links: asStringArray(d.links),
    origin: origin === 'claude' || origin === 'human' || origin === 'distilled' ? origin : 'human',
    ...(asStringArray(d.tags).length ? { tags: asStringArray(d.tags) } : {})
  };

  return { frontmatter, body: parsed.content.trim(), path: filePath };
}

/** Serialize a note back to disk format. Key order is fixed so diffs stay small. */
export function serializeNote(note: Note): string {
  const f = note.frontmatter;
  const lines: string[] = ['---'];
  lines.push(`id: ${f.id}`);
  lines.push(`title: ${yamlScalar(f.title)}`);
  lines.push(`type: ${f.type}`);
  lines.push(`created: '${f.created}'`);
  lines.push(`updated: '${f.updated}'`);
  lines.push(`origin: ${f.origin}`);

  if (f.tags?.length) lines.push(`tags: [${f.tags.map(yamlScalar).join(', ')}]`);

  if (f.sources.length) {
    lines.push('sources:');
    for (const s of f.sources) {
      lines.push(`  - session: ${s.session}`);
      lines.push(`    project: ${yamlScalar(s.project)}`);
      lines.push(`    at: ${yamlScalar(s.at)}`);
    }
  } else {
    lines.push('sources: []');
  }

  lines.push(f.links.length ? `links: [${f.links.map(yamlScalar).join(', ')}]` : 'links: []');
  lines.push('---', '', note.body.trim(), '');
  return lines.join('\n');
}

/** Quote a YAML scalar only when it needs it. */
function yamlScalar(value: string): string {
  if (value === '') return "''";
  if (/^[A-Za-z0-9][A-Za-z0-9 ._\-/]*$/.test(value) && !/^(true|false|null|yes|no|on|off)$/i.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/** Merge a new source into a note's provenance without creating duplicates. */
export function addSource(f: NoteFrontmatter, source: NoteSource): NoteFrontmatter {
  if (f.sources.some((s) => s.session === source.session)) return f;
  return { ...f, sources: [...f.sources, source] };
}
