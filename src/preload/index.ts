import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/** The renderer's entire view of the main process. Nothing else crosses the bridge. */
const api = {
  status: () => ipcRenderer.invoke('brain:status'),
  graph: () => ipcRenderer.invoke('brain:graph'),
  settings: () => ipcRenderer.invoke('brain:settings'),
  recentEvents: () => ipcRenderer.invoke('brain:recent-events'),
  note: (id: string) => ipcRenderer.invoke('brain:note', id),
  notes: () => ipcRenderer.invoke('brain:notes'),
  search: (query: string, limit?: number) => ipcRenderer.invoke('brain:search', query, limit),
  updateSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke('brain:update-settings', patch),
  backfill: () => ipcRenderer.invoke('brain:backfill'),
  reregister: () => ipcRenderer.invoke('brain:reregister'),
  unregister: () => ipcRenderer.invoke('brain:unregister'),
  deleteNote: (id: string) => ipcRenderer.invoke('brain:delete-note', id),
  revealVault: () => ipcRenderer.invoke('brain:reveal-vault'),
  pickFiles: () => ipcRenderer.invoke('brain:pick-files'),
  importFiles: (files: string[], mode: 'verbatim' | 'distill') =>
    ipcRenderer.invoke('brain:import-files', files, mode),
  importText: (title: string, body: string, mode: 'verbatim' | 'distill') =>
    ipcRenderer.invoke('brain:import-text', title, body, mode),
  openNoteFile: (id: string) => ipcRenderer.invoke('brain:open-note-file', id),

  onEvent: (cb: (e: unknown) => void) => {
    const handler = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on('brain:event', handler);
    return () => ipcRenderer.off('brain:event', handler);
  },
  onStatus: (cb: (s: unknown) => void) => {
    const handler = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on('brain:status', handler);
    return () => ipcRenderer.off('brain:status', handler);
  },
  onVaultChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('brain:vault-changed', handler);
    return () => ipcRenderer.off('brain:vault-changed', handler);
  }
};

contextBridge.exposeInMainWorld('brain', api);
export type BrainApi = typeof api;
