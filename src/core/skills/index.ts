import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import type { SkillShape } from '../types.js';

const SHAPES: SkillShape[] = ['chain', 'loop', 'hub', 'spiral'];

/**
 * A skill as Claude defines one: a SKILL.md with frontmatter, living either
 * beside a project or in the user's home. Edith reads the same files from the
 * same places, so a skill exists here the moment it is written - not the first
 * time it happens to run.
 */
export interface Skill {
  /** Frontmatter `name`, falling back to the directory name. */
  name: string;
  description: string;
  /** Frontmatter `shape`; how the skill draws itself in the graph. */
  shape: SkillShape;
  /** Absolute path to the SKILL.md, so the app can open it. */
  path: string;
  scope: 'project' | 'user';
  /** The project this belongs to, for user-scope skills null. */
  project: string | null;
}

function asShape(v: unknown): SkillShape {
  return typeof v === 'string' && (SHAPES as string[]).includes(v) ? (v as SkillShape) : 'chain';
}

/** Read one `<dir>/SKILL.md`. Returns null when it is absent or unreadable. */
async function readSkill(
  dir: string,
  scope: 'project' | 'user',
  project: string | null
): Promise<Skill | null> {
  const file = path.join(dir, 'SKILL.md');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }

  let data: Record<string, unknown> = {};
  try {
    data = matter(raw).data as Record<string, unknown>;
  } catch {
    // Broken frontmatter costs the metadata, not the skill.
  }

  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : path.basename(dir);
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  return { name, description, shape: asShape(data.shape), path: file, scope, project };
}

/** Every SKILL.md one level under `<root>/.claude/skills`. */
async function scanRoot(root: string, scope: 'project' | 'user', project: string | null): Promise<Skill[]> {
  const base = scope === 'user' ? path.join(root, 'skills') : path.join(root, '.claude', 'skills');
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(base, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const found = await Promise.all(entries.map((e) => readSkill(path.join(base, e), scope, project)));
  return found.filter((s): s is Skill => s !== null);
}

/**
 * Discover skills the way Claude resolves them: the user's own always, plus
 * the ones beside each project a session has run in. A project skill shadows a
 * user skill of the same name, matching Claude's precedence.
 */
export async function discoverSkills(projectDirs: string[]): Promise<Skill[]> {
  const user = await scanRoot(path.join(os.homedir(), '.claude'), 'user', null);
  const perProject = await Promise.all(
    [...new Set(projectDirs)].map((d) => scanRoot(d, 'project', d))
  );

  const byName = new Map<string, Skill>();
  for (const s of user) byName.set(s.name, s);
  for (const s of perProject.flat()) byName.set(s.name, s); // project wins
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The project directories Claude has actually run in.
 *
 * `~/.claude/projects` names its folders by a lossy encoding of the path
 * (slashes become dashes, and so do real dashes), so the folder name cannot be
 * decoded back reliably. The transcripts inside record the true `cwd`, so read
 * it from the newest one in each folder instead.
 */
export async function projectRootsFromClaude(): Promise<string[]> {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  let dirs: string[] = [];
  try {
    dirs = (await fs.readdir(projects, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const roots = await Promise.all(
    dirs.map(async (d) => {
      const dir = path.join(projects, d);
      let files: string[];
      try {
        files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
      } catch {
        return null;
      }
      // Newest transcript first - the cwd it records is the current one.
      const stamped = await Promise.all(
        files.map(async (f) => {
          try {
            return { f, at: (await fs.stat(path.join(dir, f))).mtimeMs };
          } catch {
            return { f, at: 0 };
          }
        })
      );
      stamped.sort((a, b) => b.at - a.at);

      for (const { f } of stamped.slice(0, 2)) {
        const cwd = await cwdOf(path.join(dir, f));
        if (cwd) return cwd;
      }
      return null;
    })
  );

  const seen = await Promise.all(
    [...new Set(roots.filter((r): r is string => !!r))].map(async (r) => {
      try {
        return (await fs.stat(r)).isDirectory() ? r : null;
      } catch {
        return null;
      }
    })
  );
  return seen.filter((r): r is string => !!r);
}

/** First `cwd` recorded in a transcript. Only the head is read - it appears early. */
async function cwdOf(file: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  for (const line of raw.split('\n', 80)) {
    if (!line.includes('"cwd"')) continue;
    try {
      const v = (JSON.parse(line) as { cwd?: unknown }).cwd;
      if (typeof v === 'string' && v.startsWith('/')) return v;
    } catch {
      // a truncated or non-JSON line; keep looking
    }
  }
  return null;
}
