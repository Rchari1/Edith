/** A rectangle in screen points - the shape Electron uses for bounds and work areas. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A point on screen, in the same coordinates as a Rect. */
export interface Point {
  x: number;
  y: number;
}

/**
 * Keep a rectangle inside an area.
 *
 * A drag can ask for any position at all; this turns the request into a place
 * the window can actually be. A rect larger than the area is pinned to the
 * area's origin and cut to its size.
 */
export function clampToArea(rect: Rect, area: Rect): Rect {
  const width = Math.min(rect.width, area.width);
  const height = Math.min(rect.height, area.height);
  const x = Math.round(Math.min(area.x + area.width - width, Math.max(area.x, rect.x)));
  const y = Math.round(Math.min(area.y + area.height - height, Math.max(area.y, rect.y)));
  return { x, y, width, height };
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
 * Where the mini window sits: full height, flush against the left edge unless
 * it has been dragged - then `left` is where its left edge was put, kept on
 * screen. The rail and the strip only ever move sideways.
 *
 * The work area rather than the display bounds - it already excludes the menu
 * bar and a Dock pinned to the left, so the panel lands beside them, not under.
 */
export function dockBounds(workArea: Rect, width: number, collapsed: boolean, left: number | null = null): Rect {
  return clampToArea(
    {
      x: left ?? workArea.x,
      y: workArea.y,
      width: collapsed ? COLLAPSED_WIDTH : clampWidth(width, workArea),
      height: workArea.height
    },
    workArea
  );
}

/** The two shapes mini mode can take. The folded strip is a state of the rail, not a shape of its own. */
export type MiniShape = 'rail' | 'square';

/** Small enough to live in a corner, big enough that the shape still reads. */
export const SQUARE_SIZE = 220;

/**
 * Where the square sits: the bottom-left corner of the work area - the same edge
 * as the rail, so shrinking into it reads as the rail settling into its corner.
 * Once dragged, it sits wherever it was put, kept on screen.
 */
export function squareBounds(workArea: Rect, size = SQUARE_SIZE, origin: Point | null = null): Rect {
  const side = Math.max(1, Math.min(size, workArea.width, workArea.height));
  const home = { x: workArea.x, y: workArea.y + workArea.height - side };
  return clampToArea({ x: origin?.x ?? home.x, y: origin?.y ?? home.y, width: side, height: side }, workArea);
}
