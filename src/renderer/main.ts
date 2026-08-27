import { BrainGraph, type GraphNodeData, type GraphEdgeData } from './graph.js';

interface NoteFrontmatter {
  id: string;
  title: string;
  created: string;
  updated: string;
  sources: Array<{ session: string; project: string; at: string }>;
  links: string[];
  origin: 'distilled' | 'claude' | 'human';
  tags?: string[];
}
interface NoteDto { frontmatter: NoteFrontmatter; body: string; path: string }
interface SearchHit { id: string; title: string; snippet: string; score: number }
interface Status {
  serverUrl: string | null;
  noteCount: number;
  hasApiKey: boolean;
  registrations: Array<{ target: string; status: string; detail?: string }>;
  vaultPath: string;
  watching: string;
  hook: { status: string; configPath: string; detail?: string } | null;
  lastSessionAt: number | null;
  queue: { total: number; done: number; failed: number; pending: number };
}
interface InstalledSkill {
  id: string;
  description: string;
  body: string;
  origin: 'starter' | 'forged';
}

interface Proposal {
  id: string;
  title: string;
  description: string;
  body: string;
  rationale: string;
  sources: string[];
  status: 'proposed' | 'accepted' | 'rejected';
}

type BrainEvent =
  | { type: 'considered'; noteIds: string[]; query: string; at: number }
  | { type: 'opened'; noteIds: string[]; at: number }
  | { type: 'saved'; noteIds: string[]; at: number }
  | { type: 'vault-changed'; at: number }
  | { type: 'session-active'; sessionId: string; project: string; at: number }
  | { type: 'ingest-progress'; done: number; total: number; label: string; at: number }
  | { type: 'status'; message: string; level: 'info' | 'warn' | 'error'; at: number };

declare global {
  interface Window {
    brain: {
      status(): Promise<Status>;
      graph(): Promise<{ nodes: GraphNodeData[]; edges: GraphEdgeData[] }>;
      settings(): Promise<Record<string, unknown>>;
      recentEvents(): Promise<BrainEvent[]>;
      note(id: string): Promise<NoteDto | null>;
      notes(): Promise<NoteDto[]>;
      search(q: string, limit?: number): Promise<SearchHit[]>;
      updateSettings(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
      backfill(): Promise<{ queued: number; skipped: number }>;
      reregister(): Promise<unknown>;
      forgeList(): Promise<{ proposals: Proposal[]; counts: { proposed: number } }>;
      forgeInstalled(): Promise<InstalledSkill[]>;
      forgeUpdateInstalled(id: string, patch: { description?: string; body?: string }): Promise<InstalledSkill | null>;
      forgeDeleteInstalled(id: string): Promise<{ ok: boolean; detail?: string }>;
      forgeAccept(id: string): Promise<{ ok: boolean; detail?: string }>;
      forgeReject(id: string): Promise<{ ok: boolean }>;
      forgeUndo(id: string): Promise<{ ok: boolean; detail?: string }>;
      onForgeChanged(cb: () => void): () => void;
      deleteNote(id: string): Promise<boolean>;
      updateNote(id: string, patch: { title?: string; body?: string }): Promise<NoteDto | null>;
      reregister(): Promise<unknown>;
      forgeList(): Promise<{ proposals: Proposal[]; counts: { proposed: number } }>;
      forgeInstalled(): Promise<InstalledSkill[]>;
      forgeUpdateInstalled(id: string, patch: { description?: string; body?: string }): Promise<InstalledSkill | null>;
      forgeDeleteInstalled(id: string): Promise<{ ok: boolean; detail?: string }>;
      forgeAccept(id: string): Promise<{ ok: boolean; detail?: string }>;
      forgeReject(id: string): Promise<{ ok: boolean }>;
      forgeUndo(id: string): Promise<{ ok: boolean; detail?: string }>;
      onForgeChanged(cb: () => void): () => void;
      revealVault(): Promise<void>;
      pickFiles(): Promise<string[]>;
      importFiles(files: string[], mode: 'verbatim' | 'distill'): Promise<{
        imported: number; skipped: number; failed: number;
        results: Array<{ file: string; id?: string; status: string; detail?: string }>;
      }>;
      importText(title: string, body: string, mode: 'verbatim' | 'distill'): Promise<{ ids: string[] }>;
      openNoteFile(id: string): Promise<void>;
      onEvent(cb: (e: BrainEvent) => void): () => void;
      onStatus(cb: (s: Status) => void): () => void;
      onVaultChanged(cb: () => void): () => void;
    };
  }
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const graph = new BrainGraph($<HTMLCanvasElement>('graph'));
let allNotes: NoteDto[] = [];
let selectedId: string | null = null;

/* ---------------- rendering helpers ---------------- */

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
  );
}

