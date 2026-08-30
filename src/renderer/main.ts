import { BrainGraph, type GraphNodeData, type GraphEdgeData } from './graph.js';
import katex from 'katex';
import 'katex/dist/katex.min.css';

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
  | { type: 'skill'; skill: string; noteIds: string[]; query: string; at: number }
  | { type: 'opened'; noteIds: string[]; at: number }
  | { type: 'saved'; noteIds: string[]; at: number }
  | { type: 'vault-changed'; at: number }
  | { type: 'session-active'; sessionId: string; project: string; at: number }
  | { type: 'ingest-progress'; done: number; total: number; label: string; at: number }
  | { type: 'status'; message: string; level: 'info' | 'warn' | 'error'; at: number };

type SkillShape = 'chain' | 'loop' | 'hub' | 'spiral';

/** Where a skill keeps working, accumulated across runs. */
interface SkillTerritory {
  skill: string;
  runs: number;
  lastAt: number;
  notes: Array<{ id: string; weight: number }>;
}

/** A skill as declared on disk, mirroring core/skills. */
interface SkillDef {
  name: string;
  description: string;
  shape: SkillShape;
  path: string;
  scope: 'project' | 'user';
  project: string | null;
}

declare global {
  interface Window {
    brain: {
      status(): Promise<Status>;
      graph(): Promise<{
        nodes: GraphNodeData[];
        edges: GraphEdgeData[];
        galaxies: Array<{ id: string; noteIds: string[] }>;
      }>;
      settings(): Promise<Record<string, unknown>>;
      recentEvents(): Promise<BrainEvent[]>;
      skills(): Promise<SkillDef[]>;
      skillTerritories(): Promise<SkillTerritory[]>;
      skillOverlaps(): Promise<Array<{ id: string; skills: string[]; weight: number }>>;
      skillFile(name: string): Promise<(SkillDef & { content: string }) | null>;
      saveSkill(name: string, content: string): Promise<boolean>;
      openSkillFile(name: string): Promise<void>;
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
      forgeEdit(id: string, patch: { title?: string; description?: string; body?: string }): Promise<Proposal | null>;
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
      forgeEdit(id: string, patch: { title?: string; description?: string; body?: string }): Promise<Proposal | null>;
      forgeReject(id: string): Promise<{ ok: boolean }>;
      forgeUndo(id: string): Promise<{ ok: boolean; detail?: string }>;
      onForgeChanged(cb: () => void): () => void;
      revealVault(): Promise<void>;
      pickFiles(): Promise<string[]>;
      pickFolder(): Promise<string[]>;
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
/** Non-null when the detail panel is showing a SKILL.md rather than a note. */
let selectedSkill: string | null = null;

/* ---------------- rendering helpers ---------------- */

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
  );
}

/** Deliberately minimal markdown. Escape first, then add a few safe affordances. */
/**
 * Render TeX with KaTeX. Bundled rather than loaded from a CDN because the
 * renderer's CSP is `script-src 'self'` - and because the brain has to work
 * with no network at all.
 */
function renderTex(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'html' });
  } catch {
    // A malformed expression should cost its own line, not the whole note.
    return `<code class="tex-bad">${escapeHtml(tex)}</code>`;
  }
}

