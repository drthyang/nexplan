import { describe, expect, it } from "vitest";
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { goniometerMatrix } from "../ub/goniometer.ts";
import { SNS_INSTRUMENTS } from "../ub/instrumentsSns.ts";
import { ubFromU } from "../ub/ub.ts";
import { autoStep, binStep, centredBins, energyBinning, mdnormBinning, roundRange, suggestBinning } from "./binning.ts";
import { panelSamples } from "./hklRange.ts";

const I3: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const corelli = SNS_INSTRUMENTS.find((i) => i.id === "corelli")!;

describe("MDNorm limits and Mantid's Q convention", () => {
  it("crystallographic: as recorded; Inelastic (Mantid's default, which labels h as −h): mirrored, the slab centre too", () => {
    const axis = { min: -4.18, step: 0.01, max: 4.59 };
    expect(mdnormBinning(axis, "crystallography")).toBe("-4.18,0.01,4.59");
    expect(mdnormBinning(axis, "inelastic")).toBe("-4.59,0.01,4.18");
    expect(mdnormBinning({ min: 0, step: 0.05, max: 2.5 }, "inelastic")).toBe("-2.5,0.05,0");
    expect(mdnormBinning(axis, "crystallography", { centre: 1, thickness: 0.1 })).toBe("0.95,1.05");
    expect(mdnormBinning(axis, "inelastic", { centre: 1, thickness: 0.1 })).toBe("-1.05,-0.95");
    // A point recorded at h lies in the mirrored box at −h, the label Mantid gives it.
    for (const h of [-4.18, 0.3, 4.59]) {
      const [lo, , hi] = mdnormBinning(axis, "inelastic").split(",").map(Number);
      expect(-h >= lo! && -h <= hi!).toBe(true);
    }
  });
});

describe("binning", () => {
  it("auto step: the round step (1, 2, 2.5, 4, 5 × 10ⁿ) giving 201–401 bins, nearest 301; bins centred on zero", () => {
    expect([0.0099, 0.0137, 0.0155, 0.024, 0.036, 0.046, 0.1, 0.8].map(binStep)).toEqual([0.01, 0.01, 0.02, 0.025, 0.04, 0.05, 0.1, 1]);
    for (const span of [1, 4.7, 8.77, 13.58, 30, 51, 200]) {
      const n = span / autoStep(span);
      expect(n, `span ${span}`).toBeGreaterThanOrEqual(201);
      expect(n, `span ${span}`).toBeLessThanOrEqual(401);
    }
    expect(centredBins(-6.79, 6.79)).toEqual({ min: -6.825, max: 6.825, step: 0.05, bins: 273 });
    // Asymmetric: the bin centres stay on multiples of the step (here integers), and the range is covered.
    const a = centredBins(-4.18, 4.59);
    expect(a.min).toBeLessThanOrEqual(-4.18);
    expect(a.max).toBeGreaterThanOrEqual(4.59);
    const k = a.min / a.step + 0.5;
    expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-9);
    // A chosen step is kept: ±5 in 0.05 is the familiar −5.025, 0.05, 5.025 (201 bins).
    expect(centredBins(-5, 5, 0.05)).toEqual({ min: -5.025, max: 5.025, step: 0.05, bins: 201 });
    expect(roundRange(-7.93, 8.012, 0.02)).toEqual({ min: -7.94, max: 8.02, bins: 798 });
  });

  it("energy transfer: steps of 1 % of Ei, as Mantid's DGS default (−0.5 Ei, 0.01 Ei, 0.99 Ei)", () => {
    expect(energyBinning(60, -30, 59.4)).toEqual({ min: -30, max: 59.4, step: 0.6, bins: 149 });
    expect(energyBinning(12, -6, 11.88)).toEqual({ min: -6, max: 11.88, step: 0.12, bins: 149 });
  });

  it("CORELLI full scan on a 5 Å cell: the recorded range in 201–401 bins per axis, or in a chosen step", () => {
    const UB = ubFromU(I3 as unknown as [Vec3, Vec3, Vec3], { a: 5, b: 5, c: 5, alpha: 90, beta: 90, gamma: 90 });
    const settings = Array.from({ length: 120 }, (_, k) => goniometerMatrix(corelli.goniometer, [3 * k]));
    const run = (step?: number) => suggestBinning(settings, settings.map(() => undefined), panelSamples(corelli.detectors!, 4), { kind: "white", lambdaMin: 0.6, lambdaMax: 2.5 }, UB, I3, step, { qMax: 1 / 0.8 })!;
    const auto = run();
    auto.axes.forEach((ax, i) => {
      expect(ax.min).toBeLessThanOrEqual(auto.extent.min[i]!);
      expect(ax.max).toBeGreaterThanOrEqual(auto.extent.max[i]!);
      expect(ax.bins).toBeGreaterThanOrEqual(201);
      expect(ax.bins).toBeLessThanOrEqual(403);
    });
    for (const ax of run(0.05).axes) expect(ax.step).toBe(0.05);
  });
});
