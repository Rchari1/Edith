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
  miniMove(x: number, y: number): Promise<void>;
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

/* ---------------- moving ---------------- */

/**
 * Drag the panel across the screen.
 *
 * The rail drags by its header and footer, so the graph between them keeps
 * its orbit. The strip and the square are nothing but graph and are there to
 * be glanced at, so they drag from anywhere. A press that never travels is
 * still a click.
 *
 * The position asked for is the pointer's place on screen less where it took
 * hold of the panel. The pointer's place on screen is the window's own plus
 * the pointer's place inside it - not e.screenX, which a synthetic event does
 * not carry, and which is redundant once the window is following the pointer.
 */
const DRAG_SLOP = 4;
const panel = $('mini');
let press: { id: number; x: number; y: number } | null = null;
let dragging = false;
let pendingMove: { x: number; y: number } | null = null;

function dragHandle(target: HTMLElement): boolean {
  if (target.closest('button, .mini-grip')) return false;
  return ambient || target.closest('.mini-head, .mini-foot') !== null;
}

function resetDrag(): void {
  press = null;
  dragging = false;
  pendingMove = null;
  document.body.classList.remove('dragging');
}

panel.addEventListener('pointerdown', (e) => {
  // A release the page never saw - the window hidden mid-drag, say - must not
  // leave every later click judged a drag. A new press starts clean.
  resetDrag();
  if (e.button !== 0 || !dragHandle(e.target as HTMLElement)) return;
  press = { id: e.pointerId, x: e.clientX, y: e.clientY };
});

panel.addEventListener('pointermove', (e) => {
  if (!press || e.pointerId !== press.id) return;
  if (!dragging) {
    // Until the panel moves, the pointer's travel inside it is its travel on screen.
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) <= DRAG_SLOP) return;
    dragging = true;
    panel.setPointerCapture(press.id);
    document.body.classList.add('dragging');
    // Carrying the strip somewhere is not resting on it: no peek mid-drag.
    window.clearTimeout(peekTimer);
  }
  const scheduled = pendingMove !== null;
  pendingMove = { x: window.screenX + e.clientX - press.x, y: window.screenY + e.clientY - press.y };
  if (scheduled) return;
  requestAnimationFrame(() => {
    if (pendingMove) void brain.miniMove(pendingMove.x, pendingMove.y);
    pendingMove = null;
  });
});

function endDrag(e: PointerEvent): void {
  if (!press || e.pointerId !== press.id) return;
  if (dragging && panel.hasPointerCapture(press.id)) panel.releasePointerCapture(press.id);
  press = null;
  // The click for this release fires next, synchronously; it must still see
  // that this was a drag. Clear once that has been judged.
  window.setTimeout(() => {
    dragging = false;
    document.body.classList.remove('dragging');
  }, 0);
}
panel.addEventListener('pointerup', endDrag);
panel.addEventListener('pointercancel', endDrag);
window.addEventListener('blur', resetDrag);

// The strip and the square have no buttons: a click brings the rail back. A
// drag ends in a click too, so a drag rules it out.
panel.addEventListener('click', (e) => {
  // A header button's click bubbles up here too; it has already done its own job.
  if (dragging || (e.target as HTMLElement).closest('button')) return;
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
