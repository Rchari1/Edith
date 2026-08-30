import fs from 'node:fs/promises';
import path from 'node:path';

export interface Settings {
  /** Stored locally. Falls back to ANTHROPIC_API_KEY when empty. */
  apiKey: string;
  vaultPath: string;
  model: string;
  port: number;
  /** Distill sessions automatically as they settle. */
  autoDistill: boolean;
  /** Skip sessions shorter than this. */
  minTurns: number;
}

export function defaultSettings(userDataDir: string): Settings {
  return {
    apiKey: '',
    vaultPath: path.join(userDataDir, 'vault'),
    model: 'claude-opus-5',
    port: 4319,
    autoDistill: true,
    minTurns: 4
  };
}

/**
 * Take each field only if it is the right type, otherwise keep the default.
 *
 * The file is JSON on disk that anything can write - a hand edit, a half-
 * finished migration, an IPC call that was not checked. Spreading it over the
 * defaults behind a cast trusted all of it, and one wrong type was enough to
 * take the app down for good: a non-string vaultPath makes path.join throw
 * inside startup, startup is wrapped in a try, and the IPC handlers are
 * registered *after* it - so the window opens with nothing behind it, every
 * call fails, and there is no settings screen left to undo it from.
 */
function coerce(parsed: Record<string, unknown>, defaults: Settings): Settings {
  const str = (k: keyof Settings, d: string): string =>
    typeof parsed[k] === 'string' ? (parsed[k] as string) : d;
  const num = (k: keyof Settings, d: number): number =>
    typeof parsed[k] === 'number' && Number.isFinite(parsed[k]) ? (parsed[k] as number) : d;
  const bool = (k: keyof Settings, d: boolean): boolean =>
    typeof parsed[k] === 'boolean' ? (parsed[k] as boolean) : d;

  // An empty vault path is as unusable as a wrong-typed one.
  const vaultPath = str('vaultPath', defaults.vaultPath).trim() || defaults.vaultPath;

  return {
    apiKey: str('apiKey', defaults.apiKey),
    vaultPath,
    model: str('model', defaults.model).trim() || defaults.model,
    port: num('port', defaults.port),
    autoDistill: bool('autoDistill', defaults.autoDistill),
    minTurns: num('minTurns', defaults.minTurns)
  };
}

export async function loadSettings(file: string, userDataDir: string): Promise<Settings> {
  const defaults = defaultSettings(userDataDir);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults;
    return coerce(parsed as Record<string, unknown>, defaults);
  } catch {
    return defaults;
  }
}

/** Apply a patch, keeping anything that arrives with the wrong type out. */
export function mergeSettings(current: Settings, patch: Record<string, unknown>): Settings {
  return coerce({ ...current, ...patch } as Record<string, unknown>, current);
}

export async function saveSettings(file: string, settings: Settings): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

/** The key actually used for API calls. Settings win over the environment. */
export function resolveApiKey(settings: Settings): string | null {
  return settings.apiKey.trim() || process.env.ANTHROPIC_API_KEY?.trim() || null;
}