/** Deliberately minimal markdown. Escape first, then add a few safe affordances. */
function renderMarkdown(md: string): string {
  return escapeHtml(md)
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h3>$1</h3>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/* ---------------- note list ---------------- */

function renderNoteList(notes: NoteDto[], hits?: SearchHit[]): void {
  const list = $('note-list');
  list.innerHTML = '';

  if (notes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = hits ? 'No matches.' : 'No memories yet.';
    list.appendChild(empty);
    return;
  }

  const snippetById = new Map((hits ?? []).map((h) => [h.id, h.snippet]));

  for (const note of notes) {
    const f = note.frontmatter;
    const item = document.createElement('div');
    item.className = `note-item origin-${f.origin}${f.id === selectedId ? ' active' : ''}`;

    const title = document.createElement('span');
    title.className = 't';
    title.textContent = f.title;
    item.appendChild(title);

    const meta = document.createElement('span');
    meta.className = 'm';
    // A single source is the default case - only a woven note earns a count.
    meta.textContent =
      f.sources.length > 1 ? `${f.updated} · ${f.sources.length} memories` : f.updated;
    item.appendChild(meta);

    const snip = snippetById.get(f.id);
    if (snip) {
      const s = document.createElement('span');
      s.className = 'snip';
      s.textContent = snip.replace(/\s+/g, ' ').trim();
      item.appendChild(s);
    }

    item.addEventListener('click', () => {
      void selectNote(f.id);
      graph.focus(f.id);
    });
    // Hovering a file lights up its particle and the path it is about to travel.
    item.addEventListener('mouseenter', () => graph.preview(f.id));
    item.addEventListener('mouseleave', () => graph.preview(null));
    list.appendChild(item);
  }
}

/* ---------------- detail panel ---------------- */

async function selectNote(id: string): Promise<void> {
  const note = await window.brain.note(id);
  if (!note) return;
  selectedId = id;
  graph.selected = id;

  const f = note.frontmatter;
  $('detail-title').textContent = f.title;

  const meta = $('detail-meta');
  meta.innerHTML = '';
  const line1 = document.createElement('div');
  line1.innerHTML = `<code>${escapeHtml(f.id)}</code> &middot; ${escapeHtml(f.origin)} &middot; updated ${escapeHtml(f.updated)}`;
  meta.appendChild(line1);

  if (f.sources.length) {
    const line2 = document.createElement('div');
    line2.textContent = `Woven from ${f.sources.length} memor${f.sources.length === 1 ? 'y' : 'ies'}: ${f.sources
      .map((s) => s.project.replace(/^-Users-[^-]+-?/, '') || 'home')
      .join(', ')}`;
    meta.appendChild(line2);
  }

  if (f.links.length) {
    const line3 = document.createElement('div');
    line3.style.marginTop = '5px';
    for (const link of f.links) {
      const chip = document.createElement('span');
      const exists = allNotes.some((n) => n.frontmatter.id === link);
      chip.className = `link-chip${exists ? '' : ' missing'}`;
      chip.textContent = link;
      if (exists) {
        chip.addEventListener('click', () => {
          void selectNote(link);
          graph.focus(link);
        });
      }
      line3.appendChild(chip);
    }
    meta.appendChild(line3);
  }

  currentBody = note.body;
  currentTitle = f.title;
  if (editing) setEditing(false);
  $('detail-body').innerHTML = renderMarkdown(note.body);
  $('detail').classList.remove('hidden');
  renderNoteList(allNotes);
}

function closeDetail(): void {
  $('detail').classList.add('hidden');
  selectedId = null;
  graph.selected = null;
  renderNoteList(allNotes);
}

/* ---------------- status ---------------- */

function renderStatus(s: Status): void {
  // The status block was removed from the sidebar; keep this as a no-op guard
  // so status pushes from the main process stay harmless.
  if (!document.getElementById('s-server')) return;
  $('s-server').textContent = s.serverUrl ? s.serverUrl.replace('http://127.0.0.1:', ':') : 'offline';
  $('s-server').className = `v ${s.serverUrl ? 'good' : 'bad'}`;

  $('s-notes').textContent = String(s.noteCount);

  const registered = s.registrations.filter((r) => r.status === 'registered' || r.status === 'already-current');
  const failed = s.registrations.filter((r) => r.status === 'failed');
  const regEl = $('s-reg');
  if (failed.length) {
    regEl.textContent = `${failed.length} failed`;
    regEl.className = 'v bad';
  } else if (registered.length) {
    regEl.textContent = registered.map((r) => r.target.replace('Claude ', '')).join(', ');
    regEl.className = 'v good';
  } else {
    regEl.textContent = 'none found';
    regEl.className = 'v warn';
  }

  const q = s.queue;
  const queueEl = $('s-queue');
  if (!s.hasApiKey) {
    queueEl.textContent = 'no API key';
    queueEl.className = 'v warn';
  } else if (q.pending > 0) {
    queueEl.textContent = `${q.done}/${q.total}`;
    queueEl.className = 'v';
  } else if (q.failed > 0) {
    queueEl.textContent = `${q.failed} failed`;
    queueEl.className = 'v bad';
  } else {
    queueEl.textContent = 'idle';
    queueEl.className = 'v';
  }
}

/* ---------------- activity ---------------- */

/* ---------------- presence ---------------- */

let presenceTimer: number | undefined;
let detailTimer: number | undefined;

/**
 * Is Claude working right now?
 *
 * Driven by transcript writes, which Claude Code emits at turn boundaries -
 * so this pulses per turn rather than streaming, and lapses to standby after
 * a quiet period rather than the instant a turn ends.
 */
function setPresence(active: boolean): void {
  const el = $('presence');
  el.classList.toggle('active', active);
  $('presence-text').textContent = active ? 'Edith active' : 'Edith on standby';

  window.clearTimeout(presenceTimer);
  if (active) {
    presenceTimer = window.setTimeout(() => setPresence(false), 45000);
  }
}

/* ---------------- activity ---------------- */

/**
 * Only things the user would actually want to see. Routine lifecycle chatter
 * ("Edith ready", "Session settled: ...") is noise next to a presence light
 * that already says the same thing, so info-level status is dropped.
 */
function logActivity(e: BrainEvent): void {
  const el = $('activity-inner');
  let cls = '';
  let text = '';

  switch (e.type) {
    case 'considered':
      cls = 'ev-considered';
      text = `recalling "${e.query}" - ${e.noteIds.length} memor${e.noteIds.length === 1 ? 'y' : 'ies'} surfaced`;
      break;
    case 'opened':
      cls = 'ev-opened';
      text = `opened ${e.noteIds.join(', ')}`;
      break;
    case 'saved':
      cls = 'ev-saved';
      text = `saved ${e.noteIds.join(', ')}`;
      break;
    case 'ingest-progress':
      text = `${e.label} ${e.done}/${e.total}`;
      break;
    case 'status':
      // The presence light covers "something is happening"; only surface
      // things the user may need to act on.
      if (e.level === 'info') return;
      cls = e.level === 'error' ? 'ev-error' : '';
      text = e.message;
      break;
    default:
      return;
  }

  el.classList.remove('faded');
  el.innerHTML = `<span class="${cls}">${escapeHtml(text)}</span> <span style="opacity:.5">${timeAgo(e.at)}</span>`;

  // Let it fade back to the presence line rather than leaving a stale message.
  window.clearTimeout(detailTimer);
  detailTimer = window.setTimeout(() => el.classList.add('faded'), 9000);
}


/* ---------------- data loading ---------------- */

async function refreshGraph(): Promise<void> {
  const g = await window.brain.graph();
  graph.setData(g.nodes, g.edges);
  renderCatLegend();
  $('empty').classList.toggle('hidden', g.nodes.length > 0);
}

/** Category chips: click to spotlight a cluster, click again to release it. */
function renderCatLegend(): void {
  const el = $('legend-cats');
  el.innerHTML = '';
  for (const c of graph.categories()) {
    const chip = document.createElement('button');
    chip.className = `cat-chip${graph.highlight === c.name ? ' active' : ''}`;
    chip.style.setProperty('--c', c.color);
    const dot = document.createElement('i');
    const label = document.createElement('span');
    label.textContent = c.name;
    const count = document.createElement('em');
    count.textContent = String(c.count);
    chip.append(dot, label, count);
    chip.addEventListener('click', () => {
      graph.setHighlight(graph.highlight === c.name ? null : c.name);
      renderCatLegend();
    });
    el.appendChild(chip);
  }
}

async function refreshAll(): Promise<void> {
  allNotes = await window.brain.notes();
  renderNoteList(allNotes);
  await refreshGraph();
  renderStatus(await window.brain.status());
}

/* ---------------- wiring ---------------- */

graph.onSelect = (id) => {
  if (id) void selectNote(id);
  else closeDetail();
};

graph.onHover = (node, x, y) => {
  const tip = $('tooltip');
  if (!node) {
    tip.classList.add('hidden');
    return;
  }
  tip.innerHTML = `<div>${escapeHtml(node.title)}</div><div class="tt-meta">${
    node.missing ? 'not written yet' : `${node.sourceCount} memor${node.sourceCount === 1 ? 'y' : 'ies'} - ${node.degree} link(s)`
  }</div>`;
  tip.style.left = `${x + 14}px`;
  tip.style.top = `${y + 14}px`;
  tip.classList.remove('hidden');
};

let searchTimer: number | undefined;
$<HTMLInputElement>('search').addEventListener('input', (e) => {
  const q = (e.target as HTMLInputElement).value.trim();
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(async () => {
    if (!q) {
      renderNoteList(allNotes);
      return;
    }
    const hits = await window.brain.search(q, 30);
    const byId = new Map(allNotes.map((n) => [n.frontmatter.id, n]));
    const matched = hits.map((h) => byId.get(h.id)).filter((n): n is NoteDto => Boolean(n));
    renderNoteList(matched, hits);
  }, 140);
});

$('detail-close').addEventListener('click', closeDetail);

$('btn-open-file').addEventListener('click', () => {
  if (selectedId) void window.brain.openNoteFile(selectedId);
});

$('btn-delete').addEventListener('click', async () => {
  if (!selectedId) return;
  if (!window.confirm(`Delete "${selectedId}"? The markdown file is removed from disk.`)) return;
  await window.brain.deleteNote(selectedId);
  closeDetail();
  await refreshAll();
});

$('btn-vault').addEventListener('click', () => void window.brain.revealVault());

$('btn-backfill').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('btn-backfill');
  btn.disabled = true;
  btn.textContent = 'Scanning';
  try {
    const r = await window.brain.backfill();
    logActivity({
      type: 'status',
      message: `Backfill queued ${r.queued} session(s), skipped ${r.skipped}`,
      level: 'info',
      at: Date.now()
    });
  } finally {
    btn.disabled = false;
    btn.textContent = 'Backfill';
  }
});

