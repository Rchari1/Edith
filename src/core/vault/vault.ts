import fs from 'node:fs/promises';
import path from 'node:path';
import type { Note, NoteFrontmatter, NoteSource, SearchHit, SearchProvider } from '../types.js';
import { parseNote, serializeNote, slugify, addSource } from './note.js';

export interface UpsertInput {
  title: string;
  body: string;
  id?: string;
  links?: string[];
  tags?: string[];
  origin?: NoteFrontmatter['origin'];
  source?: NoteSource;
}

export interface GraphNode {
  id: string;
  title: string;
  origin: NoteFrontmatter['origin'];
  /** First tag, used by the UI to color and group. Empty for ghost nodes. */
  category: string;
  sourceCount: number;
  degree: number;
  /** True when something links here but no note exists yet. */
  missing: boolean;
  updated: string;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * The vault. Markdown files on disk are the source of truth; the search index
 * is a derived cache that can be deleted and rebuilt at any time.
 */
export class Vault {
  readonly notesDir: string;
  private cache = new Map<string, Note>();

  constructor(
    readonly root: string,
    private readonly index: SearchProvider
  ) {
    this.notesDir = path.join(root, 'notes');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.notesDir, { recursive: true });
    await this.reload();
  }

  /** Re-read every note from disk and rebuild the index. */
  async reload(): Promise<void> {
    this.cache.clear();
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.notesDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const full = path.join(this.notesDir, entry);
      try {
        const raw = await fs.readFile(full, 'utf8');
        const note = parseNote(raw, full, path.basename(entry, '.md'));
        this.cache.set(note.frontmatter.id, note);
      } catch {
        // A note that fails to read should never take the vault down.
      }
    }
    await this.index.reindex([...this.cache.values()]);
  }

  /** Re-read a single file after an external edit. */
  async reloadOne(filePath: string): Promise<Note | null> {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const note = parseNote(raw, filePath, path.basename(filePath, '.md'));
      this.cache.set(note.frontmatter.id, note);
      await this.index.upsert(note);
      return note;
    } catch {
      return null;
    }
  }

  list(): Note[] {
    return [...this.cache.values()].sort((a, b) =>
      b.frontmatter.updated.localeCompare(a.frontmatter.updated)
    );
  }

  get(id: string): Note | null {
    return this.cache.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.cache.has(id);
  }

  size(): number {
    return this.cache.size;
  }

  async search(query: string, limit = 10): Promise<SearchHit[]> {
    return this.index.search(query, limit);
  }

  /**
   * Create or update a note. When the id already exists the bodies are merged
   * rather than overwritten, so a second session about the same concept
   * deepens the note instead of clobbering it.
   */
  async upsert(input: UpsertInput): Promise<Note> {
    const id = input.id ? slugify(input.id) : slugify(input.title);
    const today = new Date().toISOString().slice(0, 10);
    const existing = this.cache.get(id);

    let frontmatter: NoteFrontmatter;
    let body: string;

    if (existing) {
      frontmatter = {
        ...existing.frontmatter,
        title: input.title || existing.frontmatter.title,
        updated: today,
        links: [...new Set([...existing.frontmatter.links, ...(input.links ?? [])])],
        ...(input.tags?.length
          ? { tags: [...new Set([...(existing.frontmatter.tags ?? []), ...input.tags])] }
          : {})
      };
      body = mergeBodies(existing.body, input.body);
    } else {
      frontmatter = {
        id,
        title: input.title || id,
        type: 'concept',
        created: today,
        updated: today,
        sources: [],
        links: [...new Set(input.links ?? [])].map(slugify),
        origin: input.origin ?? 'distilled',
        ...(input.tags?.length ? { tags: input.tags } : {})
      };
      body = input.body.trim();
    }

    if (input.source) frontmatter = addSource(frontmatter, input.source);
    frontmatter.links = [...new Set(frontmatter.links.map(slugify))].filter((l) => l !== id);

    const filePath = path.join(this.notesDir, `${id}.md`);
    const note: Note = { frontmatter, body, path: filePath };

    await fs.mkdir(this.notesDir, { recursive: true });
    await fs.writeFile(filePath, serializeNote(note), 'utf8');
    this.cache.set(id, note);
    await this.index.upsert(note);
    return note;
  }

  /**
   * Replace a note's body and title outright.
   *
   * Distinct from upsert, which deliberately *merges* bodies so a second
   * session about the same concept deepens the note. That is right for
   * capture and wrong for editing - someone deleting a sentence by hand must
   * not have it appended straight back.
   *
   * Provenance, links, tags and created date are preserved; origin becomes
   * 'human' because a person has now touched it.
   */
  async updateNote(id: string, patch: { title?: string; body?: string }): Promise<Note | null> {
    const existing = this.cache.get(id);
    if (!existing) return null;

    const frontmatter: NoteFrontmatter = {
      ...existing.frontmatter,
      title: patch.title?.trim() || existing.frontmatter.title,
      updated: new Date().toISOString().slice(0, 10),
      origin: 'human'
    };
    const body = patch.body !== undefined ? patch.body.trim() : existing.body;
    const note: Note = { frontmatter, body, path: existing.path };

    await fs.writeFile(existing.path, serializeNote(note), 'utf8');
    this.cache.set(id, note);
    await this.index.upsert(note);
    return note;
  }

  async remove(id: string): Promise<boolean> {
    const note = this.cache.get(id);
    if (!note) return false;
    await fs.rm(note.path, { force: true });
    this.cache.delete(id);
    await this.index.remove(id);
    return true;
  }

  /** Has this session already been distilled into any note? */
  hasSession(sessionId: string): boolean {
    for (const note of this.cache.values()) {
      if (note.frontmatter.sources.some((s) => s.session === sessionId)) return true;
    }
    return false;
  }

  /** Build the node/edge graph the UI renders. Dangling links become ghost nodes. */
  graph(): Graph {
    const edgeSet = new Set<string>();
    const edges: GraphEdge[] = [];
    const degree = new Map<string, number>();
    const bump = (id: string) => degree.set(id, (degree.get(id) ?? 0) + 1);

    for (const note of this.cache.values()) {
      const from = note.frontmatter.id;
      for (const to of note.frontmatter.links) {
        if (to === from) continue;
        const key = from < to ? `${from}|${to}` : `${to}|${from}`;
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        edges.push({ from, to });
        bump(from);
        bump(to);
      }
    }

    const nodes: GraphNode[] = [...this.cache.values()].map((n) => ({
      id: n.frontmatter.id,
      title: n.frontmatter.title,
      origin: n.frontmatter.origin,
      category: n.frontmatter.tags?.[0] ?? 'other',
      sourceCount: n.frontmatter.sources.length,
      degree: degree.get(n.frontmatter.id) ?? 0,
      missing: false,
      updated: n.frontmatter.updated
    }));

    const known = new Set(nodes.map((n) => n.id));
    for (const e of edges) {
      for (const id of [e.from, e.to]) {
        if (known.has(id)) continue;
        known.add(id);
        nodes.push({
          id,
          title: id.replace(/-/g, ' '),
          origin: 'distilled',
          category: '',
          sourceCount: 0,
          degree: degree.get(id) ?? 0,
          missing: true,
          updated: ''
        });
      }
    }

    return { nodes, edges };
  }

  close(): void {
    this.index.close();
  }
}

/** Append genuinely new material instead of replacing what is already written. */
function mergeBodies(existing: string, incoming: string): string {
  const trimmed = incoming.trim();
  if (!trimmed) return existing;
  if (existing.includes(trimmed)) return existing;
  return `${existing.trim()}\n\n${trimmed}`;
}
