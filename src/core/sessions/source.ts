import type { Vault } from '../vault/vault.js';
import type { SessionWatcher } from '../watcher/index.js';
import { renderForDistill } from '../parser/parse-session.js';

export interface SessionSummary {
  id: string;
  title: string | null;
  project: string;
  startedAt: string | null;
  turns: number;
  /** True once any note in the vault cites this session. */
  captured: boolean;
}

/**
 * Read-only view of the Claude sessions on disk.
 *
 * Exists so Claude can review its own past sessions and decide what is worth
 * keeping - the distilling happens inside the user's Claude session, on their
 * own plan, rather than Edith calling an API with a key of its own.
 */
export interface SessionSource {
  list(limit: number, unsavedOnly: boolean): Promise<SessionSummary[]>;
  read(id: string): Promise<string | null>;
}

export class WatcherSessionSource implements SessionSource {
  constructor(
    private readonly watcher: SessionWatcher,
    private readonly vault: Vault
  ) {}

  async list(limit = 20, unsavedOnly = false): Promise<SessionSummary[]> {
    const found = await this.watcher.scanExisting();
    const summaries: SessionSummary[] = [];

    for (const entry of found) {
      try {
        const session = await this.watcher.loadSession(entry.file, entry.projectSlug, entry.sessionId);
        if (session.turns.length === 0) continue;
        const captured = this.vault.hasSession(session.id);
        if (unsavedOnly && captured) continue;
        summaries.push({
          id: session.id,
          title: session.title,
          project: session.projectSlug,
          startedAt: session.startedAt,
          turns: session.turns.length,
          captured
        });
      } catch {
        // A session that will not parse should not hide the rest.
      }
    }

    // Most recent first: what someone wants to review is usually what just happened.
    summaries.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
    return summaries.slice(0, limit);
  }

  async read(id: string): Promise<string | null> {
    const found = await this.watcher.scanExisting();
    const entry = found.find((f) => f.sessionId === id || f.sessionId.startsWith(id));
    if (!entry) return null;
    const session = await this.watcher.loadSession(entry.file, entry.projectSlug, entry.sessionId);
    return renderForDistill(session);
  }
}
