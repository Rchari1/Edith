import { describe, it, expect } from 'vitest';
import {
  dockBounds,
  clampWidth,
  COLLAPSED_WIDTH,
  DEFAULT_WIDTH,
  MIN_WIDTH,
  MAX_WIDTH,
  squareBounds,
  SQUARE_SIZE
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