/* ---------------- import ---------------- */

let pendingFiles: string[] = [];

function importMode(): 'verbatim' | 'distill' {
  const checked = document.querySelector<HTMLInputElement>('input[name="imode"]:checked');
  return checked?.value === 'distill' ? 'distill' : 'verbatim';
}

function importMessage(msg: string, kind: 'info' | 'good' | 'bad' = 'info'): void {
  const el = $('import-msg');
  el.textContent = msg;
  el.className = `import-msg${kind === 'info' ? '' : ` ${kind}`}`;
  el.classList.remove('hidden');
}

function renderPendingFiles(): void {
  const box = $('import-files');
  box.innerHTML = '';
  if (pendingFiles.length === 0) {
    box.classList.add('hidden');
    return;
  }
  for (const f of pendingFiles) {
    const row = document.createElement('div');
    row.textContent = f.split('/').pop() ?? f;
    box.appendChild(row);
  }
  box.classList.remove('hidden');
}

function resetImport(): void {
  pendingFiles = [];
  renderPendingFiles();
  $<HTMLInputElement>('import-title').value = '';
  $<HTMLTextAreaElement>('import-body').value = '';
  $('import-msg').classList.add('hidden');
  const verbatim = document.querySelector<HTMLInputElement>('input[name="imode"][value="verbatim"]');
  if (verbatim) verbatim.checked = true;
}

