import { describe, it, expect } from 'vitest';
import {
  dockBounds,
  clampWidth,
  COLLAPSED_WIDTH,
  DEFAULT_WIDTH,
  MIN_WIDTH,
  MAX_WIDTH,
  squareBounds,
  SQUARE_SIZE,
  clampToArea
} from '@core/mini/dock.js';
import { MiniPresence, IDLE_GAP_MS } from '@core/mini/presence.js';
import { TouchedNotes } from '@core/mini/touched.js';

const laptop = { x: 0, y: 25, width: 1470, height: 931 };

describe('dockBounds', () => {
  it('sits flush against the left edge of the work area, full height', () => {
    expect(dockBounds(laptop, 320, false)).toEqual({ x: 0, y: 25, width: 320, height: 931 });
  });

  it('lands beside a Dock pinned to the left rather than under it', () => {
    expect(dockBounds({ x: 72, y: 25, width: 1398, height: 931 }, 320, false).x).toBe(72);
  });

  it('folds to the rail width when collapsed, whatever width was saved', () => {
    expect(dockBounds(laptop, 480, true).width).toBe(COLLAPSED_WIDTH);
  });

  it('keeps a saved width inside usable limits', () => {
    expect(clampWidth(100, laptop)).toBe(MIN_WIDTH);
    expect(clampWidth(5000, laptop)).toBe(MAX_WIDTH);
    expect(clampWidth(Number.NaN, laptop)).toBe(DEFAULT_WIDTH);
    expect(clampWidth(300.6, laptop)).toBe(301);
  });

  it('never grows wider than the screen it is on', () => {
    expect(clampWidth(500, { x: 0, y: 0, width: 400, height: 800 })).toBe(400);
  });
});

describe('squareBounds', () => {
  it('sits in the bottom-left corner of the work area', () => {
    expect(squareBounds(laptop)).toEqual({ x: 0, y: 25 + 931 - SQUARE_SIZE, width: SQUARE_SIZE, height: SQUARE_SIZE });
  });

  it('stays above a Dock at the bottom and beside one on the left', () => {
    const b = squareBounds({ x: 72, y: 25, width: 1398, height: 850 });
    expect(b.x).toBe(72);
    expect(b.y + b.height).toBe(25 + 850);
  });

  it('never grows past a screen too small to hold it', () => {
    expect(squareBounds({ x: 0, y: 0, width: 150, height: 400 })).toEqual({ x: 0, y: 250, width: 150, height: 150 });
  });
});

describe('dragging the rail', () => {
  it('keeps the left edge it was dragged to, still full height', () => {
    expect(dockBounds(laptop, 320, false, 600)).toEqual({ x: 600, y: 25, width: 320, height: 931 });
  });

  it('parks flush against the right edge when dragged past it', () => {
    const b = dockBounds(laptop, 320, false, 5000);
    expect(b.x + b.width).toBe(1470);
  });

  it('cannot be dragged off the left edge either', () => {
    expect(dockBounds({ x: 72, y: 25, width: 1398, height: 931 }, 320, false, -300).x).toBe(72);
  });

  it('folds to the strip where the rail was', () => {
    expect(dockBounds(laptop, 320, true, 600)).toEqual({ x: 600, y: 25, width: COLLAPSED_WIDTH, height: 931 });
  });

  it('shifts left rather than growing off screen when widened at the right edge', () => {
    const b = dockBounds(laptop, 500, false, 1470 - 320);
    expect(b.width).toBe(500);
    expect(b.x + b.width).toBe(1470);
  });
});

describe('dragging the square', () => {
  it('sits where it was put', () => {
    expect(squareBounds(laptop, SQUARE_SIZE, { x: 900, y: 300 })).toEqual({ x: 900, y: 300, width: SQUARE_SIZE, height: SQUARE_SIZE });
  });

  it('is pulled back on screen when dropped half over an edge', () => {
    const b = squareBounds(laptop, SQUARE_SIZE, { x: 1400, y: -50 });
    expect(b.x + b.width).toBe(1470);
    expect(b.y).toBe(25);
  });

  it('still lands in the corner until it has been dragged', () => {
    expect(squareBounds(laptop, SQUARE_SIZE, null)).toEqual(squareBounds(laptop));
  });
});

