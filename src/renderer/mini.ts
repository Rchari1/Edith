import { BrainGraph, type GraphNodeData, type GraphEdgeData } from './graph.js';
import { TouchedNotes, touchKind } from '@core/mini/touched.js';
import type { BrainEvent, SkillShape } from '@core/types.js';

/** Mirrors MiniState in main/mini.ts. */
interface MiniState {
  visible: boolean;
  collapsed: boolean;
  shape: 'rail' | 'square';
  autoShow: boolean;
  stretchStartedAt: number | null;
}

/** The part of the preload bridge this page uses. */
interface MiniBrain {
  graph(): Promise<{ nodes: GraphNodeData[]; edges: GraphEdgeData[] }>;
  recentEvents(): Promise<BrainEvent[]>;
  skills(): Promise<Array<{ name: string; shape: SkillShape }>>;
  miniState(): Promise<MiniState | null>;
  miniClose(): Promise<void>;
  miniCollapse(collapsed: boolean): Promise<void>;
  miniPeek(on: boolean): Promise<void>;
  miniSetWidth(width: number): Promise<void>;
  miniShape(shape: 'rail' | 'square'): Promise<void>;
  miniOpenApp(): Promise<void>;
  onEvent(cb: (e: BrainEvent) => void): () => void;
  onVaultChanged(cb: () => void): () => void;
  onMiniState(cb: (s: MiniState) => void): () => void;
}

// main.ts owns the global declaration of window.brain, and a second one with a
// different shape would not merge - so this page types its view locally.
const brain = (window as unknown as { brain: MiniBrain }).brain;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** How long the panel unfolds on its own when Claude touches the brain while it is folded. */
const PEEK_MS = 6000;
/** Brushing past the screen edge should not unfold it; resting on it should. */
const HOVER_DELAY_MS = 180;
/** As in the main window, the live light lapses after this long without a signal. */
const LIVE_MS = 45_000;

const graph = new BrainGraph($<HTMLCanvasElement>('mini-graph'), { compact: true, maxFps: 30 });
const touched = new TouchedNotes();
/** Every note in the vault by id, so a touched note can be drawn without asking again. */
let nodes = new Map<string, GraphNodeData>();
let shapes = new Map<string, SkillShape>();
let state: MiniState = { visible: true, collapsed: false, shape: 'rail', autoShow: true, stretchStartedAt: null };
/** The folded strip or the square: nothing but the graph, and a click brings the rail back. */
let ambient = false;

/* ---------------- the notes ---------------- */

async function loadNodes(): Promise<void> {
  const g = await brain.graph();
  nodes = new Map(g.nodes.map((n) => [n.id, n]));
}

/**
 * Draw the whole brain and bring the counts up to date.
 *
 * Every layout draws every note, so the canvas is never an empty black box that
 * needs a sentence laid over it to explain itself. The notes Claude touches light
 * up within it, and the rail's counts say how many.
 */
function redraw(): void {
  graph.setData([...nodes.values()], []);
  const c = touched.counts();
  $('n-considered').textContent = String(c.considered);
  $('n-opened').textContent = String(c.opened);
  $('n-saved').textContent = String(c.saved);
}

/**
 * Rebuild the current stretch of work from the event history, without
 * replaying its glow. Cleared before the fetch rather than after: anything
 * that arrives meanwhile is either in the history too or recorded on arrival.
 */
async function seed(): Promise<void> {
  const since = state.stretchStartedAt ?? Date.now();
  touched.clear();
  for (const e of await brain.recentEvents()) if (e.at >= since) touched.record(e);
  redraw();
}

async function apply(e: BrainEvent): Promise<void> {
  const hit = touched.record(e);
  if (!hit) return;
  // A note saved a moment ago is not in the last snapshot of the vault yet.
  if (hit.ids.some((id) => !nodes.has(id))) await loadNodes();
  redraw();
  if (e.type === 'skill') graph.traceSkill(e.skill, e.noteIds, shapes.get(e.skill) ?? 'chain');
  else graph.activate(hit.ids, hit.kind);
  // The camera follows Claude's attention, as it does in the main window.
  if (e.type === 'opened' && e.noteIds[0]) graph.focus(e.noteIds[0]);
}

/* ---------------- presence ---------------- */

let liveTimer: number | undefined;

function setLive(on: boolean): void {
  $('mini-live').classList.toggle('live', on);
}

function markLive(): void {
  setLive(true);
  window.clearTimeout(liveTimer);
  liveTimer = window.setTimeout(() => setLive(false), LIVE_MS);
}

/* ---------------- folding ---------------- */

let hovering = false;
let peekTimer: number | undefined;