function renderMarkdown(md: string): string {
  // Math comes out first: escapeHtml would mangle its backslashes and angle
  // brackets, and the code/bold passes would chew through it. Placeholders use
  // NUL so nothing downstream can match or escape them.
  const math: string[] = [];
  const stash = (tex: string, display: boolean): string =>
    `\u0000M${math.push(renderTex(tex, display)) - 1}\u0000`;

  const pulled = md
    // Swallow the blank lines around a display block: the body is pre-wrap, so
    // they would render on top of KaTeX's own block margin and double the gap.
    .replace(/[ \t]*\n{0,2}[ \t]*\$\$([\s\S]+?)\$\$[ \t]*\n{0,2}[ \t]*/g, (_m, tex: string) =>
      stash(tex.trim(), true)
    )
    // Single $ only when it neither abuts another $ nor spans a line break,
    // so prose like "$5" or "a $ b" is left alone.
    .replace(/(?<![$\\])\$([^$\n]+?)\$(?!\$)/g, (_m, tex: string) => stash(tex.trim(), false));

  const html = escapeHtml(pulled)
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h3>$1</h3>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  return html.replace(/\u0000M(\d+)\u0000/g, (_m, i: string) => math[Number(i)] ?? '');
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
  selectedSkill = null;
  $('btn-delete').classList.remove('hidden');
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

/** Open a skill's SKILL.md in the same panel notes use, editable the same way. */
async function selectSkill(name: string): Promise<void> {
  const skill = await window.brain.skillFile(name);
  if (!skill) return;

  selectedSkill = name;
  selectedId = null;
  graph.selected = null;

  $('detail-title').textContent = skill.name;

  const meta = $('detail-meta');
  meta.innerHTML = '';
  const line1 = document.createElement('div');
  line1.innerHTML =
    `<code>${escapeHtml(skill.shape)}</code> &middot; ${escapeHtml(skill.scope)} skill` +
    (skill.project ? ` &middot; ${escapeHtml(skill.project.split('/').pop() ?? '')}` : '');
  meta.appendChild(line1);
  const line2 = document.createElement('div');
  line2.style.marginTop = '4px';
  line2.innerHTML = `<code>${escapeHtml(skill.path)}</code>`;
  meta.appendChild(line2);

  // Where this skill keeps working - accumulated over runs, not one search.
  const terr = skillTerritory.get(name);
  if (terr && terr.notes.length > 0) {
    const line3 = document.createElement('div');
    line3.style.marginTop = '6px';
    line3.textContent =
      `Works in ${terr.notes.length} note${terr.notes.length === 1 ? '' : 's'} ` +
      `over ${terr.runs} run${terr.runs === 1 ? '' : 's'}:`;
    meta.appendChild(line3);

    const line4 = document.createElement('div');
    line4.style.marginTop = '5px';
    for (const n of terr.notes.slice(0, 8)) {
      const chip = document.createElement('span');
      chip.className = 'link-chip';
      chip.textContent = n.id;
      chip.title = `weight ${n.weight}`;
      chip.addEventListener('click', () => {
        void selectNote(n.id);
        graph.focus(n.id);
      });
      line4.appendChild(chip);
    }
    meta.appendChild(line4);
  }

  currentBody = skill.content;
  currentTitle = skill.name;
  if (editing) setEditing(false);
  $('detail-body').innerHTML = renderMarkdown(skill.content);
  // A skill's file is Claude's, not the vault's - Edith will not delete it.
  $('btn-delete').classList.add('hidden');
  $('detail').classList.remove('hidden');
  renderSkills();
}

function closeDetail(): void {
  selectedSkill = null;
  $('btn-delete').classList.remove('hidden');
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
let presenceActive = false;

/**
 * One light, painted in two places: the rail's connection icon, and the head
 * of the Connection pane. Kept in a variable so opening the pane can restore
 * the current state rather than waiting for the next event to repaint it.
 *
 * This says whether Claude is *working*, which is a different question from
 * whether it is connected - the rows below answer that. So the banner names
 * its subject and uses working/idle rather than words that read as a link
 * being up or down.
 */
function paintPresence(active: boolean): void {
  $('rail-connection').classList.toggle('live', active);
  $('conn-status').classList.toggle('live', active);
  $('conn-status-text').textContent = active ? 'connected' : 'idle';
  $('conn-status-note').textContent = active ? '' : 'quiet for 45s';
}

function setPresence(active: boolean): void {
  presenceActive = active;
  paintPresence(active);

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
    case 'skill':
      cls = 'ev-considered';
      text = `${e.skill} traced ${e.noteIds.length} node${e.noteIds.length === 1 ? '' : 's'}`;
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
  // Basins are assigned after the bodies exist, so every note has something
  // to be assigned to.
  graph.setGalaxies(g.galaxies);
  renderCatLegend();
  $('empty').classList.toggle('hidden', g.nodes.length > 0);
  await hydrateSkills();
  await loadSkills();
}

/**
 * Rebuild the skills menu from the event history, so a renderer reload does not
 * empty it. The bus keeps its history in the main process for the app's life.
 */
async function hydrateSkills(): Promise<void> {
  try {
    for (const e of await window.brain.recentEvents()) {
      if (e.type === 'skill') void recordSkill();
    }
  } catch {
    // history is a convenience; the menu fills from live events either way
  }
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
  if (selectedSkill) void window.brain.openSkillFile(selectedSkill);
  else if (selectedId) void window.brain.openNoteFile(selectedId);
});

$('btn-delete').addEventListener('click', async () => {
  if (!selectedId) return;
  if (!window.confirm(`Delete "${selectedId}"? The markdown file is removed from disk.`)) return;
  await window.brain.deleteNote(selectedId);
  closeDetail();
  await refreshAll();
});

$('btn-vault').addEventListener('click', () => void window.brain.revealVault());


/* ---------------- import ---------------- */

let pendingFiles: string[] = [];

/**
 * Imports keep the file as written. Distilling costs an API call and the
 * product's whole premise is that you do not need a key - ask Claude to distil
 * instead, or turn on background distilling in Settings.
 */
function importMode(): 'verbatim' | 'distill' {
  return 'verbatim';
}

function importMessage(msg: string, kind: 'info' | 'good' | 'bad' = 'info'): void {
  const el = $('import-msg');
  el.textContent = msg;
  el.className = `import-msg${kind === 'info' ? '' : ` ${kind}`}`;
  el.classList.remove('hidden');
}

/** Extensions the importer can actually read today. */
const SUPPORTED = new Set(['md', 'markdown', 'txt', 'mdx']);

/** Types the UI accepts staging for, but cannot ingest yet. */
const PLANNED = new Set(['pdf', 'docx', 'epub', 'rtf', 'doc', 'pages']);

function renderPendingFiles(): void {
  const box = $('import-files');
  box.innerHTML = '';
  if (pendingFiles.length === 0) {
    box.classList.add('hidden');
    return;
  }

  for (const f of pendingFiles) {
    const name = f.split('/').pop() ?? f;
    const ext = (name.split('.').pop() ?? '').toLowerCase();
    const ok = SUPPORTED.has(ext);

    const row = document.createElement('div');
    row.className = ok ? 'file-row' : 'file-row unsupported';

    const fname = document.createElement('span');
    fname.className = 'fname';
    fname.textContent = name;
    fname.title = f;

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = ext.toUpperCase() || 'FILE';

    const state = document.createElement('span');
    state.className = 'state';
    state.textContent = ok ? 'ready' : PLANNED.has(ext) ? 'not yet' : 'unsupported';

    const drop = document.createElement('button');
    drop.className = 'drop';
    drop.textContent = '\u00d7';
    drop.title = 'Remove';
    drop.addEventListener('click', () => {
      pendingFiles = pendingFiles.filter((p) => p !== f);
      renderPendingFiles();
    });

    row.append(fname, badge, state, drop);
    box.appendChild(row);
  }
  box.classList.remove('hidden');
}

/** Files / Paste / Link. Only one source is offered at a time. */
function showSource(which: 'files' | 'paste' | 'link'): void {
  for (const k of ['files', 'paste', 'link'] as const) {
    $(`pane-${k}`).classList.toggle('hidden', k !== which);
    const tab = $(`src-${k}`);
    tab.classList.toggle('active', k === which);
    tab.setAttribute('aria-selected', String(k === which));
  }
}

$('src-files').addEventListener('click', () => showSource('files'));
$('src-paste').addEventListener('click', () => showSource('paste'));
$('src-link').addEventListener('click', () => showSource('link'));

// Drag and drop stages files the same way the picker does. Electron exposes the
// real path on the dropped File, which is what the importer needs.
const zone = $('import-drop');
for (const ev of ['dragenter', 'dragover'] as const) {
  zone.addEventListener(ev, (e) => {
    e.preventDefault();
    zone.classList.add('dragging');
  });
}
for (const ev of ['dragleave', 'drop'] as const) {
  zone.addEventListener(ev, () => zone.classList.remove('dragging'));
}
zone.addEventListener('drop', (e) => {
  e.preventDefault();
  const dropped = [...((e as DragEvent).dataTransfer?.files ?? [])]
    .map((f) => (f as File & { path?: string }).path)
    .filter((p): p is string => Boolean(p));
  // A dropped folder has no extension and cannot be read here; the picker is
  // the path for those, so say so rather than staging something unusable.
  const looksLikeFolder = dropped.filter((d) => !/\.[a-z0-9]+$/i.test(d));
  stage(dropped.filter((d) => !looksLikeFolder.includes(d)));
  if (looksLikeFolder.length > 0) {
    importMessage('Use "Add a folder instead" to bring in a whole folder.');
  }
});

function resetImport(): void {
  showSource('files');
  pendingFiles = [];
  renderPendingFiles();
  $<HTMLTextAreaElement>('import-body').value = '';
  $('import-msg').classList.add('hidden');
}

$('rail-add').addEventListener('click', async () => {
  resetImport();
  showPane('add');
});

/** Merge a pick into the staged list without duplicating what is already there. */
function stage(files: string[]): void {
  if (files.length === 0) return;
  pendingFiles = [...new Set([...pendingFiles, ...files])];
  renderPendingFiles();
  $('import-msg').classList.add('hidden');
}

$('import-pick-folder').addEventListener('click', async () => {
  const files = await window.brain.pickFolder();
  if (files.length === 0) {
    importMessage('Nothing to read in there \u2014 no .md, .txt or .mdx files.');
    return;
  }
  stage(files);
  importMessage(`Found ${files.length} file${files.length === 1 ? '' : 's'} in that folder.`, 'good');
});

$('import-pick').addEventListener('click', async () => {
  const files = await window.brain.pickFiles();
  if (files.length) {
    pendingFiles = files;
    renderPendingFiles();
    $('import-msg').classList.add('hidden');
  }
});


$('import-go').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('import-go');
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
      const r = await window.brain.importText('', body, mode);
      parts.push(`${r.ids.length} note(s) from pasted text`);
    }
    importMessage(`Added ${parts.join(', ')}.`, 'good');
    pendingFiles = [];
    renderPendingFiles();
    $<HTMLTextAreaElement>('import-body').value = '';
    await refreshAll();
  } catch (err) {
    importMessage(err instanceof Error ? err.message : String(err), 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add';
  }
});

