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
  queue: { total: number; done: number; failed: number; pending: number };
}
type BrainEvent =
  | { type: 'considered'; noteIds: string[]; query: string; at: number }
  | { type: 'opened'; noteIds: string[]; at: number }
  | { type: 'saved'; noteIds: string[]; at: number }
  | { type: 'vault-changed'; at: number }
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
      deleteNote(id: string): Promise<boolean>;
      revealVault(): Promise<void>;
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

function logActivity(e: BrainEvent): void {
  const el = $('activity-inner');
  let cls = '';
  let text = '';

  switch (e.type) {
    case 'considered':
      cls = 'ev-considered';
      text = `recalling "${e.query}" - ${e.noteIds.length} memor${e.noteIds.length === 1 ? "y" : "ies"} surfaced`;
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
      cls = e.level === 'error' ? 'ev-error' : '';
      text = e.message;
      break;
    default:
      return;
  }

  el.innerHTML = `<span class="${cls}">${escapeHtml(text)}</span> <span style="opacity:.5">${timeAgo(e.at)}</span>`;
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
  }
  logActivity(e);
});

window.brain.onStatus((s) => renderStatus(s));
window.brain.onVaultChanged(() => void refreshAll());

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeDetail();
    $('settings').classList.add('hidden');
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    e.preventDefault();
    $<HTMLInputElement>('search').focus();
  }
});

void refreshAll();
setInterval(() => void refreshGraph(), 20000);
