import { describe, expect, it } from "vitest";
import type { Vec3 } from "@materia/core/math/types";
import { mulMat, mulVec } from "@materia/core/math/mat3";
import { goniometerMatrix, laueCondition } from "../ub/goniometer.ts";
import { SNS_INSTRUMENTS } from "../ub/instrumentsSns.ts";
import { ubFromU } from "../ub/ub.ts";
import { candidateGrid, familyCounts, greedyCover, landingOf, suggestSettings, targetCoverage, wantedStatus, type PlanTarget } from "./plan.ts";
import type { DetectorPanel } from "./detectors.ts";
import { observeAt, simulateSettings } from "./simulate.ts";

const topaz = (id: string) => SNS_INSTRUMENTS.find((i) => i.id === id)!;
const ambient = topaz("topaz-ambient");
const cryo = topaz("topaz-cryo");
const panels = ambient.detectors!;
// A slightly tilted crystal on a 5.431 Å cubic cell, every hkl with |h|, |k|, |l| ≤ 4, with triclinic (P-1)
// families: Friedel pairs. Cubic families would be too easy: one TOPAZ setting records them all.
const UB = ubFromU(
  [
    [0.96, -0.2, 0.19],
    [0.2, 0.98, 0.0],
    [-0.19, 0.04, 0.98],
  ].map((r) => {
    const n = Math.hypot(...r);
    return r.map((v) => v / n);
  }) as unknown as [Vec3, Vec3, Vec3],
  { a: 5.431, b: 5.431, c: 5.431, alpha: 90, beta: 90, gamma: 90 },
);
const keyOf = (h: Vec3) => {
  const first = h.find((v) => v !== 0)!;
  return (first < 0 ? h.map((v) => -v) : h).join(",");
};
const keys = new Map<string, number>();
const refl: PlanTarget[] = [];
for (let h = -4; h <= 4; h++)
  for (let k = -4; k <= 4; k++)
    for (let l = -4; l <= 4; l++) {
      if (!h && !k && !l) continue;
      const key = keyOf([h, k, l]);
      if (!keys.has(key)) keys.set(key, keys.size);
      refl.push({ h: [h, k, l], family: keys.get(key)! });
    }

describe("candidate settings", () => {
  it("TOPAZ ambient: a 5° grid over ω and φ (≤ 6000 settings), χ held at 135°", () => {
    const g = candidateGrid(ambient.goniometer, [0, 135, 0]);
    expect(g.step).toBe(5);
    expect(g.settings).toHaveLength(72 * 72);
    expect(candidateGrid(ambient.goniometer, [0, 135, 0], 2000).step).toBe(10);
    expect(g.settings.every((s) => s[1] === 135)).toBe(true);
    expect(new Set(g.settings.map((s) => s.join(","))).size).toBe(g.settings.length);
  });

  it("TOPAZ cryogenic: ω alone in 1° steps over one turn", () => {
    const g = candidateGrid(cryo.goniometer, [0]);
    expect(g.step).toBe(1);
    expect(g.settings).toHaveLength(360);
    expect(g.settings.at(-1)).toEqual([359]);
  });
});

describe("recorded targets: same test as observeAt (λ in the band, k_f on a panel)", () => {
  it("agrees reflection by reflection with observeAt on the real TOPAZ panels", () => {
    const settings = Array.from({ length: 16 }, (_, k) => [(k * 47) % 360, 135, (k * 83) % 360]);
    let total = 0;
    for (const s of settings) {
      const fast = targetCoverage(ambient.goniometer, [s], UB, refl, panels, 0.4, 3.5);
      const slow = new Set(observeAt(goniometerMatrix(ambient.goniometer, s), UB, refl, panels, 0.4, 3.5).map((o) => o.index));
      refl.forEach((_, i) => expect(fast[i] === 1).toBe(slow.has(i)));
      // The search's own (compiled) path records exactly the families of those reflections.
      const families = [...familyCounts(ambient.goniometer, [s], UB, refl, panels, 0.4, 3.5).keys()].sort((a, b) => a - b);
      expect(families).toEqual([...new Set([...slow].map((i) => refl[i]!.family))].sort((a, b) => a - b));
      total += slow.size;
    }
    expect(total).toBeGreaterThan(500);
  });
});

