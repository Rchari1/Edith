import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/** The renderer's entire view of the main process. Nothing else crosses the bridge. */
const api = {
  status: () => ipcRenderer.invoke('brain:status'),
  graph: () => ipcRenderer.invoke('brain:graph'),
  settings: () => ipcRenderer.invoke('brain:settings'),
  recentEvents: () => ipcRenderer.invoke('brain:recent-events'),
  skills: () => ipcRenderer.invoke('brain:skills'),
  skillTerritories: () => ipcRenderer.invoke('brain:skill-territories'),
  skillOverlaps: () => ipcRenderer.invoke('brain:skill-overlaps'),
  skillFile: (name: string) => ipcRenderer.invoke('brain:skill-file', name),
  saveSkill: (name: string, content: string) => ipcRenderer.invoke('brain:save-skill', name, content),
  openSkillFile: (name: string) => ipcRenderer.invoke('brain:open-skill-file', name),
  note: (id: string) => ipcRenderer.invoke('brain:note', id),
  notes: () => ipcRenderer.invoke('brain:notes'),
  search: (query: string, limit?: number) => ipcRenderer.invoke('brain:search', query, limit),
  updateSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke('brain:update-settings', patch),
  backfill: () => ipcRenderer.invoke('brain:backfill'),
  reregister: () => ipcRenderer.invoke('brain:reregister'),
  unregister: () => ipcRenderer.invoke('brain:unregister'),
  deleteNote: (id: string) => ipcRenderer.invoke('brain:delete-note', id),
  updateNote: (id: string, patch: { title?: string; body?: string }) =>
    ipcRenderer.invoke('brain:update-note', id, patch),
  revealVault: () => ipcRenderer.invoke('brain:reveal-vault'),

  forgeList: () => ipcRenderer.invoke('forge:list'),
  forgeInstalled: () => ipcRenderer.invoke('forge:installed'),
  forgeUpdateInstalled: (id: string, patch: { description?: string; body?: string }) =>
    ipcRenderer.invoke('forge:update-installed', id, patch),
  forgeDeleteInstalled: (id: string) => ipcRenderer.invoke('forge:delete-installed', id),
  forgeAccept: (id: string) => ipcRenderer.invoke('forge:accept', id),
  forgeEdit: (id: string, patch: { title?: string; description?: string; body?: string }) =>
    ipcRenderer.invoke('forge:edit', id, patch),
  forgeReject: (id: string) => ipcRenderer.invoke('forge:reject', id),
  forgeUndo: (id: string) => ipcRenderer.invoke('forge:undo', id),
  onForgeChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('forge:changed', handler);
    return () => ipcRenderer.off('forge:changed', handler);
  },
  pickFiles: () => ipcRenderer.invoke('brain:pick-files'),
  pickFolder: () => ipcRenderer.invoke('brain:pick-folder'),
  importFiles: (files: string[], mode: 'verbatim' | 'distill') =>
    ipcRenderer.invoke('brain:import-files', files, mode),
  importText: (title: string, body: string, mode: 'verbatim' | 'distill') =>
    ipcRenderer.invoke('brain:import-text', title, body, mode),
  openNoteFile: (id: string) => ipcRenderer.invoke('brain:open-note-file', id),

  miniState: () => ipcRenderer.invoke('mini:state'),
  miniEnter: () => ipcRenderer.invoke('mini:enter'),
  miniClose: () => ipcRenderer.invoke('mini:close'),
  miniCollapse: (collapsed: boolean) => ipcRenderer.invoke('mini:collapse', collapsed),
  miniPeek: (on: boolean) => ipcRenderer.invoke('mini:peek', on),
  miniSetWidth: (width: number) => ipcRenderer.invoke('mini:set-width', width),
  miniOpenApp: () => ipcRenderer.invoke('mini:open-app'),
  miniSetAutoShow: (on: boolean) => ipcRenderer.invoke('mini:set-auto-show', on),
  onMiniState: (cb: (s: unknown) => void) => {
    const handler = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on('mini:state', handler);
    return () => ipcRenderer.off('mini:state', handler);
  },

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
