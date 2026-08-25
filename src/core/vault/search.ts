import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import type { Note, SearchHit, SearchProvider } from '../types.js';

/**
 * Full-text search over the vault, backed by SQLite FTS5.
 *
 * Deliberately behind the SearchProvider interface: swapping in hybrid
 * semantic search later touches this file and nothing else.
 */
export class SqliteSearchProvider implements SearchProvider {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        updated TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        id UNINDEXED, title, body, tokenize='porter unicode61'
      );
    `);
  }

  /**
   * FTS5 has its own query grammar and raw user text routinely breaks it
   * (a stray quote or hyphen is a syntax error, not zero results). Reduce the
   * query to quoted terms OR'd together - forgiving, and good enough for recall.
   */
  private static toMatchQuery(query: string): string | null {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9_]+/i)
      .map((t) => t.trim())
      .filter((t) => t.length > 1);
    if (terms.length === 0) return null;
    return terms.map((t) => `"${t}"*`).join(' OR ');
  }

  async search(query: string, limit = 10): Promise<SearchHit[]> {
    const match = SqliteSearchProvider.toMatchQuery(query);
    if (!match) return [];

    const rows = this.db
      .prepare(
        `SELECT f.id AS id,
                n.title AS title,
                snippet(notes_fts, 2, '', '', ' ... ', 14) AS snippet,
                bm25(notes_fts, 0.0, 5.0, 1.0) AS score
         FROM notes_fts f
         JOIN notes n ON n.id = f.id
         WHERE notes_fts MATCH ?
         ORDER BY score
         LIMIT ?`
      )
      .all(match, limit) as Array<{ id: string; title: string; snippet: string; score: number }>;

    // bm25 returns lower-is-better; flip it so callers can treat score as relevance.
    return rows.map((r) => ({ ...r, score: -r.score }));
  }

  async upsert(note: Note): Promise<void> {
    const { id, title, updated } = note.frontmatter;
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM notes WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM notes_fts WHERE id = ?').run(id);
      this.db
        .prepare('INSERT INTO notes (id, title, body, updated) VALUES (?, ?, ?, ?)')
        .run(id, title, note.body, updated);
      this.db
        .prepare('INSERT INTO notes_fts (id, title, body) VALUES (?, ?, ?)')
        .run(id, title, note.body);
    });
    tx();
  }

  async remove(id: string): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM notes WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM notes_fts WHERE id = ?').run(id);
    });
    tx();
  }

  async reindex(notes: Note[]): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db.exec('DELETE FROM notes; DELETE FROM notes_fts;');
      const insN = this.db.prepare('INSERT INTO notes (id, title, body, updated) VALUES (?, ?, ?, ?)');
      const insF = this.db.prepare('INSERT INTO notes_fts (id, title, body) VALUES (?, ?, ?)');
      for (const n of notes) {
        insN.run(n.frontmatter.id, n.frontmatter.title, n.body, n.frontmatter.updated);
        insF.run(n.frontmatter.id, n.frontmatter.title, n.body);
      }
    });
    tx();
  }

  close(): void {
    this.db.close();
  }
}