/* settings modal */
/* ---------------- skills ---------------- */

/**
 * Skills that have consulted the brain, newest first. Each keeps the notes its
 * last search touched and the shape it declared, so hovering the pane can
 * re-draw that figure without re-running the search.
 */
const skillsDeclared = new Map<string, SkillDef>();
/** Where each skill keeps working. Accumulated across runs, not one search. */
const skillTerritory = new Map<string, SkillTerritory>();

/** What each shape says about how the skill works. */
const SHAPE_GLYPH: Record<SkillShape, string> = {
  chain: '\u2500\u25CF',
  loop: '\u25EF',
  hub: '\u2733',
  spiral: '\u25CC'
};

const SHAPE_BLURB: Record<SkillShape, string> = {
  chain: 'sequential steps',
  loop: 'returns and repeats',
  hub: 'one idea against each',
  spiral: 'revisited, closer in'
};

/** A run just landed; re-read the territory it folded into. */
async function recordSkill(): Promise<void> {
  await loadTerritories();
  if (!$('skill-list').classList.contains('hidden')) {
    void loadInstalled().then(renderSkills);
    void loadForge();
  }
}

async function loadTerritories(): Promise<void> {
  try {
    skillTerritory.clear();
    for (const t of await window.brain.skillTerritories()) skillTerritory.set(t.skill, t);
  } catch {
    // the pane still lists declared skills without their territories
  }
}

