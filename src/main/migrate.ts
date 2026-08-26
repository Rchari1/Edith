import fs from 'node:fs/promises';
import path from 'node:path';

/** Directory names this app has used for its Electron userData, oldest first. */
const LEGACY_APP_DIRS = ['secondbrain'];

export interface MigrationResult {
  migrated: boolean;
  from?: string;
  items: string[];
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
 * Carry a previous install's data into the current userData directory.
 *
 * Electron derives userData from the app name, so renaming the product moves
 * it - and the vault and settings from before the rename would silently
 * disappear, looking to the user like their notes were deleted.
 *
 * Copies rather than moves: if anything goes wrong the old directory is still
 * sitting there intact. Only runs when the destination does not already exist,
 * so it can never overwrite newer data.
 */
export async function migrateLegacyUserData(currentUserData: string): Promise<MigrationResult> {
  const parent = path.dirname(currentUserData);
  const items: string[] = [];

  for (const legacyName of LEGACY_APP_DIRS) {
    const legacyDir = path.join(parent, legacyName);
    if (path.resolve(legacyDir) === path.resolve(currentUserData)) continue;
    if (!(await exists(legacyDir))) continue;

    // Only the things we own. The rest of userData is Chromium's cache.
    for (const item of ['vault', 'settings.json']) {
      const from = path.join(legacyDir, item);
      const to = path.join(currentUserData, item);
      if (!(await exists(from))) continue;
      if (await exists(to)) continue;

      await fs.mkdir(currentUserData, { recursive: true });
      await fs.cp(from, to, { recursive: true });
      items.push(item);
    }

    if (items.length) return { migrated: true, from: legacyDir, items };
  }

  return { migrated: false, items };
}
