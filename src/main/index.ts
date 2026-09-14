import { app, BrowserWindow, ipcMain, shell, dialog, nativeImage } from 'electron';
import path from 'node:path';
import { AppState } from './app-state.js';
import { MiniWindow, type MiniState } from './mini.js';
import { MiniPresence } from '../core/mini/presence.js';
import { registerAll, unregisterAll } from '../core/onboarding/register.js';
import { IMPORTABLE_EXTENSIONS } from '../core/importer/index.js';
import { listInstalled, updateInstalled, deleteInstalled } from '../core/forge/installed.js';
import { migrateLegacyUserData } from './migrate.js';
import type { BrainEvent } from '../core/types.js';
import fsp from 'node:fs/promises';
import type { Dirent } from 'node:fs';


let state: AppState | null = null;
let win: BrowserWindow | null = null;
let mini: MiniWindow | null = null;
/** Decides when mini mode opens on its own. Outlives any one window, like the sessions it tracks. */
const presence = new MiniPresence();

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

  // Edith is either the full window or the mini panel, never both: minimizing
  // the window turns it into the panel, and bringing the window back puts the
  // panel away.
  window.on('minimize', () => enterMini());
  window.on('restore', () => mini?.hide());
  window.on('show', () => mini?.hide());

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

/** The main window and the mini panel draw from the same stream, so every push goes to both. */
function send(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

function miniState(): MiniState | null {
  if (!state?.settings || !mini) return null;
  return {
    visible: mini.visible,
    collapsed: mini.collapsed,
    autoShow: state.settings.miniAutoShow,
    stretchStartedAt: presence.stretchStartedAt
  };
}

function pushMiniState(): void {
  const s = miniState();
  if (s) send('mini:state', s);
}

/** Whether the full window is actually up, as opposed to closed or minimized into the panel. */
function mainOnScreen(): boolean {
  return Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized());
}

/**
 * A session wrote to its transcript. Mini mode opens for it unless the user
 * turned that off, already closed the panel during this session, or has the
 * full window up - which already shows the activity, and hiding a window the
 * user has open would be worse than not opening the panel.
 */
function onSessionActive(sessionId: string, at: number): void {
  if (!state?.settings) return;
  const stretch = presence.stretchStartedAt;
  const show = presence.sessionActive(sessionId, at, state.settings.miniAutoShow);
  if (!mini) return;
  if (show && !mini.visible && !mainOnScreen()) mini.show();
  else if (presence.stretchStartedAt !== stretch) pushMiniState();
}

/** Minimizing Edith - from the traffic light or the rail - turns it into the panel. */
function enterMini(): void {
  if (!mini) return;
  presence.reopen();
  mini.show();
}

/** Bring the full window back, creating it if it was closed, and put the panel away. */
function showMain(): void {
  if (!win || win.isDestroyed()) {
    win = createWindow();
  } else {
    if (win.isMinimized()) win.restore();
    win.show();
  }
  mini?.hide();
  // The panel never activates the app, so bringing the window forward has to.
  app.focus({ steal: true });
  win.focus();
}

function registerMiniIpc(appState: AppState, panel: MiniWindow): void {
  ipcMain.handle('mini:state', () => miniState());

  // The rail button turns the window into the panel directly. Minimizing and
  // waiting for the event is not reliable: with Stage Manager on, macOS moves
  // the window into its strip instead, and no minimize event ever arrives.
  ipcMain.handle('mini:enter', () => {
    if (win && !win.isDestroyed()) win.hide();
    enterMini();
  });

  ipcMain.handle('mini:close', () => {
    presence.dismiss(Date.now());
    panel.hide();
  });

  ipcMain.handle('mini:collapse', (_e, collapsed: boolean) => panel.setCollapsed(Boolean(collapsed)));
  ipcMain.handle('mini:peek', (_e, on: boolean) => panel.peek(Boolean(on)));
  ipcMain.handle('mini:set-width', (_e, width: number) => panel.setWidth(Number(width)));

  ipcMain.handle('mini:open-app', () => showMain());

  ipcMain.handle('mini:set-auto-show', async (_e, on: boolean) => {
    await appState.updateSettings({ miniAutoShow: Boolean(on) });
    pushMiniState();
    return miniState();
  });
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
  // The window may be closed, or minimized into the panel, while the app keeps running.
  app.on('second-instance', () => showMain());

  void app.whenReady().then(async () => {
    applyDockIcon();
    win = createWindow();

    state = new AppState(app.getPath('userData'));
    state.on('event', (event: BrainEvent) => {
      send('brain:event', event);
      if (event.type === 'saved') send('brain:vault-changed', null);
      if (event.type === 'session-active') onSessionActive(event.sessionId, event.at);
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

      const appState = state;
      mini = new MiniWindow(
        { width: appState.settings.miniWidth, collapsed: appState.settings.miniCollapsed },
        (prefs) =>
          void appState.updateSettings({
            ...(prefs.width !== undefined ? { miniWidth: prefs.width } : {}),
            ...(prefs.collapsed !== undefined ? { miniCollapsed: prefs.collapsed } : {})
          }),
        pushMiniState
      );
      registerMiniIpc(appState, mini);
      pushMiniState();
    } catch (err) {
      send('brain:event', {
        type: 'status',
        message: `Startup failed: ${err instanceof Error ? err.message : String(err)}`,
        level: 'error',
        at: Date.now()
      });
    }

    app.on('activate', () => {
      // The dock icon brings the full window back from anywhere: closed, or
      // minimized into the panel. The panel is a window too, so an empty
      // window list is no longer the test.
      if (!mainOnScreen()) showMain();
    });
  });
}

if (hasSingleInstanceLock) start();

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  mini?.destroy();
  mini = null;
  if (!state) return;
  event.preventDefault();
  const s = state;
  state = null;
  await s.stop();
  app.quit();
});
