import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * How much a skill's accumulated weight fades on each run.
 *
 * A note hit every single run settles at 1/(1-DECAY) = 10; a note hit once
 * falls under the prune floor after ~30 runs. So the store answers "where does
 * this skill keep working", not "what did it touch last time".
 */
const DECAY = 0.9;

/** Below this a note has effectively dropped out of the skill's territory. */
const FLOOR = 0.08;

/** Written at most this often, so a burst of searches is one disk write. */
const FLUSH_MS = 2000;

export interface SkillTerritory {
  skill: string;
  runs: number;
  lastAt: number;
  /** Note id -> accumulated weight, strongest first. */
  notes: Array<{ id: string; weight: number }>;
}

interface Stored {
  version: 1;
  skills: Record<string, { runs: number; lastAt: number; notes: Record<string, number> }>;
}

/**
 * Which notes each skill keeps coming back to.
 *
 * One search tells you almost nothing - phrase the query differently and you
 * get a different set. Accumulated across runs and decayed, the same structure
 * says something durable: this is the region of the brain this skill works in.
 */
export class SkillAffinity {
  private data: Stored = { version: 1, skills: {} };
  private flushTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Stored;
      if (raw && raw.version === 1 && raw.skills) this.data = raw;
    } catch {
      // absent or corrupt: start empty rather than refuse to run
    }
  }

  /** Fold one run into the skill's territory. */
  record(skill: string, noteIds: string[]): void {
    if (!skill || noteIds.length === 0) return;
    const entry = (this.data.skills[skill] ??= { runs: 0, lastAt: 0, notes: {} });

    // Everything fades a little, then this run's hits are added. A note that
    // keeps appearing outruns the decay; a one-off does not.
    for (const id of Object.keys(entry.notes)) {
      const w = (entry.notes[id] ?? 0) * DECAY;
      if (w < FLOOR) delete entry.notes[id];
      else entry.notes[id] = w;
    }
    for (const id of noteIds) entry.notes[id] = (entry.notes[id] ?? 0) + 1;

    entry.runs += 1;
    entry.lastAt = Date.now();
    this.schedule();
  }

  /**
   * A skill's territory, strongest first. `known` filters out notes that have
   * since been deleted, so a stale id never reaches the graph.
   */
  territory(skill: string, known?: (id: string) => boolean): SkillTerritory | null {
    const entry = this.data.skills[skill];
    if (!entry) return null;
    const notes = Object.entries(entry.notes)
      .filter(([id]) => !known || known(id))
      .map(([id, weight]) => ({ id, weight: Math.round(weight * 100) / 100 }))
      .sort((a, b) => b.weight - a.weight);
    return { skill, runs: entry.runs, lastAt: entry.lastAt, notes };
  }

  all(known?: (id: string) => boolean): SkillTerritory[] {
    return Object.keys(this.data.skills)
      .map((s) => this.territory(s, known))
      .filter((t): t is SkillTerritory => t !== null);
  }

  /**
   * Notes that more than one skill keeps landing on - the load-bearing ones.
   * Returned strongest-shared first.
   */
  overlaps(known?: (id: string) => boolean): Array<{ id: string; skills: string[]; weight: number }> {
    const byNote = new Map<string, { skills: string[]; weight: number }>();
    for (const t of this.all(known)) {
      for (const n of t.notes) {
        const row = byNote.get(n.id) ?? { skills: [], weight: 0 };
        row.skills.push(t.skill);
        row.weight += n.weight;
        byNote.set(n.id, row);
      }
    }
    return [...byNote.entries()]
      .filter(([, r]) => r.skills.length > 1)
      .map(([id, r]) => ({ id, ...r }))
      .sort((a, b) => b.weight - a.weight);
  }

  private schedule(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_MS);
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch {
      // a failed write costs this run's tally, not the process
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    await this.flush();
  }
}