$('btn-import').addEventListener('click', async () => {
  resetImport();
  // Distilling needs an API key; make that visible rather than failing later.
  const status = await window.brain.status();
  const distillLabel = document.querySelector<HTMLLabelElement>('.mode-choice label.row:nth-child(2)');
  const distillInput = document.querySelector<HTMLInputElement>('input[name="imode"][value="distill"]');
  if (distillInput) distillInput.disabled = !status.hasApiKey;
  distillLabel?.classList.toggle('disabled', !status.hasApiKey);
  if (!status.hasApiKey) importMessage('Add an API key in Settings to distill. Files can still be imported as written.');
  $('import').classList.remove('hidden');
});

$('import-pick').addEventListener('click', async () => {
  const files = await window.brain.pickFiles();
  if (files.length) {
    pendingFiles = files;
    renderPendingFiles();
    $('import-msg').classList.add('hidden');
  }
});

$('import-cancel').addEventListener('click', () => $('import').classList.add('hidden'));

$('import-go').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('import-go');
  const title = $<HTMLInputElement>('import-title').value;
  const body = $<HTMLTextAreaElement>('import-body').value;
  const mode = importMode();

  if (pendingFiles.length === 0 && !body.trim()) {
    importMessage('Choose a file or paste some text first.', 'bad');
    return;
  }

  btn.disabled = true;
  btn.textContent = mode === 'distill' ? 'Distilling…' : 'Adding…';
  try {
    const parts: string[] = [];
    if (pendingFiles.length) {
      const r = await window.brain.importFiles(pendingFiles, mode);
      parts.push(`${r.imported} note(s) from ${pendingFiles.length} file(s)`);
      if (r.skipped) parts.push(`${r.skipped} skipped`);
      if (r.failed) parts.push(`${r.failed} failed`);
    }
    if (body.trim()) {
      const r = await window.brain.importText(title, body, mode);
      parts.push(`${r.ids.length} note(s) from pasted text`);
    }
    importMessage(`Added ${parts.join(', ')}.`, 'good');
    pendingFiles = [];
    renderPendingFiles();
    $<HTMLTextAreaElement>('import-body').value = '';
    $<HTMLInputElement>('import-title').value = '';
    await refreshAll();
  } catch (err) {
    importMessage(err instanceof Error ? err.message : String(err), 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add to brain';
  }
});

