import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const HOOK_MARKER = 'edith:session-context';

export interface HookResult {
  status: 'registered' | 'already-current' | 'failed' | 'skipped';
  configPath: string;
  detail?: string;
}

interface HookCommand {
  type: string;
  command: string;
  [k: string]: unknown;
}

interface HookMatcher {
  matcher?: string;
  hooks?: HookCommand[];
  [k: string]: unknown;
}

function settingsPath(home: string): string {
  return path.join(home, '.claude', 'settings.json');
}

/**
 * The command Claude Code runs at session start.
 *
 * `|| true` matters: if Edith is not running, curl exits non-zero, and without
 * it a failing hook would surface an error at the top of every session. The
 * marker comment is how we find our own entry again to update or remove it.
 */
export function hookCommand(contextUrl: string): string {
  return `curl -s --max-time 2 ${contextUrl} || true # ${HOOK_MARKER}`;
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

function isOurs(entry: HookMatcher): boolean {
  return (entry.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes(HOOK_MARKER));
}

/**
 * Register a SessionStart hook that injects a primer describing the brain.
 *
 * Tool descriptions alone do not reliably get Claude to consult the brain -
 * it has to already be considering a tool to read them. Injecting context at
 * session start is what makes retrieval happen unprompted.
 *
 * Merges into settings.json and touches nothing else, with a one-time backup.
 */
export async function registerSessionHook(contextUrl: string, home = os.homedir()): Promise<HookResult> {
  const file = settingsPath(home);
  try {
    const config = await readJson(file);
    const hooks = (config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)
      ? config.hooks
      : {}) as Record<string, unknown>;

    const existing = Array.isArray(hooks.SessionStart) ? (hooks.SessionStart as HookMatcher[]) : [];
    const desired: HookMatcher = {
      matcher: 'startup|clear|compact',
      hooks: [{ type: 'command', command: hookCommand(contextUrl), async: false }]
    };

    const ours = existing.filter(isOurs);
    const theirs = existing.filter((e) => !isOurs(e));

    if (ours.length === 1 && JSON.stringify(ours[0]) === JSON.stringify(desired)) {
      return { status: 'already-current', configPath: file };
    }

    const backup = `${file}.edith-backup`;
    try {
      await fs.access(file);
      try {
        await fs.access(backup);
      } catch {
        await fs.copyFile(file, backup);
      }
    } catch {
      // No settings file yet; nothing to back up.
    }

    // Replace any previous entry of ours; leave every other hook untouched.
    hooks.SessionStart = [...theirs, desired];
    config.hooks = hooks;
    await writeJsonAtomic(file, config);

    return {
      status: 'registered',
      configPath: file,
      detail: ours.length ? 'updated existing hook' : 'added session-start hook'
    };
  } catch (err) {
    return {
      status: 'failed',
      configPath: file,
      detail: err instanceof Error ? err.message : String(err)
    };
  }
}

/** Remove only our hook, leaving any others in place. */
export async function unregisterSessionHook(home = os.homedir()): Promise<HookResult> {
  const file = settingsPath(home);
  try {
    const config = await readJson(file);
    const hooks = (config.hooks ?? {}) as Record<string, unknown>;
    const existing = Array.isArray(hooks.SessionStart) ? (hooks.SessionStart as HookMatcher[]) : [];
    const theirs = existing.filter((e) => !isOurs(e));
    if (theirs.length === existing.length) {
      return { status: 'skipped', configPath: file, detail: 'not present' };
    }

    if (theirs.length) hooks.SessionStart = theirs;
    else delete hooks.SessionStart;

    if (Object.keys(hooks).length === 0) delete config.hooks;
    else config.hooks = hooks;

    await writeJsonAtomic(file, config);
    return { status: 'registered', configPath: file, detail: 'removed' };
  } catch (err) {
    return { status: 'failed', configPath: file, detail: err instanceof Error ? err.message : String(err) };
  }
}