/** Read the declared skills off disk. They exist here before they ever run. */
async function loadSkills(): Promise<void> {
  try {
    for (const s of await window.brain.skills()) skillsDeclared.set(s.name, s);
    await loadTerritories();
  } catch {
    // discovery is a convenience; the pane still fills from live usage
  }
  if (!$('skill-list').classList.contains('hidden')) {
    void loadInstalled().then(renderSkills);
    void loadForge();
  }
}

/** Skills Edith installed, by id - so a row knows whether it can be edited. */
let edithManaged = new Map<string, InstalledSkill>();

/**
 * One list, doing both jobs.
 *
 * Every skill on disk appears here, whether Edith installed it or the user
 * wrote it, because a pane called Skills that hides half of them is lying.
 * Clicking any of them still selects it and lights its territory in the graph.
 * The ones Edith manages additionally offer edit and delete on hover - the
 * others deliberately do not, since offering to delete someone's own work from
 * a list they did not put it in would be a nasty surprise.
 */
function renderSkills(): void {
  const list = $('skill-items');
  list.innerHTML = '';
  $('installed-count').textContent = String(
    new Set([...skillsDeclared.keys(), ...skillTerritory.keys(), ...edithManaged.keys()]).size || ''
  );

  // Everything declared on disk, plus anything with a territory whose
  // SKILL.md we could not find, plus anything Edith has installed.
  const names = new Set([
    ...skillsDeclared.keys(),
    ...skillTerritory.keys(),
    ...edithManaged.keys()
  ]);

  if (names.size === 0) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = 'No skills yet. Ask Claude for one, or write it at .claude/skills/<name>/SKILL.md.';
    list.appendChild(empty);
    return;
  }

  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const def = skillsDeclared.get(name);
    const managed = edithManaged.get(name);

    const item = document.createElement('div');
    item.className = 'skill-item';
    if (def) item.title = def.description;

    const label = document.createElement('span');
    label.className = 'n';
    label.textContent = name;
    item.append(label);

    if (managed) {
      const actions = document.createElement('span');
      actions.className = 'row-actions';

      const edit = document.createElement('button');
      edit.textContent = 'Edit';
      edit.addEventListener('click', (e) => {
        e.stopPropagation(); // the row itself selects; the button must not
        openSkillEditor(managed);
      });

      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = 'Delete';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!window.confirm(`Delete /${name}? Claude will no longer have this skill.`)) return;
        const r = await window.brain.forgeDeleteInstalled(name);
        if (!r.ok) {
          logActivity({
            type: 'status',
            message: `Could not delete /${name}: ${r.detail ?? 'unknown error'}`,
            level: 'error',
            at: Date.now()
          });
        }
        await loadInstalled();
        renderSkills();
      });

      actions.append(edit, del);
      item.append(actions);
    }

    // Declared skills open their SKILL.md; one we only know by name has no file.
    if (def) {
      item.classList.add('openable');
      if (name === selectedSkill) item.classList.add('active');
      item.addEventListener('click', () => void selectSkill(name));
    }
    list.appendChild(item);
  }
}


