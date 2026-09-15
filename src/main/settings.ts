import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_WIDTH, type MiniShape } from '../core/mini/dock.js';

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
  /** Open mini mode on its own when a Claude session starts working. */
  miniAutoShow: boolean;
  /** Width of the mini panel when unfolded, in points. */
  miniWidth: number;
  /** The mini mode used last - the rail or the square - so minimizing returns to it. */
  miniShape: MiniShape;
}

export function defaultSettings(userDataDir: string): Settings {
  return {
    apiKey: '',
    vaultPath: path.join(userDataDir, 'vault'),
    model: 'claude-opus-5',
    port: 4319,
    autoDistill: true,
    minTurns: 4,
    miniAutoShow: true,
    miniWidth: DEFAULT_WIDTH,
    miniShape: 'rail'
  };
}

export async function loadSettings(file: string, userDataDir: string): Promise<Settings> {
  const defaults = defaultSettings(userDataDir);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
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
