import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const SKILL_NAME = 'edith';

export interface SkillResult {
  status: 'installed' | 'already-current' | 'failed';
  dir: string;
  detail?: string;
}

export function skillDir(home: string): string {
  return path.join(home, '.claude', 'skills', SKILL_NAME);
}

async function sameContent(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([fs.readFile(a, 'utf8'), fs.readFile(b, 'utf8')]);
    return x === y;
  } catch {
    return false;
  }
}

/**
 * Install the /edith skill.
 *
 * Unlike the MCP registration and the status line, this writes only inside its
 * own directory under ~/.claude/skills - it never touches a shared config file,
 * so there is nothing to merge and nothing of the user's to preserve. Deleting
 * the directory removes it completely.
 */
export async function installSkill(sourceDir: string, home = os.homedir()): Promise<SkillResult> {
  const dir = skillDir(home);
  try {
    const files = ['SKILL.md', 'status'];
    const unchanged = await Promise.all(
      files.map((f) => sameContent(path.join(sourceDir, f), path.join(dir, f)))
    );
    if (unchanged.every(Boolean)) return { status: 'already-current', dir };

    await fs.mkdir(dir, { recursive: true });
    for (const f of files) {
      await fs.copyFile(path.join(sourceDir, f), path.join(dir, f));
    }
    await fs.chmod(path.join(dir, 'status'), 0o755);
    return { status: 'installed', dir };
  } catch (err) {
    return { status: 'failed', dir, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function removeSkill(home = os.homedir()): Promise<SkillResult> {
  const dir = skillDir(home);
  try {
    await fs.rm(dir, { recursive: true, force: true });
    return { status: 'installed', dir, detail: 'removed' };
  } catch (err) {
    return { status: 'failed', dir, detail: err instanceof Error ? err.message : String(err) };
  }
}