type Section = 'add' | 'memories' | 'skills' | 'connection';

/** Which section the panel is showing, or null when it is folded away. */
let openSection: Section | null = 'memories';

const SECTION_TITLE: Record<Section, string> = {
  add: 'Add',
  memories: 'Memories',
  skills: 'Skills Forge',
  connection: 'Connection'
};

/**
 * Mount a section in the panel. Passing the section already open folds the
 * panel away instead, which is what pressing its rail button again does.
 */
function showPane(which: Section): void {
  openSection = openSection === which ? null : which;

  $('app').classList.toggle('panel-collapsed', openSection === null);
  for (const k of ['add', 'memories', 'skills', 'connection'] as const) {
    const btn = $(`rail-${k}`);
    btn.classList.toggle('active', openSection === k);
    btn.setAttribute('aria-expanded', String(openSection === k));
  }

  if (openSection === null) {
    graph.setPanelInset(false);
    return;
  }

  $('panel-title').textContent = SECTION_TITLE[openSection];
  // Search belongs to memories; the other sections are short or are forms.
  $('search-wrap').classList.toggle('hidden', openSection !== 'memories');
  $('note-list').classList.toggle('hidden', openSection !== 'memories');
  $('skill-list').classList.toggle('hidden', openSection !== 'skills');
  $('add-pane').classList.toggle('hidden', openSection !== 'add');
  $('connection-pane').classList.toggle('hidden', openSection !== 'connection');
  graph.setPanelInset(true);
  if (openSection === 'skills') renderSkills();
  if (openSection === 'connection') void renderConnection();
}

