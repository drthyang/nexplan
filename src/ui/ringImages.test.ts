import { describe, expect, it } from "vitest";
import { widenCoverage } from "./ringImages.ts";

/** A 9 × 7 grid with one reachable cell, λ = 1.0, at its centre (4, 3). */
const single = () => {
  const lam = new Float32Array(9 * 7).fill(NaN);
  lam[3 * 9 + 4] = 1.0;
  return lam;
};
const at = (a: ArrayLike<number>, i: number, j: number) => a[j * 9 + i]!;

describe("coverage widened for display", () => {
  it("spreads a reachable cell over a rounded 5 × 5 disc for radius 2, then a one-cell edge", () => {
    const { lam, edge } = widenCoverage(single(), 9, 7, 2, 2);
    const filled = [...lam].filter((v) => !Number.isNaN(v)).length;
    expect(filled).toBe(21); // 5 × 5 without its four corners (dx² + dy² ≤ 6)
    expect(at(lam, 6, 3)).toBe(1.0);
    expect(at(lam, 6, 5)).toBeNaN(); // corner left out
    expect(at(edge, 7, 3)).toBe(1); // just outside, on the axis
    expect(at(edge, 4, 3)).toBe(0); // the trace itself is not edge
    expect(at(edge, 0, 0)).toBe(0); // far away
  });

  it("keeps exact cells' own λ where spreads overlap", () => {
    const lam = single();
    lam[3 * 9 + 5] = 2.0;
    const out = widenCoverage(lam, 9, 7, 1, 1).lam;
    expect(at(out, 4, 3)).toBe(1.0);
    expect(at(out, 5, 3)).toBe(2.0);
  });

  it("paints neither trace nor edge off the detector", () => {
    const onDetector = (c: number) => c % 9 <= 4; // columns 0–4 are detector, 5–8 a gap
    const { lam, edge } = widenCoverage(single(), 9, 7, 2, 2, onDetector);
    for (let j = 0; j < 7; j++)
      for (let i = 5; i < 9; i++) {
        expect(at(lam, i, j)).toBeNaN();
        expect(at(edge, i, j)).toBe(0);
      }
  });

  it("leaves the input untouched, so counts still use the exact cells", () => {
    const lam = single();
    widenCoverage(lam, 9, 7, 2, 2);
    expect([...lam].filter((v) => !Number.isNaN(v)).length).toBe(1);
  });

  it("widens an elongated grid by its own radius on each axis", () => {
    const { lam } = widenCoverage(single(), 9, 7, 1, 2);
    expect(at(lam, 4, 5)).toBe(1.0); // ±2 rows
    expect(at(lam, 6, 3)).toBeNaN(); // only ±1 column
  });
});