/* settings modal */
$('btn-settings').addEventListener('click', async () => {
  const s = await window.brain.settings();
  $<HTMLInputElement>('set-key').value = String(s.apiKey ?? '');
  $<HTMLInputElement>('set-model').value = String(s.model ?? '');
  $<HTMLInputElement>('set-minturns').value = String(s.minTurns ?? 4);
  $<HTMLInputElement>('set-auto').checked = Boolean(s.autoDistill);
  $('settings').classList.remove('hidden');
});

$('set-cancel').addEventListener('click', () => $('settings').classList.add('hidden'));

$('set-save').addEventListener('click', async () => {
  await window.brain.updateSettings({
    apiKey: $<HTMLInputElement>('set-key').value.trim(),
    model: $<HTMLInputElement>('set-model').value.trim(),
    minTurns: Number($<HTMLInputElement>('set-minturns').value) || 4,
    autoDistill: $<HTMLInputElement>('set-auto').checked
  });
  $('settings').classList.add('hidden');
  renderStatus(await window.brain.status());
});

/* live events - this is the lighting up */
let legendTimer: number | undefined;
/** The state legend appears only while something is actually lit. */
function showStateLegend(): void {
  const el = document.querySelector('.legend-row.states');
  if (!el) return;
  el.classList.add('visible');
  window.clearTimeout(legendTimer);
  legendTimer = window.setTimeout(() => el.classList.remove('visible'), 32000);
}

