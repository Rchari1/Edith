import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { SkillProposal } from './types.js';

/** Marker so an Edith-installed skill can be recognised and removed later. */
export const FORGED_BY = 'edith-forge';

export interface InstallResult {
  status: 'installed' | 'conflict' | 'failed';
  dir: string;
  detail?: string;
}

export function userSkillsDir(home = os.homedir()): string {
  return path.join(home, '.claude', 'skills');
}

/** Render a proposal as a real SKILL.md. */
export function renderSkill(p: SkillProposal): string {
  const lines = [
    '---',
    `name: ${p.id}`,
    `description: ${p.description.replace(/\n/g, ' ')}`,
    `metadata:`,
    `  forged-by: ${FORGED_BY}`,
    `  proposed: ${p.created}`,
    '---',
    '',
    p.body.trim(),
    ''
  ];
  return lines.join('\n');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Install an accepted proposal as a real Claude Code skill.
 *
 * Refuses to overwrite a skill Edith did not create. A name collision with
 * something the user wrote by hand, or with another tool's skill, should
 * surface as a conflict for them to resolve - silently replacing it would
 * destroy work and be very hard to notice.
 */
export async function installProposal(
  p: SkillProposal,
  home = os.homedir()
): Promise<InstallResult> {
  const dir = path.join(userSkillsDir(home), p.id);
  const file = path.join(dir, 'SKILL.md');

  try {
    if (await exists(file)) {
      const current = await fs.readFile(file, 'utf8');
      if (!current.includes(FORGED_BY)) {
        return {
          status: 'conflict',
          dir,
          detail: `a skill named "${p.id}" already exists and was not created by Edith`
        };
      }
    }

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, renderSkill(p), 'utf8');
    return { status: 'installed', dir };
  } catch (err) {
    return { status: 'failed', dir, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Remove a previously forged skill. Leaves anything Edith did not create alone. */
export async function uninstallProposal(id: string, home = os.homedir()): Promise<InstallResult> {
  const dir = path.join(userSkillsDir(home), id);
  const file = path.join(dir, 'SKILL.md');
  try {
    if (!(await exists(file))) return { status: 'installed', dir, detail: 'not present' };
    const current = await fs.readFile(file, 'utf8');
    if (!current.includes(FORGED_BY)) {
      return { status: 'conflict', dir, detail: 'skill was not created by Edith' };
    }
    await fs.rm(dir, { recursive: true, force: true });
    return { status: 'installed', dir, detail: 'removed' };
  } catch (err) {
    return { status: 'failed', dir, detail: err instanceof Error ? err.message : String(err) };
  }
}