describe("overlapping panels", () => {
  it("a ray stops at the nearest panel it crosses, whatever the panel order (as observeAt)", () => {
    // Two panels across the same k_f, 1 m and 2 m out; the near one switched off hides the far one.
    const R = goniometerMatrix(cryo.goniometer, [0]);
    const target: PlanTarget[] = [{ h: [2, 0, -1], family: 0 }];
    const q = mulVec(mulMat(R, UB), [2, 0, -1]);
    const s = laueCondition(q);
    expect(s.lambda).toBeGreaterThan(0.4);
    expect(s.lambda).toBeLessThan(3.5);
    const u = s.kf.map((v) => v / Math.hypot(...s.kf)) as unknown as Vec3;
    const side: Vec3 = [u[2] / Math.hypot(u[0], u[2]), 0, -u[0] / Math.hypot(u[0], u[2])];
    const up: Vec3 = [side[1] * u[2] - side[2] * u[1], side[2] * u[0] - side[0] * u[2], side[0] * u[1] - side[1] * u[0]];
    const panel = (L: number, off: boolean): DetectorPanel => ({ name: `p${L}`, kind: "rectangular", center: [L * u[0], L * u[1], L * u[2]], base: side, up, width: 0.2, height: 0.2, nCols: 16, nRows: 16, ...(off ? { off } : {}) });
    for (const order of [
      [panel(2, false), panel(1, true)],
      [panel(1, true), panel(2, false)],
    ]) {
      expect(targetCoverage(cryo.goniometer, [[0]], UB, target, order, 0.4, 3.5)[0]).toBe(0);
      expect(observeAt(R, UB, target, order, 0.4, 3.5)).toHaveLength(0);
    }
    // With the near panel on, it records.
    expect(targetCoverage(cryo.goniometer, [[0]], UB, target, [panel(2, false), panel(1, false)], 0.4, 3.5)[0]).toBe(1);
  });
});

describe("greedy maximum coverage", () => {
  it("places wanted reflections well first, then records them, then new families, then second recordings; stops when nothing is gained", () => {
    const sets = [Int32Array.from([0, 1, 2]), Int32Array.from([2, 3]), Int32Array.from([3, 4, 5, 6]), Int32Array.from([])];
    // One wanted reflection: recorded near an edge by set 0, well placed by set 3.
    const wanted = [Uint8Array.of(1), Uint8Array.of(0), Uint8Array.of(0), Uint8Array.of(2)];
    const picks = greedyCover(sets, 10, { wanted });
    expect(picks.map((p) => p.index)).toEqual([3, 2, 0, 1]);
    expect(picks.map((p) => [p.wellPlaced, p.wanted, p.families, p.second])).toEqual([
      [1, 1, 0, 0],
      [0, 0, 4, 0],
      [0, 0, 3, 0],
      [0, 0, 0, 2], // all covered: {2, 3} records two families a second time
    ]);
    // Recording a wanted reflection at all beats more families.
    expect(greedyCover(sets, 1, { wanted: [Uint8Array.of(1), Uint8Array.of(0), Uint8Array.of(0), Uint8Array.of(0)] })[0]!.index).toBe(0);
    // Placing one wanted reflection well beats recording two of them poorly.
    expect(greedyCover([Int32Array.from([0]), Int32Array.from([1])], 1, { wanted: [Uint8Array.of(1, 1), Uint8Array.of(2, 0)] })[0]!.index).toBe(1);
    // Already-measured families and placements are not counted again.
    expect(greedyCover(sets, 1, { covered: [3, 4, 5, 6] })[0]!.index).toBe(0);
    expect(greedyCover(sets, 1, { wanted, wantedBefore: Uint8Array.of(2) })[0]!.index).toBe(2);
    // Redundancy prefers the set with more once-recorded families.
    const r = greedyCover([Int32Array.from([0, 1]), Int32Array.from([0]), Int32Array.from([0, 1, 2])], 2, { covered: [0, 1, 2] });
    expect(r.map((p) => p.index)).toEqual([2, 0]);
    expect(r.map((p) => [p.families, p.second, p.third])).toEqual([
      [0, 3, 0],
      [0, 0, 2],
    ]);
  });
});