/* ---------------- inline editing ---------------- */

let editing = false;
let currentBody = '';
let currentTitle = '';

function setEditing(on: boolean): void {
  editing = on;
  const title = $('detail-title');
  $('detail-body').classList.toggle('hidden', on);
  $('detail-editor').classList.toggle('hidden', !on);
  $('detail-actions-view').classList.toggle('hidden', on);
  $('detail-actions-edit').classList.toggle('hidden', !on);
  title.setAttribute('contenteditable', String(on));
  title.classList.toggle('editing', on);

  if (on) {
    const ta = $<HTMLTextAreaElement>('detail-editor');
    ta.value = currentBody;
    ta.focus();
  }
}

async function saveEdit(): Promise<void> {
  if (!selectedId) return;
  const body = $<HTMLTextAreaElement>('detail-editor').value;
  const title = ($('detail-title').textContent ?? '').trim();
  const updated = await window.brain.updateNote(selectedId, { title, body });
  if (updated) {
    currentBody = updated.body;
    $('detail-body').innerHTML = renderMarkdown(updated.body);
  }
  setEditing(false);
  await refreshAll();
}

$('btn-edit').addEventListener('click', () => setEditing(true));
$('btn-edit-cancel').addEventListener('click', () => {
  $('detail-title').textContent = currentTitle;
  setEditing(false);
});
$('btn-edit-save').addEventListener('click', () => void saveEdit());

/* ---------------- connection panel ---------------- */