$('rail-memories').addEventListener('click', () => showPane('memories'));
$('rail-skills').addEventListener('click', () => showPane('skills'));





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
  const body = $<HTMLTextAreaElement>('detail-editor').value;

  // A skill is one whole file - frontmatter included - so it round-trips
  // verbatim rather than being split into title and body the way a note is.
  if (selectedSkill) {
    const ok = await window.brain.saveSkill(selectedSkill, body);
    if (ok) {
      currentBody = body;
      $('detail-body').innerHTML = renderMarkdown(body);
      skillsDeclared.clear();
      await loadSkills(); // frontmatter may have changed the shape
    }
    setEditing(false);
    return;
  }

  if (!selectedId) return;
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

async function renderConnection(): Promise<void> {
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

  // Only say something when something is wrong. When the primer is missing
  // Claude will rarely consult Edith at all, which is worth interrupting for;
  // when everything is healthy the rows above already say so.
  if (!hookOk) {
    const note = document.createElement('div');
    note.className = 'conn-note';
    note.textContent = 'Without the session primer Claude will rarely consult Edith on its own.';
    $('conn-rows').appendChild(note);
  }
  paintPresence(presenceActive);
}

$('rail-connection').addEventListener('click', () => showPane('connection'));
$('conn-reregister').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('conn-reregister');
  btn.disabled = true;
  try {
    await window.brain.reregister();
    await renderConnection();
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

/* ---------------- editing a proposal ---------------- */

let editingCard = false;

/**
 * Swap the card between reading and editing.
 *
 * The draft is usually nearly right, and rejecting something that needed one
 * line changed throws away work Claude already did. Editing stays on the card
 * so the decision does not move somewhere else and come back.
 */
function setCardEditing(on: boolean): void {
  editingCard = on;
  const p = currentProposal();
  if (!p) return;

  $('forge-desc').classList.toggle('hidden', on);
  $('forge-body').classList.toggle('hidden', on);
  $('forge-desc-edit').classList.toggle('hidden', !on);
  $('forge-body-edit').classList.toggle('hidden', !on);
  $('forge-edit').classList.toggle('hidden', on);
  $('forge-edit-done').classList.toggle('hidden', !on);
  $('forge-name').setAttribute('contenteditable', String(on));
  $('forge-name').classList.toggle('editing', on);

  if (on) {
    $<HTMLInputElement>('forge-desc-edit').value = p.description;
    $<HTMLTextAreaElement>('forge-body-edit').value = p.body;
    $<HTMLTextAreaElement>('forge-body-edit').focus();
  }
}

/** Persist the edit and return the card to reading. Forging then installs it. */
async function saveCardEdit(): Promise<void> {
  const p = currentProposal();
  if (!p) return;

  const updated = await window.brain.forgeEdit(p.id, {
    title: ($('forge-name').textContent ?? '').trim(),
    description: $<HTMLInputElement>('forge-desc-edit').value,
    body: $<HTMLTextAreaElement>('forge-body-edit').value
  });

  if (updated) queue[cursor] = updated;
  setCardEditing(false);
  paintCard();
}

$('forge-edit').addEventListener('click', () => setCardEditing(true));
$('forge-edit-done').addEventListener('click', () => void saveCardEdit());

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

  if (editingCard) setCardEditing(false);

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
  edithManaged = new Map(skills.map((s) => [s.id, s]));
}