describe("greedy fewest settings (set cover)", () => {
  it("stops once every wanted reflection is well placed, where coverage keeps adding families", () => {
    const sets = [Int32Array.from([0, 1, 2, 3]), Int32Array.from([4]), Int32Array.from([5, 6, 7, 8, 9]), Int32Array.from([1])];
    // Wanted 0 is well placed by set 1, wanted 1 by set 3; set 0 records both near an edge, set 2 neither.
    const wanted = [Uint8Array.of(1, 1), Uint8Array.of(2, 0), Uint8Array.of(0, 0), Uint8Array.of(0, 2)];
    expect(greedyCover(sets, 10, { wanted, goal: "fewest" }).map((p) => p.index)).toEqual([1, 3]);
    expect(greedyCover(sets, 10, { wanted }).length).toBeGreaterThan(2);
  });

  it("among settings placing the same wanted reflections well, takes the most centred, not the one with the most families", () => {
    const sets = [Int32Array.from([0, 1, 2, 3, 4]), Int32Array.from([0])];
    const wanted = [Uint8Array.of(2), Uint8Array.of(2)];
    const costs = [Float64Array.of(0.6), Float64Array.of(0.1)];
    expect(greedyCover(sets, 1, { wanted, costs, goal: "fewest" })[0]!.index).toBe(1);
    expect(greedyCover(sets, 1, { wanted, costs })[0]!.index).toBe(0);
  });

  it("with nothing wanted, stops once every reachable family is recorded", () => {
    const sets = [Int32Array.from([0, 1]), Int32Array.from([1, 2]), Int32Array.from([2, 3]), Int32Array.from([0, 3])];
    const picks = greedyCover(sets, 10, { goal: "fewest" });
    expect(picks).toHaveLength(2);
    expect(new Set(picks.flatMap((p) => [...sets[p.index]!])).size).toBe(4);
  });

  it("TOPAZ ambient: places every wanted reflection that can be placed well, in fewer settings than coverage, each within a step of its grid point", () => {
    const wanted: Vec3[][] = [[[2, -1, 1]], [[1, 3, 0]], [[0, 2, -2]], [[3, 1, 1]], [[1, 1, 4]], [[-2, 2, 1]], [[1, 0, 0]]];
    const common = { model: ambient.goniometer, base: [0, 135, 0], UB, reflections: refl, wanted, existing: [], panels, lambdaMin: 0.4, lambdaMax: 3.5, n: 10 };
    const fewest = suggestSettings({ ...common, goal: "fewest" });
    const coverage = suggestSettings({ ...common, goal: "coverage" });
    console.log(`TOPAZ ambient, ${wanted.length} wanted: fewest ${fewest.settings.length} settings place ${fewest.wellAfter} well (${fewest.wellPossible} possible); coverage ${coverage.settings.length} settings place ${coverage.wellAfter}`);
    expect(fewest.goal).toBe("fewest");
    expect(fewest.refined).toBe(true);
    expect(fewest.wellPossible).toBeGreaterThan(3);
    expect(fewest.wellAfter).toBe(fewest.wellPossible);
    expect(fewest.settings.length).toBeLessThan(wanted.length);
    expect(fewest.settings.length).toBeLessThan(coverage.settings.length);
    // The independent path agrees on what is placed well.
    const status = wantedStatus(ambient.goniometer, fewest.settings, UB, wanted, panels, 0.4, 3.5);
    expect(status.filter((s) => s.well > 0)).toHaveLength(fewest.wellAfter);
    // Refined off the 5° grid by at most a step per free axis (ω and φ wrap over a full turn); χ stays at 135°.
    const grid = candidateGrid(ambient.goniometer, [0, 135, 0]).settings;
    fewest.settings.forEach((s, k) => {
      const g = grid[fewest.picks[k]!.index]!;
      for (const i of [0, 2]) expect(Math.abs(((s[i]! - g[i]! + 540) % 360) - 180)).toBeLessThanOrEqual(fewest.step + 1e-9);
      expect(s[1]).toBe(135);
    });
  });

  it("TOPAZ cryogenic, one wanted reflection: one setting, centred at least as well as its 1° grid point", () => {
    const h: Vec3 = [2, -1, 1];
    const res = suggestSettings({ model: cryo.goniometer, base: [0], UB, reflections: refl, wanted: [[h]], existing: [], panels: cryo.detectors!, lambdaMin: 0.4, lambdaMax: 3.5, n: 10, goal: "fewest" });
    expect(res.settings).toHaveLength(1);
    const cost = (angles: readonly number[]) => {
      const hit = landingOf(cryo.goniometer, angles, UB, h, cryo.detectors!, 0.4, 3.5)!;
      return Math.max(Math.abs(hit.lambda - 1.95) / 1.55, hit.offset);
    };
    const start = candidateGrid(cryo.goniometer, [0]).settings[res.picks[0]!.index]!;
    expect(cost(res.settings[0]!)).toBeLessThanOrEqual(cost(start) + 1e-12);
    // Well placed by the default criteria.
    const hit = landingOf(cryo.goniometer, res.settings[0]!, UB, h, cryo.detectors!, 0.4, 3.5)!;
    expect(Math.abs(hit.lambda - 1.95)).toBeLessThanOrEqual(0.5 * 1.55 + 1e-12);
    expect(hit.offset).toBeLessThanOrEqual(0.8 + 1e-12);
  });
});

