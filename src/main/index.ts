import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { AppState } from './app-state.js';
import { registerAll, unregisterAll } from '../core/onboarding/register.js';
import type { BrainEvent } from '../core/types.js';


let state: AppState | null = null;
let win: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0d12',
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

  ipcMain.handle('brain:delete-note', async (_e, id: string) => {
    const ok = await appState.vault.remove(id);
    send('brain:vault-changed', null);
    return ok;
  });

  ipcMain.handle('brain:reveal-vault', () => {
    void shell.openPath(appState.settings.vaultPath);
  });

  ipcMain.handle('brain:open-note-file', (_e, id: string) => {
    const note = appState.vault.get(id);
    if (note) void shell.openPath(note.path);
  });
}

void app.whenReady().then(async () => {
  win = createWindow();

  state = new AppState(app.getPath('userData'));
  state.on('event', (event: BrainEvent) => {
    send('brain:event', event);
    if (event.type === 'saved') send('brain:vault-changed', null);
  });
  state.on('vault-changed', () => send('brain:vault-changed', null));

  try {
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
