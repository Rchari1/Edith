import type { BrainEvent } from '../types.js';

export type TouchKind = 'considered' | 'opened' | 'saved';

const RANK: Record<TouchKind, number> = { considered: 1, opened: 2, saved: 3 };

/** Which kind of touch an event is, or null for events that touch no notes. */
export function touchKind(event: BrainEvent): TouchKind | null {
  switch (event.type) {
    // A skill tracing through notes is a kind of recall - the graph lights it the same way.
    case 'considered':
    case 'skill':
      return 'considered';
    case 'opened':
      return 'opened';
    case 'saved':
      return 'saved';
    default:
      return null;
  }
}

/**
 * The notes Claude has reached for, each held at the strongest thing that
 * happened to it. A note surfaced by a search and then opened counts once, as
 * opened - so the counts describe notes, not tool calls.
 */
export class TouchedNotes {
  private readonly kinds = new Map<string, TouchKind>();

  /** Fold one event in. Returns what it touched, or null when it touched nothing. */
  record(event: BrainEvent): { ids: string[]; kind: TouchKind } | null {
    const kind = touchKind(event);
    if (!kind || !('noteIds' in event)) return null;
    for (const id of event.noteIds) {
      const prev = this.kinds.get(id);
      if (!prev || RANK[kind] > RANK[prev]) this.kinds.set(id, kind);
    }
    return { ids: event.noteIds, kind };
  }

  ids(): string[] {
    return [...this.kinds.keys()];
  }

  get size(): number {
    return this.kinds.size;
  }

  clear(): void {
    this.kinds.clear();
  }

  /** Each note counted once, at its strongest state. */
  counts(): Record<TouchKind, number> {
    const out: Record<TouchKind, number> = { considered: 0, opened: 0, saved: 0 };
    for (const k of this.kinds.values()) out[k]++;
    return out;
  }
}
