import { app, BrowserWindow, ipcMain, shell, dialog, nativeImage } from 'electron';
import path from 'node:path';
import { AppState } from './app-state.js';
import { registerAll, unregisterAll } from '../core/onboarding/register.js';
import { IMPORTABLE_EXTENSIONS } from '../core/importer/index.js';
import { listInstalled, updateInstalled, deleteInstalled } from '../core/forge/installed.js';
import { migrateLegacyUserData } from './migrate.js';
import type { BrainEvent } from '../core/types.js';
import fsp from 'node:fs/promises';
import type { Dirent } from 'node:fs';


let state: AppState | null = null;
let win: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0d12',
    title: 'Edith',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  window.once('ready-to-show', () => window.show());

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
  return window;
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function registerIpc(appState: AppState): void {
  ipcMain.handle('brain:status', () => appState.status());
  ipcMain.handle('brain:graph', () => appState.graph());
  ipcMain.handle('brain:settings', () => appState.settings);
  ipcMain.handle('brain:recent-events', () => appState.server.bus.recent());
  ipcMain.handle('brain:skills', () => appState.skills());
  ipcMain.handle('brain:skill-territories', () => appState.territories());
  ipcMain.handle('brain:skill-overlaps', () => appState.skillOverlaps());

  ipcMain.handle('brain:note', (_e, id: string) => {
    const note = appState.vault.get(id);
    return note ? { frontmatter: note.frontmatter, body: note.body, path: note.path } : null;
  });

  ipcMain.handle('brain:notes', () =>
    appState.vault.list().map((n) => ({ frontmatter: n.frontmatter, body: n.body, path: n.path }))
  );

  ipcMain.handle('brain:search', (_e, query: string, limit?: number) =>
    appState.vault.search(query, limit ?? 20)
  );

  ipcMain.handle('brain:update-settings', async (_e, patch) => {
    const next = await appState.updateSettings(patch);
    send('brain:status', appState.status());
    return next;
  });

  ipcMain.handle('brain:backfill', async () => {
    const result = await appState.backfill();
    send('brain:status', appState.status());
    return result;
  });

  ipcMain.handle('brain:reregister', async () => {
    const url = appState.server.url;
    if (!url) return [];
    appState.registrations = await registerAll(url);
    send('brain:status', appState.status());
    return appState.registrations;
  });

  ipcMain.handle('brain:unregister', async () => {
    const results = await unregisterAll();
    send('brain:status', appState.status());
    return results;
  });

  ipcMain.handle('brain:update-note', async (_e, id: string, patch: { title?: string; body?: string }) => {
    const note = await appState.vault.updateNote(id, patch);
    if (!note) return null;
    send('brain:vault-changed', null);
    return { frontmatter: note.frontmatter, body: note.body, path: note.path };
  });

  ipcMain.handle('brain:delete-note', async (_e, id: string) => {
    const ok = await appState.vault.remove(id);
    send('brain:vault-changed', null);
    return ok;
  });

  /**
   * Pick a folder and collect the importable files inside it. Walking here
   * rather than in the renderer keeps filesystem access on this side of the
   * bridge, and lets an Obsidian vault be added in one gesture.
   */
  ipcMain.handle('brain:pick-folder', async () => {
    if (!win) return [];
    const result = await dialog.showOpenDialog(win, {
      title: 'Add a folder to your brain',
      properties: ['openDirectory']
    });
    const root = result.canceled ? undefined : result.filePaths[0];
    if (!root) return [];

    const found: string[] = [];
    const MAX_FILES = 2000;
    const MAX_DEPTH = 8;

    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > MAX_DEPTH || found.length >= MAX_FILES) return;
      let entries: Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return; // unreadable directory: skip it rather than fail the whole pick
      }
      for (const e of entries) {
        if (found.length >= MAX_FILES) return;
        // Dot-directories and dependency trees are never notes.
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full, depth + 1);
        else if (IMPORTABLE_EXTENSIONS.some((ext) => e.name.toLowerCase().endsWith(ext))) {
          found.push(full);
        }
      }
    }

    await walk(root, 0);
    return found;
  });

  ipcMain.handle('brain:pick-files', async () => {
    if (!win) return [];
    const result = await dialog.showOpenDialog(win, {
      title: 'Add files to your brain',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Notes and text', extensions: IMPORTABLE_EXTENSIONS.map((e) => e.slice(1)) },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('brain:import-files', async (_e, files: string[], mode: 'verbatim' | 'distill') => {
    const summary = await appState.importPaths(files, mode);
    send('brain:vault-changed', null);
    send('brain:status', appState.status());
    return summary;
  });

  ipcMain.handle(
    'brain:import-text',
    async (_e, title: string, body: string, mode: 'verbatim' | 'distill') => {
      const result = await appState.importPastedText(title, body, mode);
      send('brain:vault-changed', null);
      send('brain:status', appState.status());
      return result;
    }
  );

  ipcMain.handle('forge:installed', () => listInstalled());

  ipcMain.handle('forge:update-installed', async (_e, id: string, patch: { description?: string; body?: string }) => {
    const r = await updateInstalled(id, patch);
    send('forge:changed', null);
    return r;
  });

  ipcMain.handle('forge:delete-installed', async (_e, id: string) => {
    const r = await deleteInstalled(id);
    send('forge:changed', null);
    return r;
  });

  ipcMain.handle('forge:list', () => ({
    proposals: appState.forge.list(),
    counts: appState.forge.counts()
  }));

  ipcMain.handle('forge:edit', async (_e, id: string, patch: { title?: string; description?: string; body?: string }) => {
    const r = await appState.forge.editProposal(id, patch);
    send('forge:changed', null);
    return r;
  });

  ipcMain.handle('forge:accept', async (_e, id: string) => {
    const r = await appState.acceptSkill(id);
    send('forge:changed', null);
    return r;
  });

  ipcMain.handle('forge:reject', async (_e, id: string) => {
    const r = await appState.rejectSkill(id);
    send('forge:changed', null);
    return r;
  });

  ipcMain.handle('forge:undo', async (_e, id: string) => {
    const r = await appState.undoSkill(id);
    send('forge:changed', null);
    return r;
  });

  ipcMain.handle('brain:reveal-vault', () => {
    void shell.openPath(appState.settings.vaultPath);
  });

  /**
   * Skill files are addressed by name, never by path: the renderer can only
   * reach a SKILL.md that discovery already found, so nothing else on disk is
   * readable or writable through this bridge.
   */
  ipcMain.handle('brain:skill-file', async (_e, name: string) => {
    const skill = (await appState.skills()).find((s) => s.name === name);
    if (!skill) return null;
    try {
      return { ...skill, content: await fsp.readFile(skill.path, 'utf8') };
    } catch {
      return null;
    }
  });

  ipcMain.handle('brain:save-skill', async (_e, name: string, content: string) => {
    const skill = (await appState.skills()).find((s) => s.name === name);
    if (!skill) return false;
    try {
      await fsp.writeFile(skill.path, content, 'utf8');
      await appState.skills(true); // frontmatter may have changed the shape
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('brain:open-skill-file', async (_e, name: string) => {
    const skill = (await appState.skills()).find((s) => s.name === name);
    if (skill) void shell.openPath(skill.path);
  });

  ipcMain.handle('brain:open-note-file', (_e, id: string) => {
    const note = appState.vault.get(id);
    if (note) void shell.openPath(note.path);
  });
}

// A second copy would run a second watcher over the same transcripts and
// distill every session twice - double API spend - while binding a different
// port and rewriting the MCP config to point at it. Everything below must be
// gated on holding the lock: calling app.quit() alone does NOT stop whenReady
// from firing, so an unguarded second instance still clobbers the config on
// its way out.
// Without this the menu bar and dock read "Electron" whenever the app is run
// from source rather than from a packaged bundle.
app.setName('Edith');

// The macOS About panel otherwise falls back to the framework's own name.
app.setAboutPanelOptions({
  applicationName: 'Edith',
  applicationVersion: app.getVersion(),
  copyright: 'A second brain for Claude',
  credits: 'Local notes, distilled from your Claude sessions.'
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
}

/** In development there is no bundle to read the icon from, so set it explicitly. */
function applyDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) return;
  const iconPath = path.join(__dirname, '../../assets/icon.png');
  const image = nativeImage.createFromPath(iconPath);
  if (!image.isEmpty()) app.dock.setIcon(image);
}

function start(): void {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  void app.whenReady().then(async () => {
    applyDockIcon();
    win = createWindow();

    state = new AppState(app.getPath('userData'));
    state.on('event', (event: BrainEvent) => {
      send('brain:event', event);
      if (event.type === 'saved') send('brain:vault-changed', null);
    });
    state.on('vault-changed', () => send('brain:vault-changed', null));
    state.on('forge-changed', () => send('forge:changed', null));

    try {
      // Renaming the product moved userData; bring a prior install's vault and
      // settings across before anything reads from the new location.
      const migration = await migrateLegacyUserData(app.getPath('userData'));
      if (migration.migrated) {
        send('brain:event', {
          type: 'status',
          message: `Brought ${migration.items.join(' and ')} across from your previous install`,
          level: 'info',
          at: Date.now()
        });
      }

      await state.start();
      registerIpc(state);
      send('brain:status', state.status());
    } catch (err) {
      send('brain:event', {
        type: 'status',
        message: `Startup failed: ${err instanceof Error ? err.message : String(err)}`,
        level: 'error',
        at: Date.now()
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) win = createWindow();
    });
  });
}

if (hasSingleInstanceLock) start();

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  if (!state) return;
  event.preventDefault();
  const s = state;
  state = null;
  await s.stop();
  app.quit();
});
