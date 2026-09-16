import { describe, it, expect } from 'vitest';
import {
  HOME_ZOOM,
  MIN_ZOOM,
  MAX_ZOOM,
  RESOLVE,
  clampZoom,
  visibleNudge,
  centredOffset,
  detailScale
} from '@core/view.js';

describe('clampZoom', () => {
  it('keeps the zoom inside its range', () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(2)).toBe(2);
  });

  it('falls back to the home zoom for a value that is not a number', () => {
    expect(clampZoom(NaN)).toBe(HOME_ZOOM);
    expect(clampZoom(Infinity)).toBe(HOME_ZOOM);
  });
});

describe('visibleNudge', () => {
  it('is zero with nothing covering the canvas, or with equal panels either side', () => {
    expect(visibleNudge(0, 0)).toBe(0);
    expect(visibleNudge(300, 300)).toBe(0);
  });

  it('moves the centre half a panel away from the side it is on', () => {
    expect(visibleNudge(350, 0)).toBe(175);
    expect(visibleNudge(0, 434)).toBe(-217);
    expect(visibleNudge(350, 434)).toBe(-42);
  });
});

describe('centredOffset', () => {
  it('lands the centre on itself at every zoom', () => {
    // The failure this guards: the old pan was stored in pixels computed for
    // one window size, so a resize or an off-centre wheel zoom left the object
    // off-centre for good.
    for (const zoom of [MIN_ZOOM, 1, HOME_ZOOM, 3.5, MAX_ZOOM]) {
      const { x, y } = centredOffset(892, 450, zoom);
      expect(x + 892 * zoom).toBeCloseTo(892, 9);
      expect(y + 450 * zoom).toBeCloseTo(450, 9);
    }
  });
});

describe('detailScale', () => {
  it('leaves the home view unchanged', () => {
    expect(detailScale(HOME_ZOOM, HOME_ZOOM)).toBe(1);
    expect(detailScale(0.5, 0.5)).toBe(1);
  });

  it('lets points grow on screen when zooming in, but slower than the zoom', () => {
    const screen = (zoom: number): number => zoom * detailScale(zoom, HOME_ZOOM);
    expect(screen(MAX_ZOOM)).toBeGreaterThan(screen(HOME_ZOOM));
    expect(screen(MAX_ZOOM) / screen(HOME_ZOOM)).toBeCloseTo(Math.pow(MAX_ZOOM / HOME_ZOOM, RESOLVE), 9);
    expect(screen(MAX_ZOOM) / screen(HOME_ZOOM)).toBeLessThan(MAX_ZOOM / HOME_ZOOM);
  });

  it('shrinks points in stage space as the zoom rises, so the gaps open faster than the points grow', () => {
    expect(detailScale(MAX_ZOOM, HOME_ZOOM)).toBeLessThan(1);
    expect(detailScale(MIN_ZOOM, HOME_ZOOM)).toBeGreaterThan(1);
  });
});
