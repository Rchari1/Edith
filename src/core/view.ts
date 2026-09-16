/**
 * Pan and zoom geometry for the graph stage.
 *
 * The object is pinned to the centre of whatever the panels leave visible.
 * Rather than accumulating a pan offset that a resize, a wheel zoom or a
 * folding panel can leave stale, the offset is derived from the zoom and the
 * visible centre on every frame - so there is no state that can drift.
 */

/** Zoom the main window opens at. Every other zoom is measured against it. */
export const HOME_ZOOM = 1.7;
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 8;

/**
 * How much of a zoom reaches the size of a point.
 *
 * At 1 points magnify with everything else and a deep zoom is a blur of soft
 * discs. At 0 they stay a fixed size on screen and zooming only spreads them
 * apart. In between, zooming resolves the cloud: the points grow a little, the
 * gaps between them grow a lot, and the field sharpens instead of smearing.
 */
export const RESOLVE = 0.4;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return HOME_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * Horizontal centre of the visible area, as an offset from the canvas centre.
 *
 * The canvas runs full-bleed under the panels; the insets are how much of it
 * each side covers. A panel on the left pushes the centre right, one on the
 * right pushes it left, and equal panels leave it where it was.
 */
export function visibleNudge(leftInset: number, rightInset: number): number {
  return (leftInset - rightInset) / 2;
}

/** Pan that keeps the stage point (cx, cy) on the same screen point at this zoom. */
export function centredOffset(cx: number, cy: number, zoom: number): { x: number; y: number } {
  return { x: cx * (1 - zoom), y: cy * (1 - zoom) };
}

/**
 * Stage-space multiplier for point sizes, so that on screen they grow as
 * zoom^RESOLVE rather than linearly with the zoom. 1 at the home zoom, so the
 * opening view is unchanged.
 */
export function detailScale(zoom: number, home: number): number {
  return Math.pow(zoom / home, RESOLVE - 1);
}
