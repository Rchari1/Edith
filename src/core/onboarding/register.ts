import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const SERVER_KEY = 'secondbrain';

export interface Target {
  name: string;
  configPath: string;
  /** Present means the surface is installed; absent means skip it, not fail. */
  present: boolean;
}

export interface RegistrationResult {
  target: string;
  configPath: string;
  status: 'registered' | 'already-current' | 'skipped' | 'failed';
  detail?: string;
}

/** Where each Claude surface keeps its MCP configuration. */
export function targets(home = os.homedir(), platform = process.platform): Target[] {
  const desktop =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : platform === 'win32'
        ? path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
        : path.join(home, '.config', 'Claude', 'claude_desktop_config.json');

  return [
    // One user-scope entry here covers the terminal CLI, the VS Code extension,
    // and every project directory - they are all the same Claude Code.
    { name: 'Claude Code', configPath: path.join(home, '.claude.json'), present: false },
    { name: 'Claude Desktop', configPath: desktop, present: false }
  ];
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Resolve which surfaces are actually installed on this machine. */
export async function detectTargets(home = os.homedir(), platform = process.platform): Promise<Target[]> {
  const list = targets(home, platform);
  for (const t of list) {
    // Claude Code counts as present if either its config or its data dir exists.
    t.present =
      (await exists(t.configPath)) ||
      (t.name === 'Claude Code' && (await exists(path.join(home, '.claude'))));
  }
  return list;
}

/**
 * Write a JSON file atomically.
 *
 * ~/.claude.json holds substantial user state. A partial write from a crash
 * mid-save would corrupt it, so we always write a temp file in the same
 * directory and rename over the original, which is atomic on POSIX.
 */
async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Register the brain with one Claude surface.
 *
 * Merges a single key into the existing config and touches nothing else. We
 * write the config file directly rather than shelling out to `claude mcp add`
 * because the CLI is not reliably on PATH for a GUI app launched from Finder.
 */
export async function registerWith(target: Target, url: string): Promise<RegistrationResult> {
  if (!target.present) {
    return {
      target: target.name,
      configPath: target.configPath,
      status: 'skipped',
      detail: 'not installed on this machine'
    };
  }

  try {
    const config = await readJson(target.configPath);
    const servers =
      config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
        ? (config.mcpServers as Record<string, unknown>)
        : {};

    const desired = { type: 'http', url };
    const current = servers[SERVER_KEY];
    if (current && JSON.stringify(current) === JSON.stringify(desired)) {
      return { target: target.name, configPath: target.configPath, status: 'already-current' };
    }

    // Back up once, the first time we ever touch this file.
    const backup = `${target.configPath}.secondbrain-backup`;
    if ((await exists(target.configPath)) && !(await exists(backup))) {
      await fs.copyFile(target.configPath, backup);
    }

    config.mcpServers = { ...servers, [SERVER_KEY]: desired };
    await writeJsonAtomic(target.configPath, config);

    return {
      target: target.name,
      configPath: target.configPath,
      status: 'registered',
      detail: current ? 'updated existing entry' : 'added new entry'
    };
  } catch (err) {
    return {
      target: target.name,
      configPath: target.configPath,
      status: 'failed',
      detail: err instanceof Error ? err.message : String(err)
    };
  }
}

/** Register with every installed surface. */
export async function registerAll(url: string, home = os.homedir()): Promise<RegistrationResult[]> {
  const found = await detectTargets(home);
  const results: RegistrationResult[] = [];
  for (const t of found) results.push(await registerWith(t, url));
  return results;
}

/** Remove the brain's entry. Leaves the rest of the config untouched. */
export async function unregisterAll(home = os.homedir()): Promise<RegistrationResult[]> {
  const found = await detectTargets(home);
  const results: RegistrationResult[] = [];
  for (const t of found) {
    if (!t.present) {
      results.push({ target: t.name, configPath: t.configPath, status: 'skipped' });
      continue;
    }
    try {
      const config = await readJson(t.configPath);
      const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
      if (!(SERVER_KEY in servers)) {
        results.push({ target: t.name, configPath: t.configPath, status: 'skipped', detail: 'not present' });
        continue;
      }
      delete servers[SERVER_KEY];
      config.mcpServers = servers;
      await writeJsonAtomic(t.configPath, config);
      results.push({ target: t.name, configPath: t.configPath, status: 'registered', detail: 'removed' });
    } catch (err) {
      results.push({
        target: t.name,
        configPath: t.configPath,
        status: 'failed',
        detail: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return results;
}
