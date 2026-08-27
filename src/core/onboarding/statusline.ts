import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/** Present in our command string so we can recognise our own entry later. */
export const STATUSLINE_MARKER = 'edith-status';

export interface StatusLineResult {
  status: 'installed' | 'already-current' | 'skipped' | 'failed';
  configPath: string;
  detail?: string;
}

function settingsPath(home: string): string {
  return path.join(home, '.claude', 'settings.json');
}

/** Where the script lives once installed. Stable across app moves and upgrades. */
export function scriptPath(home: string): string {
  return path.join(home, '.claude', 'edith-status');
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

function isOurs(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const cmd = (value as { command?: unknown }).command;
  return typeof cmd === 'string' && cmd.includes(STATUSLINE_MARKER);
}

/**
 * Install the Edith status line.
 *
 * Unlike hooks, which are a list Edith can join, `statusLine` is a single
 * value. Taking it means the user loses whatever they had. So this refuses
 * outright when a status line exists that is not ours - a tool that silently
 * replaces someone's carefully built status bar is a tool people uninstall.
 */
export async function installStatusLine(
  sourceScript: string,
  home = os.homedir()
): Promise<StatusLineResult> {
  const file = settingsPath(home);
  try {
    const config = await readJson(file);
    const existing = config.statusLine;

    if (existing && !isOurs(existing)) {
      return {
        status: 'skipped',
        configPath: file,
        detail: 'a different status line is already configured'
      };
    }

    const target = scriptPath(home);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(sourceScript, target);
    await fs.chmod(target, 0o755);

    const desired = { type: 'command', command: target, padding: 2 };
    if (existing && JSON.stringify(existing) === JSON.stringify(desired)) {
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
      // no settings file yet
    }

    config.statusLine = desired;
    await writeJsonAtomic(file, config);
    return { status: 'installed', configPath: file, detail: target };
  } catch (err) {
    return {
      status: 'failed',
      configPath: file,
      detail: err instanceof Error ? err.message : String(err)
    };
  }
}

/** Remove it, but only if it is still ours. */
export async function removeStatusLine(home = os.homedir()): Promise<StatusLineResult> {
  const file = settingsPath(home);
  try {
    const config = await readJson(file);
    if (!config.statusLine) {
      return { status: 'skipped', configPath: file, detail: 'none configured' };
    }
    if (!isOurs(config.statusLine)) {
      return { status: 'skipped', configPath: file, detail: 'status line is not ours' };
    }
    delete config.statusLine;
    await writeJsonAtomic(file, config);
    await fs.rm(scriptPath(home), { force: true });
    return { status: 'installed', configPath: file, detail: 'removed' };
  } catch (err) {
    return {
      status: 'failed',
      configPath: file,
      detail: err instanceof Error ? err.message : String(err)
    };
  }
}
