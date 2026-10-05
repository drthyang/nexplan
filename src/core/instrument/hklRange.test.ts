import { describe, expect, it } from "vitest";
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { goniometerMatrix } from "../ub/goniometer.ts";
import { SNS_INSTRUMENTS } from "../ub/instrumentsSns.ts";
import { ubFromU } from "../ub/ub.ts";
import { applyMasks, shadowTest } from "./acceptance.ts";
import { hklExtent, kOfEnergy, panelSamples, segmentEnds } from "./hklRange.ts";
import { observeAt } from "./simulate.ts";

const I3: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const cubic = (a: number, U: Mat3 = I3) => ubFromU(U as unknown as [Vec3, Vec3, Vec3], { a, b: a, c: a, alpha: 90, beta: 90, gamma: 90 });
const corelli = SNS_INSTRUMENTS.find((i) => i.id === "corelli")!;
const topaz = SNS_INSTRUMENTS.find((i) => i.id === "topaz-ambient")!;

describe("recorded HKL extent", () => {
  it("contains every reflection the plan records, masks and shadows included, and is reached by some of them", () => {
    const UB = cubic(5.431, [
      [0.96, -0.2, 0.19],
      [0.2, 0.98, 0.0],
      [-0.19, 0.04, 0.98],
    ].map((r) => r.map((v) => v / Math.hypot(...r))) as unknown as Mat3);
    const panels = applyMasks(topaz.detectors!, { edgeRows: 20, edgeCols: 20, panelsOff: [topaz.detectors![4]!.name] });
    const angles = [0, 60, 120, 180, 240, 300].map((w) => [w, 135, (w * 7) % 360]);
    const settings = angles.map((a) => goniometerMatrix(topaz.goniometer, a));
    const shapes = [{ kind: "sector" as const, gamma: 70, halfWidth: 15 }];
    const blocked = angles.map((a) => shadowTest(shapes, topaz.goniometer, a));
    const ext = hklExtent(settings, blocked, panelSamples(panels), { kind: "white", lambdaMin: 0.4, lambdaMax: 3.5 }, UB, I3)!;
    // Every integer hkl out to the box's own size.
    const n = Math.ceil(Math.max(...ext.min.map(Math.abs), ...ext.max.map(Math.abs))) + 1;
    const refl: { h: Vec3; family: number }[] = [];
    for (let h = -n; h <= n; h++) for (let k = -n; k <= n; k++) for (let l = -n; l <= n; l++) if (h || k || l) refl.push({ h: [h, k, l], family: 0 });
    let seen = 0;
    const reach = [0, 0, 0];
    settings.forEach((R, s) => {
      for (const o of observeAt(R, UB, refl, panels, 0.4, 3.5, blocked[s])) {
        seen++;
        const h = refl[o.index]!.h;
        for (let i = 0; i < 3; i++) {
          // Inside, to the sampling of the panel edges (a fraction of a reciprocal-lattice unit).
          expect(h[i]!).toBeGreaterThanOrEqual(ext.min[i]! - 0.05);
          expect(h[i]!).toBeLessThanOrEqual(ext.max[i]! + 0.05);
          reach[i] = Math.max(reach[i]!, Math.abs(h[i]!));
        }
      }
    });
    expect(seen).toBeGreaterThan(1000);
    // The box is not loose: integer reflections come within one unit of its far side on every axis.
    for (let i = 0; i < 3; i++) expect(Math.max(-ext.min[i]!, ext.max[i]!) - reach[i]!).toBeLessThan(1);
  });

  it("a chopper spectrometer at the elastic line is a white beam at the incident wavelength", () => {
    const UB = cubic(4.2);
    const samples = panelSamples(corelli.detectors!, 6);
    const R = [goniometerMatrix(corelli.goniometer, [25])];
    const lambda = 1 / kOfEnergy(30);
    const a = hklExtent(R, [undefined], samples, { kind: "direct", eiMeV: 30, eMin: 0, eMax: 0 }, UB, I3)!;
    const b = hklExtent(R, [undefined], samples, { kind: "white", lambdaMin: lambda, lambdaMax: lambda }, UB, I3)!;
    for (let i = 0; i < 3; i++) {
      expect(a.min[i]).toBeCloseTo(b.min[i]!, 10);
      expect(a.max[i]).toBeCloseTo(b.max[i]!, 10);
    }
    // Energy gain (E < 0) reaches further out than the elastic line.
    const gain = hklExtent(R, [undefined], samples, { kind: "direct", eiMeV: 30, eMin: -10, eMax: 0 }, UB, I3)!;
    expect(gain.qMax).toBeGreaterThan(a.qMax);
  });

  it("within |q| ≤ q_max: segments clip exactly to the sphere, and a cubic box stays within |h| ≤ a·q_max", () => {
    const qMax = 1 / 0.8;
    for (const beam of [{ kind: "white" as const, lambdaMin: 0.4, lambdaMax: 3.5 }, { kind: "direct" as const, eiMeV: 60, eMin: -12, eMax: 57 }]) {
      let clipped = 0;
      for (const list of panelSamples(topaz.detectors!, 4))
        for (const u of list) {
          const full = segmentEnds(u, beam);
          const ends = segmentEnds(u, beam, qMax);
          for (const [a, b] of ends) expect(Math.hypot(a * u[0], a * u[1], a * u[2] - b)).toBeLessThanOrEqual(qMax * (1 + 1e-12));
          // Where the full segment leaves the sphere, the clipped one ends on it.
          const out = full.some(([a, b]) => Math.hypot(a * u[0], a * u[1], a * u[2] - b) > qMax);
          if (out && ends.length) {
            clipped++;
            expect(Math.max(...ends.map(([a, b]) => Math.hypot(a * u[0], a * u[1], a * u[2] - b)))).toBeCloseTo(qMax, 10);
          }
        }
      expect(clipped).toBeGreaterThan(10);
    }
    const a = 5.431;
    const settings = [0, 90, 180, 270].map((w) => goniometerMatrix(topaz.goniometer, [w, 135, 0]));
    const ext = hklExtent(settings, settings.map(() => undefined), panelSamples(topaz.detectors!, 8), { kind: "white", lambdaMin: 0.4, lambdaMax: 3.5 }, cubic(a), I3, qMax)!;
    for (let i = 0; i < 3; i++) expect(Math.max(-ext.min[i]!, ext.max[i]!)).toBeLessThanOrEqual(a * qMax + 1e-9);
    expect(ext.qMax).toBeCloseTo(2 * Math.PI * qMax, 6);
  });

  it("a full turn about the vertical: h and l ranges symmetric, the k range set by the detectors' elevation alone", () => {
    const UB = cubic(5);
    const settings = Array.from({ length: 360 }, (_, w) => goniometerMatrix(corelli.goniometer, [w]));
    const ext = hklExtent(settings, settings.map(() => undefined), panelSamples(corelli.detectors!, 8), { kind: "white", lambdaMin: 0.6, lambdaMax: 2.5 }, UB, I3)!;
    expect(ext.min[0]).toBeCloseTo(-ext.max[0]!, 1);
    expect(ext.min[2]).toBeCloseTo(-ext.max[2]!, 1);
    // A projection along [1 1 0]/[−1 1 0]/[0 0 1] uses the same data: |x| ≤ |h|max·√2/... bounded by qMax.
    const W: Mat3 = [
      [1, -1, 0],
      [1, 1, 0],
      [0, 0, 1],
    ];
    const rot = hklExtent(settings, settings.map(() => undefined), panelSamples(corelli.detectors!, 8), { kind: "white", lambdaMin: 0.6, lambdaMax: 2.5 }, UB, W)!;
    expect(rot.qMax).toBeCloseTo(ext.qMax, 10);
    expect(Math.max(-rot.min[0]!, rot.max[0]!) * Math.SQRT2 * ((2 * Math.PI) / 5)).toBeLessThanOrEqual(ext.qMax + 1e-9);
  });
});
