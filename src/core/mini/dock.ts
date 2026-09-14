/** A rectangle in screen points - the shape Electron uses for bounds and work areas. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Folded to a strip the width of the main window's rail, so the two read as one family. */
export const COLLAPSED_WIDTH = 44;
export const DEFAULT_WIDTH = 320;
/** Narrower than this and the header no longer fits. */
export const MIN_WIDTH = 240;
/** Wider than this and it stops being a margin and becomes a window. */
export const MAX_WIDTH = 520;

/** Keep a requested width usable, and never wider than the screen it sits on. */
export function clampWidth(width: number, workArea: Rect): number {
  const requested = Number.isFinite(width) ? Math.round(width) : DEFAULT_WIDTH;
  const ceiling = Math.max(COLLAPSED_WIDTH, Math.min(MAX_WIDTH, workArea.width));
  return Math.min(ceiling, Math.max(MIN_WIDTH, requested));
}

/**
 * Where the mini window sits: flush against the left edge, full height.
 *
 * The work area rather than the display bounds - it already excludes the menu
 * bar and a Dock pinned to the left, so the panel lands beside them, not under.
 */
export function dockBounds(workArea: Rect, width: number, collapsed: boolean): Rect {
  return {
    x: workArea.x,
    y: workArea.y,
    width: collapsed ? COLLAPSED_WIDTH : clampWidth(width, workArea),
    height: workArea.height
  };
}
