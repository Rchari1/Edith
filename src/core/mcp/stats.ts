import type { BrainEvent } from '../types.js';
import type { BrainEventBus } from './events.js';

interface SessionRecord {
  firstSeen: number;
  lastSeen: number;
  searches: number;
  reads: number;
  saves: number;
}

export interface RetrievalReport {
  /** Sessions seen writing to a transcript while Edith was running. */
  sessionsSeen: number;
  /** Of those, how many consulted or wrote to the brain at all. */
  sessionsThatUsedBrain: number;
  /** The headline number: are sessions reaching for the brain unprompted? */
  coverage: string;
  totals: { searches: number; reads: number; saves: number };
  perSession: Array<{
    session: string;
    searches: number;
    reads: number;
    saves: number;
    minutes: number;
  }>;
}

/**
 * Tracks whether Claude actually reaches for the brain during real sessions.
 *
 * The product risk is not that retrieval is slow, it is that it never fires:
 * a brain Claude never consults is invisible to the user no matter how good
 * the graph looks. This makes that measurable instead of anecdotal.
 *
 * Tool calls carry no session id - the MCP server is stateless by design - so
 * calls are attributed to the most recently active session. In practice one
 * session is active at a time, which makes that accurate enough to steer by.
 */
export class RetrievalStats {
  private readonly sessions = new Map<string, SessionRecord>();
  private lastActive: string | null = null;
  private lastActiveAt = 0;

  /** How long after a session's last write a tool call is still attributed to it. */
  private readonly attributionWindowMs = 10 * 60_000;

  attach(bus: BrainEventBus): () => void {
    return bus.onEvent((e) => this.record(e));
  }

  record(event: BrainEvent): void {
    if (event.type === 'session-active') {
      const existing = this.sessions.get(event.sessionId);
      if (existing) existing.lastSeen = event.at;
      else
        this.sessions.set(event.sessionId, {
          firstSeen: event.at,
          lastSeen: event.at,
          searches: 0,
          reads: 0,
          saves: 0
        });
      this.lastActive = event.sessionId;
      this.lastActiveAt = event.at;
      return;
    }

    if (event.type !== 'considered' && event.type !== 'opened' && event.type !== 'saved') return;

    // No active session recently enough to attribute this to.
    if (!this.lastActive || event.at - this.lastActiveAt > this.attributionWindowMs) return;
    const record = this.sessions.get(this.lastActive);
    if (!record) return;

    if (event.type === 'considered') record.searches++;
    else if (event.type === 'opened') record.reads++;
    else record.saves++;
  }

  report(): RetrievalReport {
    const all = [...this.sessions.entries()];
    const used = all.filter(([, r]) => r.searches + r.reads + r.saves > 0);
    const pct = all.length ? Math.round((used.length / all.length) * 100) : 0;

    return {
      sessionsSeen: all.length,
      sessionsThatUsedBrain: used.length,
      coverage: `${used.length}/${all.length} (${pct}%)`,
      totals: {
        searches: all.reduce((n, [, r]) => n + r.searches, 0),
        reads: all.reduce((n, [, r]) => n + r.reads, 0),
        saves: all.reduce((n, [, r]) => n + r.saves, 0)
      },
      perSession: all
        .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
        .map(([session, r]) => ({
          session: session.slice(0, 8),
          searches: r.searches,
          reads: r.reads,
          saves: r.saves,
          minutes: Math.max(1, Math.round((r.lastSeen - r.firstSeen) / 60_000))
        }))
    };
  }
}