describe('clampToArea', () => {
  it('leaves a rect that already fits alone', () => {
    expect(clampToArea({ x: 10, y: 30, width: 100, height: 100 }, laptop)).toEqual({ x: 10, y: 30, width: 100, height: 100 });
  });

  it('pins a rect larger than the area to the area itself', () => {
    expect(clampToArea({ x: -10, y: 0, width: 3000, height: 3000 }, laptop)).toEqual(laptop);
  });

  it('rounds to whole pixels, since window bounds are integers', () => {
    expect(clampToArea({ x: 10.6, y: 30.2, width: 100, height: 100 }, laptop)).toMatchObject({ x: 11, y: 30 });
  });
});

describe('MiniPresence', () => {
  const t0 = 1_000_000;

  it('opens for a session that starts working', () => {
    expect(new MiniPresence().sessionActive('a', t0, true)).toBe(true);
  });

  it('never opens on its own when auto-show is off', () => {
    expect(new MiniPresence().sessionActive('a', t0, false)).toBe(false);
  });

  it('stays closed for the rest of a session once dismissed', () => {
    const p = new MiniPresence();
    p.sessionActive('a', t0, true);
    p.dismiss(t0 + 1000);
    expect(p.sessionActive('a', t0 + 5000, true)).toBe(false);
    expect(p.sessionActive('a', t0 + 3 * 60 * 60_000, true)).toBe(false);
  });

  it('still opens for a new session after an earlier one was dismissed', () => {
    const p = new MiniPresence();
    p.sessionActive('a', t0, true);
    p.dismiss(t0 + 1000);
    expect(p.sessionActive('b', t0 + 2000, true)).toBe(true);
  });

  it('dismisses every session live at the moment it is closed', () => {
    const p = new MiniPresence();
    p.sessionActive('a', t0, true);
    p.sessionActive('b', t0 + 500, true);
    p.dismiss(t0 + 1000);
    expect(p.sessionActive('a', t0 + 2000, true)).toBe(false);
    expect(p.sessionActive('b', t0 + 2000, true)).toBe(false);
  });

  it('does not dismiss a session that had already gone quiet', () => {
    const p = new MiniPresence();
    p.sessionActive('old', t0, true);
    p.sessionActive('now', t0 + IDLE_GAP_MS + 60_000, true);
    p.dismiss(t0 + IDLE_GAP_MS + 61_000);
    expect(p.sessionActive('old', t0 + IDLE_GAP_MS + 62_000, true)).toBe(true);
  });

  it('lets opening it by hand override a dismissal', () => {
    const p = new MiniPresence();
    p.sessionActive('a', t0, true);
    p.dismiss(t0 + 1000);
    p.reopen();
    expect(p.sessionActive('a', t0 + 2000, true)).toBe(true);
  });

  it('starts a new stretch of work only after a long quiet gap', () => {
    const p = new MiniPresence();
    expect(p.stretchStartedAt).toBeNull();
    p.sessionActive('a', t0, true);
    p.sessionActive('a', t0 + 60_000, true);
    expect(p.stretchStartedAt).toBe(t0);
    const later = t0 + 60_000 + IDLE_GAP_MS + 1;
    p.sessionActive('a', later, true);
    expect(p.stretchStartedAt).toBe(later);
  });
});

describe('TouchedNotes', () => {
  it('counts each note once, at the strongest thing that happened to it', () => {
    const t = new TouchedNotes();
    t.record({ type: 'considered', noteIds: ['a', 'b', 'c'], query: 'q', at: 1 });
    t.record({ type: 'opened', noteIds: ['a'], at: 2 });
    t.record({ type: 'saved', noteIds: ['d'], at: 3 });
    t.record({ type: 'considered', noteIds: ['a', 'd'], query: 'again', at: 4 });
    expect(t.counts()).toEqual({ considered: 2, opened: 1, saved: 1 });
    expect(t.size).toBe(4);
  });

  it('treats a skill tracing through notes as recall', () => {
    const t = new TouchedNotes();
    expect(t.record({ type: 'skill', skill: 'review', noteIds: ['x'], query: 'q', at: 1 })).toEqual({
      ids: ['x'],
      kind: 'considered'
    });
    expect(t.counts().considered).toBe(1);
  });

  it('ignores events that touch no notes', () => {
    const t = new TouchedNotes();
    expect(t.record({ type: 'session-active', sessionId: 's', project: 'p', at: 1 })).toBeNull();
    expect(t.record({ type: 'status', message: 'ready', level: 'info', at: 1 })).toBeNull();
    expect(t.size).toBe(0);
  });
});