function openSkillEditor(skill: InstalledSkill): void {
  editingSkill = skill;
  $('skill-edit-name').textContent = `/${skill.id}`;
  $<HTMLInputElement>('skill-edit-desc').value = skill.description;
  $<HTMLTextAreaElement>('skill-edit-body').value = skill.body;
  $('skill-edit').classList.remove('hidden');
}

function closeSkillEditor(): void {
  $('skill-edit').classList.add('hidden');
  editingSkill = null;
}
$('skill-edit-cancel').addEventListener('click', closeSkillEditor);
$('skill-edit-close').addEventListener('click', closeSkillEditor);

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

/**
 * Proposals, listed in the panel beside what is installed.
 *
 * The panel is the forge: what you have and what is waiting, in one place.
 * Reviewing still happens on the deck, because deciding one at a time wants a
 * card that can leave the frame - a row opens the deck at that proposal.
 */
function renderProposed(): void {
  const list = $('proposed-items');
  list.innerHTML = '';
  $('proposed-count').textContent = queue.length ? String(queue.length) : '';

  if (queue.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = 'Nothing waiting.';
    list.appendChild(empty);
    return;
  }

  queue.forEach((p, index) => {
    const item = document.createElement('div');
    item.className = 'skill-item openable proposed';
    item.title = p.description;

    const label = document.createElement('span');
    label.className = 'n';
    label.textContent = p.id;
    item.append(label);

    const go = document.createElement('span');
    go.className = 'review-cue';
    go.textContent = 'Review';
    item.append(go);

    item.addEventListener('click', () => {
      cursor = index;
      openForge();
    });
    list.appendChild(item);
  });
}

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
  renderProposed();

  if (!$('forge').classList.contains('hidden')) paintCard();
}

/** Fly the card out, then resolve the decision. The animation is the feedback. */
async function decide(verdict: 'accept' | 'reject' | 'skip'): Promise<void> {
  const p = currentProposal();
  if (!p || deciding) return;

  // Forging with the editor still open should install what is on screen, not
  // the draft it replaced.
  if (editingCard && verdict === 'accept') await saveCardEdit();
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
  $('forge').classList.remove('hidden');
  void loadInstalled();
  void loadForge().then(paintCard);
}

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
  } else if (e.type === 'skill') {
    graph.traceSkill(e.skill, e.noteIds, skillsDeclared.get(e.skill)?.shape ?? 'chain');
    void recordSkill();
    showStateLegend();
  } else if (e.type === 'session-active') {
    setPresence(true);
  }

  // Any brain traffic at all means Claude is working right now.
  if (e.type === 'considered' || e.type === 'opened' || e.type === 'saved' || e.type === 'skill')
    setPresence(true);

  logActivity(e);
});

window.brain.onStatus((s) => renderStatus(s));
window.brain.onVaultChanged(() => void refreshAll());

window.addEventListener('keydown', (e) => {
  // Scoped to the forge so arrow keys never interfere with the graph.
  if (!$('forge').classList.contains('hidden')) {
    // While editing, arrows belong to the text field.
    if (editingCard && e.key.startsWith('Arrow')) return;
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
    showPane('memories');
    $('forge').classList.add('hidden');
    $('skill-edit').classList.add('hidden');
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    e.preventDefault();
    $<HTMLInputElement>('search').focus();
  }
});

/**
 * The window opens before the main process has finished starting - the vault
 * has to be opened and the server brought up first, and only then are the IPC
 * handlers registered. So the first load can arrive before there is anything
 * to answer it, and the whole refresh rejects on the first call.
 *
 * Retry rather than reorder: showing the window immediately is the right
 * behaviour, and a few hundred milliseconds of patience here costs nothing.
 */
async function firstLoad(): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await refreshAll();
      await loadForge();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  // Out of patience: let the next vault change or the poll below try again.
}

void firstLoad();
setInterval(() => void refreshGraph(), 20000);