/** Unfold for a while, then fold back - unless the pointer is resting on the panel. */
function peekFor(ms: number): void {
  if (!state.collapsed) return;
  void brain.miniPeek(true);
  window.clearTimeout(peekTimer);
  peekTimer = window.setTimeout(() => {
    if (!hovering) void brain.miniPeek(false);
  }, ms);
}

document.documentElement.addEventListener('mouseenter', () => {
  hovering = true;
  if (!state.collapsed) return;
  window.clearTimeout(peekTimer);
  peekTimer = window.setTimeout(() => {
    if (hovering) void brain.miniPeek(true);
  }, HOVER_DELAY_MS);
});

document.documentElement.addEventListener('mouseleave', () => {
  hovering = false;
  if (!state.collapsed) return;
  window.clearTimeout(peekTimer);
  peekTimer = window.setTimeout(() => {
    if (!hovering) void brain.miniPeek(false);
  }, 300);
});

/**
 * Pick the layout from the real size, so it can never disagree with the bounds
 * mid-animation: a narrow column is the folded strip, a small square is the square.
 */
function fitLayout(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const strip = w < 100;
  const square = !strip && w < 400 && Math.abs(w - h) < 40;
  document.body.classList.toggle('strip', strip);
  document.body.classList.toggle('square', square);
  ambient = strip || square;
  // The canvas has just changed size; fit the shape to it now rather than on the next resize.
  graph.resize();
}

function paintState(): void {
  document.body.classList.toggle('folded', state.collapsed);
  const label = state.collapsed ? 'Keep unfolded' : 'Fold to a strip';
  $('mini-fold').title = label;
  $('mini-fold').setAttribute('aria-label', label);
}

window.addEventListener('resize', fitLayout);

$('mini-fold').addEventListener('click', () => {
  const folding = !state.collapsed;
  // Folding moves the panel out from under the pointer, and no mouseleave follows.
  if (folding) hovering = false;
  void brain.miniCollapse(folding);
});
$('mini-square').addEventListener('click', () => void brain.miniShape('square'));

// The strip and the square have no buttons: a click brings the rail back. A drag
// that orbits the graph also ends in a click, so movement rules it out.
let pressedAt: { x: number; y: number } | null = null;
$('mini').addEventListener('mousedown', (e) => { pressedAt = { x: e.clientX, y: e.clientY }; });
$('mini').addEventListener('click', (e) => {
  const dragged = pressedAt !== null && Math.hypot(e.clientX - pressedAt.x, e.clientY - pressedAt.y) > 4;
  pressedAt = null;
  // A header button's click bubbles up here too; it has already done its own job.
  if (dragged || (e.target as HTMLElement).closest('button')) return;
  if (document.body.classList.contains('square')) void brain.miniShape('rail');
  else if (document.body.classList.contains('strip')) void brain.miniCollapse(false);
});
$('mini-close').addEventListener('click', () => void brain.miniClose());
$('mini-open').addEventListener('click', () => void brain.miniOpenApp());

/* ---------------- resizing ---------------- */

const grip = $('mini-grip');
let pendingWidth: number | null = null;

grip.addEventListener('pointerdown', (e) => grip.setPointerCapture(e.pointerId));
grip.addEventListener('pointerup', (e) => grip.releasePointerCapture(e.pointerId));
grip.addEventListener('pointermove', (e) => {
  if (!grip.hasPointerCapture(e.pointerId)) return;
  const scheduled = pendingWidth !== null;
  // The grip is the right edge, so the pointer's x is the width being asked for.
  pendingWidth = Math.round(e.clientX);
  if (scheduled) return;
  requestAnimationFrame(() => {
    if (pendingWidth !== null) void brain.miniSetWidth(pendingWidth);
    pendingWidth = null;
  });
});

/* ---------------- wiring ---------------- */

brain.onEvent((e) => {
  if (e.type === 'session-active') {
    // The same reading of the transcript folder name as list_sessions.
    $('mini-project').textContent = e.project.replace(/^-Users-[^-]+-?/, '') || 'home';
    markLive();
    return;
  }
  if (!touchKind(e)) return;
  markLive();
  void apply(e);
  peekFor(PEEK_MS);
});

brain.onVaultChanged(() => void loadNodes().then(redraw));

brain.onMiniState((s) => {
  const newStretch = s.stretchStartedAt !== state.stretchStartedAt;
  state = s;
  paintState();
  if (newStretch) void seed();
});

async function init(): Promise<void> {
  const [s, skills] = await Promise.all([brain.miniState(), brain.skills().catch(() => [])]);
  if (s) state = s;
  shapes = new Map(skills.map((k) => [k.name, k.shape]));
  paintState();
  fitLayout();
  await loadNodes();
  await seed();
}

void init();
