import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import matter from 'gray-matter';
import { FORGED_BY, userSkillsDir } from './install.js';

export interface InstalledSkill {
  id: string;
  description: string;
  body: string;
  /** 'starter' shipped with Edith; 'forged' came from a proposal the user accepted. */
  origin: 'starter' | 'forged';
  path: string;
}

/**
 * The skills Edith has put on disk.
 *
 * Only ever reports skills carrying Edith's marker. A user's own hand-written
 * skills live in the same directory and must never appear in a list that
 * offers a delete button.
 */
export async function listInstalled(home = os.homedir()): Promise<InstalledSkill[]> {
  const root = userSkillsDir(home);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }

  const skills: InstalledSkill[] = [];
  for (const id of entries.sort()) {
    const file = path.join(root, id, 'SKILL.md');
    try {
      const raw = await fs.readFile(file, 'utf8');
      if (!raw.includes(FORGED_BY)) continue; // not ours

      const parsed = matter(raw);
      const meta = (parsed.data as { metadata?: Record<string, unknown> }).metadata ?? {};
      const description = (parsed.data as { description?: unknown }).description;
      skills.push({
        id,
        description: typeof description === 'string' ? description : '',
        body: parsed.content.trim(),
        origin: meta.origin === 'starter' ? 'starter' : 'forged',
        path: file
      });
    } catch {
      // Unreadable skill directory - skip rather than fail the whole listing.
    }
  }
  return skills;
}

/** Rewrite an installed skill's body and description, preserving its identity. */
export async function updateInstalled(
  id: string,
  patch: { description?: string; body?: string },
  home = os.homedir()
): Promise<InstalledSkill | null> {
  const current = (await listInstalled(home)).find((s) => s.id === id);
  if (!current) return null;

  const description = (patch.description ?? current.description).replace(/\n/g, ' ').trim();
  const body = (patch.body ?? current.body).trim();

  const content = [
    '---',
    `name: ${id}`,
    `description: ${description}`,
    'metadata:',
    `  forged-by: ${FORGED_BY}`,
    `  origin: ${current.origin}`,
    '  edited: true',
    '---',
    '',
    body,
    ''
  ].join('\n');

  await fs.writeFile(current.path, content, 'utf8');
  return { ...current, description, body };
}

/** Remove an installed skill. Refuses anything Edith did not create. */
export async function deleteInstalled(
  id: string,
  home = os.homedir()
): Promise<{ ok: boolean; detail?: string }> {
  const dir = path.join(userSkillsDir(home), id);
  const file = path.join(dir, 'SKILL.md');
  try {
    const raw = await fs.readFile(file, 'utf8');
    if (!raw.includes(FORGED_BY)) {
      return { ok: false, detail: 'that skill was not created by Edith' };
    }
    await fs.rm(dir, { recursive: true, force: true });
    return { ok: true };
  } catch {
    return { ok: false, detail: 'not found' };
  }
}