function relTime(ts: number | null): string {
  if (!ts) return 'not yet';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function connRow(k: string, v: string, cls = ''): string {
  return `<div class="conn-row"><span class="conn-k">${escapeHtml(k)}</span><span class="conn-v ${cls}">${escapeHtml(v)}</span></div>`;
}

async function openConnection(): Promise<void> {
  const s = await window.brain.status();
  const registered = s.registrations.filter(
    (r) => r.status === 'registered' || r.status === 'already-current'
  );
  const failed = s.registrations.filter((r) => r.status === 'failed');
  const hookOk = s.hook && (s.hook.status === 'registered' || s.hook.status === 'already-current');

  const rows = [
    connRow('Server', s.serverUrl ?? 'offline', s.serverUrl ? 'ok' : 'bad'),
    connRow(
      'Claude',
      failed.length
        ? `${failed.length} failed`
        : registered.length
          ? registered.map((r) => r.target).join(', ')
          : 'none found',
      failed.length ? 'bad' : registered.length ? 'ok' : 'warn'
    ),
    connRow(
      'Session primer',
      hookOk ? 'installed' : s.hook ? s.hook.status : 'not installed',
      hookOk ? 'ok' : 'warn'
    ),
    connRow('Last session', relTime(s.lastSessionAt), s.lastSessionAt ? '' : 'warn'),
    connRow('Memories', String(s.noteCount)),
    connRow('Watching', s.watching),
    connRow('Vault', s.vaultPath)
  ].join('');

  $('conn-rows').innerHTML = rows;

  const note = document.createElement('div');
  note.className = 'conn-note';
  note.textContent = hookOk
    ? 'Changes to registration only take effect in a new Claude session. Restart Claude Code if something looks stale.'
    : 'Without the session primer Claude will rarely consult Edith on its own.';
  $('conn-rows').appendChild(note);

  $('connection').classList.remove('hidden');
}

$('presence').addEventListener('click', () => void openConnection());
$('conn-close').addEventListener('click', () => $('connection').classList.add('hidden'));
$('conn-reregister').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('conn-reregister');
  btn.disabled = true;
  try {
    await window.brain.reregister();
    await openConnection();
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- the forge ---------------- */

let queue: Proposal[] = [];
let cursor = 0;
let deciding = false;

function currentProposal(): Proposal | undefined {
  return queue[cursor];
}

function paintCard(): void {
  const p = currentProposal();
  const hasAny = queue.length > 0 && p;

  $('deck').classList.toggle('hidden', !hasAny);
  $('forge-actions').classList.toggle('hidden', !hasAny);
  $('forge-empty').classList.toggle('hidden', Boolean(hasAny));
  $('forge-actions').classList.toggle('hidden', !hasAny);
  $('forge-progress').textContent = hasAny ? `${cursor + 1} of ${queue.length}` : 'nothing waiting';

  if (!p) return;

  $('forge-name').textContent = p.title;
  $('forge-desc').textContent = p.description;
  $('forge-why').textContent = p.rationale;
  $('forge-body').textContent = p.body;
  $('forge-src').textContent = p.sources.length
    ? `drawn from ${p.sources.join(', ')}`
    : '';

  const card = $('forge-card');
  card.classList.remove('out-left', 'out-right', 'in');
  // Reflow so the animation replays for each new card.
  void card.offsetWidth;
  card.classList.add('in');
}

/* ---------------- installed skills ---------------- */

let editingSkill: InstalledSkill | null = null;

async function loadInstalled(): Promise<void> {
  const skills = await window.brain.forgeInstalled();
  const list = $('installed-list');
  list.innerHTML = '';
  $('installed-count').textContent = skills.length
    ? `${skills.length} skill${skills.length === 1 ? '' : 's'}`
    : '';

  if (skills.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'installed-empty';
    empty.textContent = 'No skills installed yet.';
    list.appendChild(empty);
    return;
  }

  for (const skill of skills) {
    const row = document.createElement('div');
    row.className = 'installed-row';

    // One dot, one meaning: Edith installed this and Edith can remove it.
    const who = document.createElement('span');
    who.className = 'who';
    row.appendChild(who);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = `/${skill.id}`;
    const desc = document.createElement('div');
    desc.className = 'desc';
    desc.textContent = skill.description;
    meta.append(name, desc);
    row.appendChild(meta);

    // Origin is a detail, so it is a quiet label that yields to the actions on
    // hover - not a colour difference that reads as one skill being lesser.
    const origin = document.createElement('span');
    origin.className = 'origin';
    origin.textContent = skill.origin === 'starter' ? 'built in' : 'forged';
    row.appendChild(origin);

    const actions = document.createElement('div');
    actions.className = 'row-actions';

    const edit = document.createElement('button');
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => openSkillEditor(skill));

    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (!window.confirm(`Delete /${skill.id}? Claude will no longer have this skill.`)) return;
      const r = await window.brain.forgeDeleteInstalled(skill.id);
      if (!r.ok) {
        logActivity({
          type: 'status',
          message: `Could not delete /${skill.id}: ${r.detail ?? 'unknown error'}`,
          level: 'error',
          at: Date.now()
        });
      }
      await loadInstalled();
    });

    actions.append(edit, del);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

function openSkillEditor(skill: InstalledSkill): void {
  editingSkill = skill;
  $('skill-edit-name').textContent = `/${skill.id}`;
  $<HTMLInputElement>('skill-edit-desc').value = skill.description;
  $<HTMLTextAreaElement>('skill-edit-body').value = skill.body;
  $('skill-edit').classList.remove('hidden');
}

$('skill-edit-cancel').addEventListener('click', () => {
  $('skill-edit').classList.add('hidden');
  editingSkill = null;
});

$('skill-edit-save').addEventListener('click', async () => {
  if (!editingSkill) return;
  await window.brain.forgeUpdateInstalled(editingSkill.id, {
    description: $<HTMLInputElement>('skill-edit-desc').value,
    body: $<HTMLTextAreaElement>('skill-edit-body').value
  });
  $('skill-edit').classList.add('hidden');
  editingSkill = null;
  await loadInstalled();
});

async function loadForge(): Promise<void> {
  const { proposals, counts } = await window.brain.forgeList();
  queue = proposals.filter((p) => p.status === 'proposed');
  if (cursor >= queue.length) cursor = Math.max(0, queue.length - 1);

  /*
   * The chip is the only way into the forge, and the installed-skills panel
   * lives inside it - so hiding the chip whenever the proposal queue is empty
   * made that panel unreachable, which is the state every user lands in as
   * soon as they finish reviewing. It now appears whenever there is anything
   * to see, and the count badge is only for things still awaiting a decision.
   */
  const installedCount = (await window.brain.forgeInstalled()).length;
  const chip = $('forge-chip');
  chip.classList.toggle('hidden', counts.proposed === 0 && installedCount === 0);
  $('forge-count').textContent = counts.proposed > 0 ? String(counts.proposed) : '';
  chip.title =
    counts.proposed > 0
      ? `${counts.proposed} skill(s) to review`
      : `${installedCount} installed skill(s)`;

  if (!$('forge').classList.contains('hidden')) paintCard();
}

/** Fly the card out, then resolve the decision. The animation is the feedback. */
async function decide(verdict: 'accept' | 'reject' | 'skip'): Promise<void> {
  const p = currentProposal();
  if (!p || deciding) return;
  deciding = true;

  const card = $('forge-card');
  if (verdict !== 'skip') {
    card.classList.add(verdict === 'accept' ? 'out-right' : 'out-left');
    await new Promise((r) => setTimeout(r, 300));
  }

  try {
    if (verdict === 'accept') {
      const r = await window.brain.forgeAccept(p.id);
      if (!r.ok) {
        // Put the card back and say why, rather than silently swallowing it.
        card.classList.remove('out-right');
        logActivity({
          type: 'status',
          message: `Could not forge "${p.title}": ${r.detail ?? 'unknown error'}`,
          level: 'error',
          at: Date.now()
        });
        return;
      }
    } else if (verdict === 'reject') {
      await window.brain.forgeReject(p.id);
    } else {
      cursor = (cursor + 1) % Math.max(1, queue.length);
    }
    await loadForge();
    paintCard();
  } finally {
    deciding = false;
  }
}

function openForge(): void {
  cursor = 0;
  $('forge').classList.remove('hidden');
  void loadInstalled();
  void loadForge().then(paintCard);
}

$('forge-chip').addEventListener('click', openForge);
$('forge-close').addEventListener('click', () => $('forge').classList.add('hidden'));
$('forge-accept').addEventListener('click', () => void decide('accept'));
$('forge-reject').addEventListener('click', () => void decide('reject'));
$('forge-skip').addEventListener('click', () => void decide('skip'));

window.brain.onForgeChanged(() => {
  void loadForge();
  void loadInstalled();
});

window.brain.onEvent((e) => {
  if (e.type === 'considered') {
    graph.activate(e.noteIds, 'considered');
    showStateLegend();
  } else if (e.type === 'opened') {
    graph.activate(e.noteIds, 'opened');
    showStateLegend();
    // The camera follows Claude's attention.
    if (e.noteIds[0]) graph.focus(e.noteIds[0]);
  } else if (e.type === 'saved') {
    graph.activate(e.noteIds, 'saved');
    showStateLegend();
  } else if (e.type === 'session-active') {
    setPresence(true);
  }

  // Any brain traffic at all means Claude is working right now.
  if (e.type === 'considered' || e.type === 'opened' || e.type === 'saved') setPresence(true);

  logActivity(e);
});

window.brain.onStatus((s) => renderStatus(s));
window.brain.onVaultChanged(() => void refreshAll());

window.addEventListener('keydown', (e) => {
  // Scoped to the forge so arrow keys never interfere with the graph.
  if (!$('forge').classList.contains('hidden')) {
    if (e.key === 'ArrowRight') { e.preventDefault(); void decide('accept'); return; }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); void decide('reject'); return; }
    if (e.key === 'ArrowDown')  { e.preventDefault(); void decide('skip'); return; }
    if (e.key === 'Escape')     { $('forge').classList.add('hidden'); return; }
  }
  if (e.key === 'Escape' && editing) {
    $('detail-title').textContent = currentTitle;
    setEditing(false);
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 's' && editing) {
    e.preventDefault();
    void saveEdit();
    return;
  }
  if (e.key === 'Escape') {
    closeDetail();
    $('connection').classList.add('hidden');
    $('settings').classList.add('hidden');
    $('import').classList.add('hidden');
    $('forge').classList.add('hidden');
    $('skill-edit').classList.add('hidden');
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    e.preventDefault();
    $<HTMLInputElement>('search').focus();
  }
});

void refreshAll();
void loadForge();
setInterval(() => void refreshGraph(), 20000);