describe("wanted placement", () => {
  it("counts a setting as well placed exactly when λ is near mid band and the hit is away from the panel edges", () => {
    const h: Vec3 = [2, -1, 1];
    const settings = candidateGrid(ambient.goniometer, [0, 135, 0], 400).settings;
    const placement = { bandFraction: 0.4, edgeFraction: 0.15 };
    const status = wantedStatus(ambient.goniometer, settings, UB, [[h]], panels, 0.4, 3.5, placement)[0]!;
    let recorded = 0;
    let well = 0;
    for (const s of settings) {
      const hit = landingOf(ambient.goniometer, s, UB, h, panels, 0.4, 3.5);
      if (!hit) continue;
      recorded++;
      if (Math.abs(hit.lambda - 1.95) <= 0.4 * 1.55 && hit.offset <= 0.7) well++;
    }
    expect(recorded).toBeGreaterThan(5);
    expect(well).toBeGreaterThan(0);
    expect(well).toBeLessThan(recorded);
    expect(status).toEqual({ recorded, well });
    // Recorded counts agree with observeAt.
    expect(recorded).toBe(settings.filter((s) => observeAt(goniometerMatrix(ambient.goniometer, s), UB, [{ h, family: 0 }], panels, 0.4, 3.5).length === 1).length);
  });
});

describe("suggested TOPAZ orientation lists", () => {
  const completeness = (settings: (readonly number[])[]) => simulateSettings(ambient.goniometer, settings, UB, refl, panels, 0.4, 3.5);

  it("up to ten suggested settings record more families than ten evenly spaced ω settings, and each adds no more than the one before", () => {
    const res = suggestSettings({ model: ambient.goniometer, base: [0, 135, 0], UB, reflections: refl, wanted: [], existing: [], panels, lambdaMin: 0.4, lambdaMax: 3.5, n: 10 });
    expect(res.settings.length).toBeLessThanOrEqual(10);
    const even = Array.from({ length: 10 }, (_, k) => [k * 36, 135, 0]);
    const suggested = completeness(res.settings);
    const evenly = completeness(even);
    console.log(`TOPAZ ambient, P-1 families to d = 0.78 Å: ${res.settings.length} suggested settings ${suggested.observedFamilies}/${suggested.families} (full after ${res.picks.findIndex((p) => p.families === 0)}); 10 evenly in ω ${evenly.observedFamilies}`);
    expect(suggested.observedFamilies).toBeGreaterThan(evenly.observedFamilies);
    // Stopping early means everything the goniometer can reach is recorded.
    if (res.settings.length < 10) {
      const grid = candidateGrid(ambient.goniometer, [0, 135, 0]).settings;
      expect(suggested.observedFamilies).toBe(completeness(grid).observedFamilies);
    }
    // The search's own count agrees with the independent simulation.
    expect(res.picks.reduce((n, p) => n + p.families, 0)).toBe(suggested.observedFamilies);
    for (let i = 1; i < res.picks.length; i++) expect(res.picks[i]!.families).toBeLessThanOrEqual(res.picks[i - 1]!.families);
    // After full coverage the picks add second recordings; familyCounts agrees with the search.
    const counts = familyCounts(ambient.goniometer, res.settings, UB, refl, panels, 0.4, 3.5);
    expect(counts.size).toBe(suggested.observedFamilies);
    expect([...counts.values()].filter((c) => c >= 2).length).toBe(res.picks.reduce((n, p) => n + p.second, 0));
  });

  it("a wanted hkl outside the reflection list is placed well by the first suggestion (mid band, away from the edges); an existing list is kept and extended", () => {
    const wantedH: Vec3 = [1, 0, 0]; // e.g. absent in an F-centred crystal, so not in its reflection list, but still a target
    const target = [{ h: wantedH, family: -1 }];
    // An existing setting that does not record it.
    const existing = candidateGrid(ambient.goniometer, [0, 135, 0]).settings.find((s) => targetCoverage(ambient.goniometer, [s], UB, target, panels, 0.4, 3.5)[0] === 0)!;
    const res = suggestSettings({ model: ambient.goniometer, base: [0, 135, 0], UB, reflections: refl, wanted: [[wantedH]], existing: [existing], panels, lambdaMin: 0.4, lambdaMax: 3.5, n: 3 });
    expect(res.wantedTotal).toBe(1);
    expect([res.recordedBefore, res.wellBefore]).toEqual([0, 0]);
    expect([res.recordedAfter, res.wellAfter]).toEqual([1, 1]);
    expect([res.picks[0]!.wellPlaced, res.picks[0]!.wanted]).toEqual([1, 1]);
    const R = goniometerMatrix(ambient.goniometer, res.settings[0]!);
    expect(observeAt(R, UB, [{ h: wantedH, family: 0 }], panels, 0.4, 3.5)).toHaveLength(1);
    // Well placed by the default criteria: within half of the half-band of 1.95 Å, and inside the central 80 % of the panel.
    const hit = landingOf(ambient.goniometer, res.settings[0]!, UB, wantedH, panels, 0.4, 3.5)!;
    expect(Math.abs(hit.lambda - 1.95)).toBeLessThanOrEqual(0.5 * 1.55 + 1e-12);
    expect(hit.offset).toBeLessThanOrEqual(0.8 + 1e-12);
    // The existing setting counts as measured: no suggestion repeats it.
    expect(res.settings.some((s) => s.join() === existing.join())).toBe(false);
  });
});
