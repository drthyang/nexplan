import { describe, expect, it } from "vitest";
import type { Vec3 } from "@materia/core/math/types";
import { goniometerMatrix } from "../ub/goniometer.ts";
import { SNS_INSTRUMENTS } from "../ub/instrumentsSns.ts";
import { ubFromU } from "../ub/ub.ts";
import { candidateGrid, familyCounts, greedyCover, suggestSettings, targetCoverage, type PlanTarget } from "./plan.ts";
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

describe("greedy maximum coverage", () => {
  it("takes wanted targets first, then the most new families, then second recordings, and stops when nothing is gained", () => {
    const sets = [Int32Array.from([0, 1, 2]), Int32Array.from([2, 3]), Int32Array.from([3, 4, 5, 6]), Int32Array.from([-1])];
    const picks = greedyCover(sets, 10, { wanted: new Set([-1]) });
    expect(picks.map((p) => p.index)).toEqual([3, 2, 0, 1]);
    expect(picks.map((p) => [p.wanted, p.families, p.second])).toEqual([
      [1, 0, 0],
      [0, 4, 0],
      [0, 3, 0],
      [0, 0, 2], // all covered: {2, 3} records two families a second time
    ]);
    // Already-measured families are not counted as new.
    expect(greedyCover(sets, 1, { covered: [3, 4, 5, 6] })[0]!.index).toBe(0);
    // Redundancy prefers the set with more once-recorded families.
    const r = greedyCover([Int32Array.from([0, 1]), Int32Array.from([0]), Int32Array.from([0, 1, 2])], 2, { covered: [0, 1, 2] });
    expect(r.map((p) => p.index)).toEqual([2, 0]);
    expect(r.map((p) => [p.families, p.second, p.third])).toEqual([
      [0, 3, 0],
      [0, 0, 2],
    ]);
  });
});

describe("suggested TOPAZ orientation lists", () => {
  const completeness = (settings: (readonly number[])[]) => simulateSettings(ambient.goniometer, settings, UB, refl, panels, 0.4, 3.5);

  it("up to ten suggested settings record more families than ten evenly spaced ω settings, and each adds no more than the one before", () => {
    const res = suggestSettings({ model: ambient.goniometer, base: [0, 135, 0], UB, reflections: refl, wantedFamilies: [], extra: [], existing: [], panels, lambdaMin: 0.4, lambdaMax: 3.5, n: 10 });
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

  it("a wanted hkl outside the reflection list is recorded by the first suggestion; an existing list is kept and extended", () => {
    const wantedH: Vec3 = [1, 0, 0]; // e.g. absent in an F-centred crystal, so not in its reflection list, but still a target
    const target = [{ h: wantedH, family: -1 }];
    // An existing setting that does not record it.
    const existing = candidateGrid(ambient.goniometer, [0, 135, 0]).settings.find((s) => targetCoverage(ambient.goniometer, [s], UB, target, panels, 0.4, 3.5)[0] === 0)!;
    const res = suggestSettings({ model: ambient.goniometer, base: [0, 135, 0], UB, reflections: refl, wantedFamilies: [-1], extra: target, existing: [existing], panels, lambdaMin: 0.4, lambdaMax: 3.5, n: 3 });
    expect(res.wantedTotal).toBe(1);
    expect(res.wantedBefore).toBe(0);
    expect(res.wantedAfter).toBe(1);
    expect(res.picks[0]!.wanted).toBe(1);
    const R = goniometerMatrix(ambient.goniometer, res.settings[0]!);
    expect(observeAt(R, UB, [{ h: wantedH, family: 0 }], panels, 0.4, 3.5)).toHaveLength(1);
    // The existing setting counts as measured: no suggestion repeats it.
    expect(res.settings.some((s) => s.join() === existing.join())).toBe(false);
  });
});
