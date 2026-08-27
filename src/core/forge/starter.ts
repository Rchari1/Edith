import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import type { Forge } from './forge.js';

/** Records which starter skills have already been offered, so they are offered once. */
const MARKER = path.join('.edith', 'starter-skills.json');

export interface SeedResult {
  seeded: string[];
  skipped: string[];
}

/**
 * Offer the bundled starter kit to a new user.
 *
 * A brand new forge is empty, which makes the feature impossible to understand:
 * a deck with nothing in it explains nothing. Seeding a few genuinely useful
 * skills gives it something to be, and teaches the review flow on proposals the
 * user can safely discard.
 *
 * They arrive as proposals, not installed skills. Edith proposes and the person
 * decides - shipping skills straight into ~/.claude/skills would break that and
 * put files on someone's machine they never agreed to.
 *
 * Seeded once each, tracked by id. Rejecting one does not bring it back, and a
 * starter skill added in a later version seeds on its own without re-offering
 * the ones already answered.
 */
export async function seedStarterSkills(
  forge: Forge,
  bundledDir: string,
  vaultRoot: string
): Promise<SeedResult> {
  const markerPath = path.join(vaultRoot, MARKER);
  const already = await readMarker(markerPath);
  const result: SeedResult = { seeded: [], skipped: [] };

  let files: string[] = [];
  try {
    files = (await fs.readdir(bundledDir)).filter((f) => f.endsWith('.md'));
  } catch {
    return result; // No bundle present - nothing to offer.
  }

  for (const file of files.sort()) {
    const id = path.basename(file, '.md');
    if (already.includes(id)) {
      result.skipped.push(id);
      continue;
    }

    try {
      const raw = await fs.readFile(path.join(bundledDir, file), 'utf8');
      const parsed = matter(raw);
      const d = parsed.data as Record<string, unknown>;

      await forge.propose({
        id,
        title: typeof d.title === 'string' ? d.title : id,
        description: typeof d.description === 'string' ? d.description : '',
        body: parsed.content.trim(),
        rationale: typeof d.rationale === 'string' ? d.rationale : '',
        bypassCap: true
      });
      result.seeded.push(id);
    } catch {
      // One malformed starter file must not stop the rest being offered.
    }
  }

  if (result.seeded.length) {
    await writeMarker(markerPath, [...already, ...result.seeded]);
  }
  return result;
}

async function readMarker(file: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function writeMarker(file: string, ids: string[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify([...new Set(ids)], null, 2), 'utf8');
  await fs.rename(tmp, file);
}
