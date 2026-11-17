import { describe, expect, it } from 'vitest';
import { clampRect, defaultFloat, EDGES, FLOAT_MIN, moveRect, resizeRect, type Rect, type Size } from './floating.ts';

const box: Size = { w: 1000, h: 600 };
const inside = (r: Rect, b: Size): boolean => r.x >= 0 && r.y >= 0 && r.x + r.w <= b.w && r.y + r.h <= b.h;

describe('a floating panel stays inside its box', () => {
  it('moves back in from any side', () => {
    expect(clampRect({ x: -50, y: -20, w: 400, h: 300 }, box)).toEqual({ x: 0, y: 0, w: 400, h: 300 });
    expect(clampRect({ x: 900, y: 500, w: 400, h: 300 }, box)).toEqual({ x: 600, y: 300, w: 400, h: 300 });
  });

  it('shrinks when the box became smaller than the panel', () => {
    expect(clampRect({ x: 700, y: 100, w: 800, h: 700 }, { w: 640, h: 400 })).toEqual({ x: 0, y: 0, w: 640, h: 400 });
  });

  it('gives up the minimum size only when the box itself is smaller', () => {
    expect(clampRect({ x: 0, y: 0, w: 100, h: 100 }, box)).toEqual({ x: 0, y: 0, ...FLOAT_MIN });
    expect(clampRect({ x: 10, y: 10, w: 100, h: 100 }, { w: 300, h: 200 })).toEqual({ x: 0, y: 0, w: 300, h: 200 });
  });

  it('moving stops at the edges', () => {
    const r = { x: 100, y: 100, w: 400, h: 300 };
    expect(moveRect(r, 24, -24, box)).toEqual({ x: 124, y: 76, w: 400, h: 300 });
    expect(moveRect(r, 5000, 5000, box)).toEqual({ x: 600, y: 300, w: 400, h: 300 });
    expect(moveRect(r, -5000, -5000, box)).toEqual({ x: 0, y: 0, w: 400, h: 300 });
  });

  it('resizing keeps the opposite edge and stops at the box and at the minimum', () => {
    const r = { x: 100, y: 100, w: 400, h: 300 };
    expect(resizeRect(r, 'e', 50, 999, box)).toEqual({ x: 100, y: 100, w: 450, h: 300 });
    expect(resizeRect(r, 'se', 5000, 5000, box)).toEqual({ x: 100, y: 100, w: 900, h: 500 });
    expect(resizeRect(r, 'w', -40, 0, box)).toEqual({ x: 60, y: 100, w: 440, h: 300 });
    expect(resizeRect(r, 'nw', -5000, -5000, box)).toEqual({ x: 0, y: 0, w: 500, h: 400 });
    // Dragged past the minimum: the right and bottom edges do not move.
    expect(resizeRect(r, 'nw', 5000, 5000, box)).toEqual({ x: 500 - FLOAT_MIN.w, y: 400 - FLOAT_MIN.h, ...FLOAT_MIN });
    expect(resizeRect(r, 's', 0, -5000, box)).toEqual({ x: 100, y: 100, w: 400, h: FLOAT_MIN.h });
  });

  it('every edge, any drag, any box: the result is inside', () => {
    const boxes: Size[] = [box, { w: 1440, h: 858 }, { w: 400, h: 300 }, { w: 200, h: 150 }];
    for (const b of boxes)
      for (const edge of EDGES)
        for (const d of [-2000, -30, 0, 30, 2000]) {
          const r = resizeRect({ x: 300, y: 200, w: 500, h: 350 }, edge, d, -d, b);
          expect(inside(r, b), `${edge} ${d} in ${b.w}x${b.h}`).toBe(true);
          expect(r.w).toBeGreaterThanOrEqual(Math.min(FLOAT_MIN.w, b.w));
          expect(r.h).toBeGreaterThanOrEqual(Math.min(FLOAT_MIN.h, b.h));
        }
  });

  it('starts in the lower right, inside', () => {
    expect(defaultFloat({ w: 1440, h: 858 })).toEqual({ x: 856, y: 394, w: 560, h: 440 });
    expect(inside(defaultFloat({ w: 360, h: 280 }), { w: 360, h: 280 })).toBe(true);
  });
});
