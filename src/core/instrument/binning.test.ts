import { describe, expect, it } from "vitest";
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { goniometerMatrix } from "../ub/goniometer.ts";
import { SNS_INSTRUMENTS } from "../ub/instrumentsSns.ts";
import { ubFromU } from "../ub/ub.ts";
import { energyBinning, niceStep, roundRange, suggestBinning } from "./binning.ts";
import { panelSamples } from "./hklRange.ts";
import { FWHM_PER_SIGMA, GARNET_RESOLUTION, whiteBeamCovariance } from "./qResolution.ts";

const I3: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const corelli = SNS_INSTRUMENTS.find((i) => i.id === "corelli")!;

describe("binning", () => {
  it("nice steps round to the nearest of 1, 2, 2.5, 5 × 10ⁿ; ranges round out to whole bins on multiples of the step", () => {
    expect([0.0099, 0.0137, 0.0155, 0.024, 0.036, 0.04, 0.1, 0.8].map(niceStep)).toEqual([0.01, 0.01, 0.02, 0.025, 0.05, 0.05, 0.1, 1]);
    expect(roundRange(-7.93, 8.012, 0.02)).toEqual({ min: -7.94, max: 8.02, bins: 798 });
    expect(energyBinning(0.113, -0.66, 3.15, 3)).toEqual({ min: -0.7, max: 3.15, step: 0.05, bins: 77 });
  });

  it("an isotropic resolution σ projects to 2.3548·σ·|a|/2π along h, and √2 less along [1 1 0] (|[1 1 0]| = √2/a)", () => {
    const a = 5;
    const UB = ubFromU(I3 as unknown as [Vec3, Vec3, Vec3], { a, b: a, c: a, alpha: 90, beta: 90, gamma: 90 });
    const sigma = 0.01;
    const iso = (): Mat3 => [
      [sigma ** 2, 0, 0],
      [0, sigma ** 2, 0],
      [0, 0, sigma ** 2],
    ];
    const settings = [goniometerMatrix(corelli.goniometer, [0]), goniometerMatrix(corelli.goniometer, [40])];
    const samples = panelSamples(corelli.detectors!, 3);
    const beam = { kind: "white" as const, lambdaMin: 0.6, lambdaMax: 2.5 };
    const b = suggestBinning(settings, [undefined, undefined], samples, beam, UB, I3, iso, 2)!;
    for (const ax of b.axes) {
      expect(ax.fwhm25).toBeCloseTo((FWHM_PER_SIGMA * sigma * a) / (2 * Math.PI), 12);
      expect(ax.step).toBe(niceStep(ax.fwhm25 / 2));
      expect(ax.min).toBeLessThanOrEqual(b.extent.min[b.axes.indexOf(ax)]!);
    }
    const W: Mat3 = [
      [1, -1, 0],
      [1, 1, 0],
      [0, 0, 1],
    ];
    const r = suggestBinning(settings, [undefined, undefined], samples, beam, UB, W, iso, 2)!;
    expect(r.axes[0].fwhm25).toBeCloseTo((FWHM_PER_SIGMA * sigma * a) / (2 * Math.PI) / Math.SQRT2, 12);
  });

  it("CORELLI with garnet-tools' resolution: bins of a few hundredths of r.l.u. on a 5 Å cell, the median wider than the sharpest quarter", () => {
    const UB = ubFromU(I3 as unknown as [Vec3, Vec3, Vec3], { a: 5, b: 5, c: 5, alpha: 90, beta: 90, gamma: 90 });
    const settings = Array.from({ length: 120 }, (_, k) => goniometerMatrix(corelli.goniometer, [3 * k]));
    const b = suggestBinning(settings, settings.map(() => undefined), panelSamples(corelli.detectors!, 4), { kind: "white", lambdaMin: 0.6, lambdaMax: 2.5 }, UB, I3, (u, l) => whiteBeamCovariance(u, l, GARNET_RESOLUTION.CORELLI), 2)!;
    for (const ax of b.axes) {
      expect(ax.fwhm25).toBeGreaterThan(0.005);
      expect(ax.fwhm25).toBeLessThan(0.1);
      expect(ax.fwhm50).toBeGreaterThanOrEqual(ax.fwhm25);
      expect(ax.bins).toBeGreaterThan(50);
    }
  });
});
