import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { installProposal } from './install.js';
import type { SkillProposal } from './types.js';

/** Records which starter skills have already been offered, so they are offered once. */
const MARKER = path.join('.edith', 'starter-skills.json');

export interface SeedResult {
  seeded: string[];
  skipped: string[];
}

/**
 * Install the bundled starter kit.
 *
 * These are installed rather than queued, so Edith works the moment it is
 * opened rather than requiring five decisions first. The forge stays for what
 * Claude proposes from the user's own work; the kit is what the product ships
 * with, and the installed-skills panel is where someone edits or removes any
 * of it.
 *
 * Installed once each, tracked by id. Deleting one does not bring it back on
 * the next launch - that would make the delete button a lie - and a starter
 * skill added in a later version installs on its own without resurrecting
 * anything already removed.
 */
export async function seedStarterSkills(
  bundledDir: string,
  vaultRoot: string,
  home = os.homedir()
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

      const proposal: SkillProposal = {
        id,
        title: typeof d.title === 'string' ? d.title : id,
        description: typeof d.description === 'string' ? d.description : '',
        body: parsed.content.trim(),
        rationale: typeof d.rationale === 'string' ? d.rationale : '',
        sources: [],
        status: 'accepted',
        created: new Date().toISOString()
      };

      const installed = await installProposal(proposal, home, 'starter');
      // A name collision with something the user wrote is theirs to keep.
      if (installed.status !== 'installed') {
        result.skipped.push(id);
        continue;
      }
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
