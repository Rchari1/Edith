/** How long a session can go quiet before its next write counts as a new stretch of work. */
export const IDLE_GAP_MS = 10 * 60_000;

/** Sessions not seen for this long are forgotten, so the maps cannot grow for the life of the app. */
const FORGET_AFTER_MS = 12 * 60 * 60_000;

/**
 * Decides when mini mode appears on its own.
 *
 * The rule the user sees: it opens when a Claude session starts working, and
 * closing it keeps it closed for the rest of that session. Everything here is
 * plain state and timestamps, so the rule is tested without a window.
 *
 * Several sessions can be live at once. Closing the panel dismisses every
 * session active recently - the user closed it while working in all of them,
 * not just in whichever one happened to write to its transcript last.
 */
export class MiniPresence {
  private readonly lastSeen = new Map<string, number>();
  private readonly dismissed = new Map<string, number>();
  private lastActiveAt = -Infinity;
  private stretchStart: number | null = null;

  /** When the current stretch of work began, or null before any session has been seen. */
  get stretchStartedAt(): number | null {
    return this.stretchStart;
  }

  /** Record a session writing to its transcript. Returns true when the panel should open for it. */
  sessionActive(sessionId: string, at: number, autoShow: boolean): boolean {
    if (at - this.lastActiveAt > IDLE_GAP_MS) this.stretchStart = at;
    this.lastActiveAt = Math.max(this.lastActiveAt, at);
    this.forget(at);
    this.lastSeen.set(sessionId, at);
    if (this.dismissed.has(sessionId)) {
      // Still going, so still dismissed - keep the entry from aging out mid-session.
      this.dismissed.set(sessionId, at);
      return false;
    }
    return autoShow;
  }

  /** The user closed the panel: keep it closed for every session live right now. */
  dismiss(at: number): void {
    for (const [id, seen] of this.lastSeen) {
      if (at - seen <= IDLE_GAP_MS) this.dismissed.set(id, at);
    }
  }

  /** The user opened it by hand, which overrides any earlier dismissal. */
  reopen(): void {
    this.dismissed.clear();
  }

  private forget(now: number): void {
    for (const [id, at] of this.lastSeen) if (now - at > FORGET_AFTER_MS) this.lastSeen.delete(id);
    for (const [id, at] of this.dismissed) if (now - at > FORGET_AFTER_MS) this.dismissed.delete(id);
  }
}
