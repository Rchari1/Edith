import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { slugify } from '../vault/note.js';
import type { SkillProposal, ForgeCounts } from './types.js';

export interface ProposeInput {
  title: string;
  description: string;
  body: string;
  rationale?: string;
  sources?: string[];
  id?: string;
  /**
   * Bypass the pending cap. Only for the bundled starter kit: the cap exists to
   * stop Claude flooding the queue, and applying it to the kit would mean a new
   * user's queue is full before they have done any work.
   */
  bypassCap?: boolean;
}

/**
 * Holds skills Claude has proposed but the user has not yet judged.
 *
 * Edith never writes a skill itself - it has no API key and no opinions. Claude
 * drafts one from what it read in the brain, using the plan the user already
 * pays for, and this is where it waits. Nothing reaches ~/.claude/skills until
 * a person says yes.
 *
 * Proposals are markdown with frontmatter, same as notes, so the whole forge is
 * inspectable and editable in any editor.
 */
/**
 * How many proposals may wait for review at once.
 *
 * A hard cap rather than a request in the tool description, because asking is
 * not enough: a queue of twenty never gets reviewed, so proposal twenty-one
 * costs the user nothing but noise and makes the first three less likely to be
 * read. Refusing tells Claude plainly to stop until the user catches up.
 */
export const DEFAULT_MAX_PENDING = 5;

export class Forge {
  readonly dir: string;
  private cache = new Map<string, SkillProposal>();
  private readonly maxPending: number;

  constructor(vaultRoot: string, maxPending = DEFAULT_MAX_PENDING) {
    this.dir = path.join(vaultRoot, 'skills');
    this.maxPending = maxPending;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await this.reload();
  }

  async reload(): Promise<void> {
    this.cache.clear();
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      try {
        const raw = await fs.readFile(path.join(this.dir, entry), 'utf8');
        const p = parseProposal(raw, path.basename(entry, '.md'));
        this.cache.set(p.id, p);
      } catch {
        // A malformed proposal must not hide the rest of the queue.
      }
    }
  }

  list(status?: SkillProposal['status']): SkillProposal[] {
    const all = [...this.cache.values()];
    const filtered = status ? all.filter((p) => p.status === status) : all;
    // Oldest first: the queue is reviewed in the order things were noticed.
    return filtered.sort((a, b) => a.created.localeCompare(b.created));
  }

  get(id: string): SkillProposal | null {
    return this.cache.get(id) ?? null;
  }

  counts(): ForgeCounts {
    const all = [...this.cache.values()];
    return {
      proposed: all.filter((p) => p.status === 'proposed').length,
      accepted: all.filter((p) => p.status === 'accepted').length,
      rejected: all.filter((p) => p.status === 'rejected').length
    };
  }

  /**
   * Record a proposal.
   *
   * Re-proposing an id that was already rejected is ignored: if the user said
   * no, Claude noticing the same pattern again next week should not put it back
   * in the queue. Re-proposing a pending one replaces it, so a better draft
   * can supersede a worse one.
   */
  async propose(input: ProposeInput): Promise<{ proposal: SkillProposal | null; reason?: string }> {
    const id = slugify(input.id || input.title);
    const existing = this.cache.get(id);

    if (existing?.status === 'rejected') {
      return { proposal: null, reason: 'previously rejected by the user' };
    }
    if (existing?.status === 'accepted') {
      return { proposal: null, reason: 'already accepted and installed' };
    }

    // Replacing a pending proposal is fine; adding a new one to a full queue
    // is not.
    if (!input.bypassCap && !existing && this.counts().proposed >= this.maxPending) {
      return {
        proposal: null,
        reason: `the review queue is full (${this.maxPending} waiting). Do not propose more until the user has reviewed them - tell them there are skills waiting in Edith instead.`
      };
    }

    const proposal: SkillProposal = {
      id,
      title: input.title.trim() || id,
      description: input.description.trim(),
      body: input.body.trim(),
      rationale: (input.rationale ?? '').trim(),
      sources: [...new Set(input.sources ?? [])],
      status: 'proposed',
      created: existing?.created ?? new Date().toISOString()
    };

    await this.write(proposal);
    return { proposal };
  }

  /**
   * Edit a proposal before deciding on it.
   *
   * Review is not a binary when the draft is nearly right: rejecting something
   * that needed one line changed throws away the whole thing, and accepting it
   * installs a skill the user does not quite want. Only pending proposals can
   * be edited - changing one already decided would silently diverge from the
   * skill actually installed on disk.
   */
  async editProposal(
    id: string,
    patch: { title?: string; description?: string; body?: string }
  ): Promise<SkillProposal | null> {
    const existing = this.cache.get(id);
    if (!existing || existing.status !== 'proposed') return null;

    const next: SkillProposal = {
      ...existing,
      title: patch.title?.trim() || existing.title,
      description: (patch.description ?? existing.description).replace(/\n/g, ' ').trim(),
      body: (patch.body ?? existing.body).trim()
    };
    await this.write(next);
    return next;
  }

  async setStatus(
    id: string,
    status: 'accepted' | 'rejected',
    installedAt?: string
  ): Promise<SkillProposal | null> {
    const existing = this.cache.get(id);
    if (!existing) return null;
    const next: SkillProposal = {
      ...existing,
      status,
      decided: new Date().toISOString(),
      ...(installedAt ? { installedAt } : {})
    };
    await this.write(next);
    return next;
  }

  /**
   * Put a decided proposal back in the queue, for a change of mind.
   *
   * Works for accepted as well as rejected: undoing an acceptance uninstalls
   * the skill and requeues it, so the two paths converge here rather than
   * leaving an accepted proposal whose skill no longer exists.
   */
  async restore(id: string): Promise<SkillProposal | null> {
    const existing = this.cache.get(id);
    if (!existing || existing.status === 'proposed') return null;
    const next: SkillProposal = { ...existing, status: 'proposed' };
    delete next.decided;
    delete next.installedAt;
    await this.write(next);
    return next;
  }

  async remove(id: string): Promise<boolean> {
    if (!this.cache.has(id)) return false;
    await fs.rm(path.join(this.dir, `${id}.md`), { force: true });
    this.cache.delete(id);
    return true;
  }

  private async write(p: SkillProposal): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, `${p.id}.md`), serializeProposal(p), 'utf8');
    this.cache.set(p.id, p);
  }
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function parseProposal(raw: string, fallbackId: string): SkillProposal {
  const parsed = matter(raw);
  const d = parsed.data as Record<string, unknown>;
  const status = d.status;
  return {
    id: typeof d.id === 'string' && d.id ? d.id : fallbackId,
    title: typeof d.title === 'string' ? d.title : fallbackId,
    description: typeof d.description === 'string' ? d.description : '',
    body: parsed.content.trim(),
    rationale: typeof d.rationale === 'string' ? d.rationale : '',
    sources: asStringArray(d.sources),
    status: status === 'accepted' || status === 'rejected' ? status : 'proposed',
    created: typeof d.created === 'string' ? d.created : new Date().toISOString(),
    ...(typeof d.decided === 'string' ? { decided: d.decided } : {}),
    ...(typeof d.installedAt === 'string' ? { installedAt: d.installedAt } : {})
  };
}

function yaml(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

export function serializeProposal(p: SkillProposal): string {
  const lines = ['---', `id: ${p.id}`, `title: ${yaml(p.title)}`, `description: ${yaml(p.description)}`];
  lines.push(`status: ${p.status}`, `created: ${yaml(p.created)}`);
  if (p.decided) lines.push(`decided: ${yaml(p.decided)}`);
  if (p.installedAt) lines.push(`installedAt: ${yaml(p.installedAt)}`);
  if (p.rationale) lines.push(`rationale: ${yaml(p.rationale)}`);
  lines.push(p.sources.length ? `sources: [${p.sources.join(', ')}]` : 'sources: []');
  lines.push('---', '', p.body.trim(), '');
  return lines.join('\n');
}
