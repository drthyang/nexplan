import type { Mat3, Vec3 } from "@materia/core/math/types";
import { mulVec } from "@materia/core/math/mat3";
import { describe, expect, it } from "vitest";
import { goniometerMatrix } from "../ub/goniometer.ts";
import { SNS_INSTRUMENTS } from "../ub/instrumentsSns.ts";
import { applyMasks } from "./acceptance.ts";
import { acceptance, directQ, dReach, fibonacciSphere, mergeIntervals } from "./capability.ts";
import { rayHit, type DetectorPanel } from "./detectors.ts";
import { directionTable, recordedCounts } from "./directionTable.ts";
import { pointCoverage } from "./simulate.ts";

const instrument = (id: string) => SNS_INSTRUMENTS.find((i) => i.id === id)!;

describe("detector acceptance", () => {
  it("gives the solid angle of a square panel facing the sample, Ω = 4 asin(s²/(s² + 4L²))", () => {
    const s = 0.4;
    const L = 0.5;
    const panel: DetectorPanel = { name: "square", kind: "rectangular", center: [0, 0, L], base: [1, 0, 0], up: [0, 1, 0], width: s, height: s, nCols: 64, nRows: 64 };
    const a = acceptance([panel], undefined, { directions: 200_000 });
    const exact = 4 * Math.asin((s * s) / (s * s + 4 * L * L));
    expect(a.solidAngle).toBeCloseTo(exact, 2);
    expect(a.twoTheta[0]![0]).toBeCloseTo(0, 6);
    expect(a.elevation.max).toBeCloseTo((Math.atan(s / 2 / L) * 180) / Math.PI, 0);
  });

  it("counts overlapping panels once and masked pixels not at all", () => {
    const nomad = instrument("nomad").detectors!;
    const a = acceptance(nomad, undefined, { directions: 20_000 });
    const sampled = fibonacciSphere(20_000).filter((u) => rayHit(nomad, u)).length / 20_000;
    expect(a.fraction).toBeCloseTo(sampled, 6);
    const half = applyMasks(nomad, { edgeRows: 0, edgeCols: 0, panelsOff: nomad.slice(0, 40).map((p) => p.name) });
    expect(acceptance(half, undefined, { directions: 20_000 }).fraction).toBeLessThan(a.fraction - 0.05);
  });

  it("matches the ORNL spec sheets' vertical coverage: ARCS −27° to 26°, CNCS ±16°", () => {
    const arcs = acceptance(instrument("arcs").detectors!, undefined, { directions: 1000 });
    expect(arcs.elevation.min).toBeCloseTo(-27, 0);
    expect(arcs.elevation.max).toBeCloseTo(26, 0);
    const cncs = acceptance(instrument("cncs").detectors!, undefined, { directions: 1000 });
    expect(Math.abs(cncs.elevation.min + 16)).toBeLessThan(0.5);
    expect(Math.abs(cncs.elevation.max - 16)).toBeLessThan(0.5);
  });

  it("merges intervals closer than the gap", () => {
    expect(mergeIntervals([[0, 1], [1.5, 2], [5, 6]], 1)).toEqual([[0, 2], [5, 6]]);
    expect(mergeIntervals([[5, 6], [0, 1]])).toEqual([[0, 1], [5, 6]]);
  });
});

describe("reach and kinematics", () => {
  it("d = λ/(2 sin θ) at the ends of the band and the angles", () => {
    const r = dReach(30, 150, 0.5, 3);
    expect(r.dMin).toBeCloseTo(0.5 / (2 * Math.sin((75 * Math.PI) / 180)), 12);
    expect(r.dMax).toBeCloseTo(3 / (2 * Math.sin((15 * Math.PI) / 180)), 12);
  });

  it("elastic |Q| = 4π sin θ / λ, and Q grows with the energy transfer at small angles", () => {
    const lambda = Math.sqrt(81.80421 / 25);
    expect(directQ(25, 0, 90)).toBeCloseTo((4 * Math.PI * Math.sin(Math.PI / 4)) / lambda, 4);
    expect(directQ(25, 10, 5)).toBeGreaterThan(directQ(25, 0, 5));
    expect(directQ(25, 25, 90)).toBeNaN();
  });

  it("spreads directions evenly", () => {
    const d = fibonacciSphere(5000);
    const mean = d.reduce((m, u) => [m[0] + u[0], m[1] + u[1], m[2] + u[2]], [0, 0, 0]).map((x) => x / d.length);
    expect(Math.hypot(...mean)).toBeLessThan(1e-3);
    expect(d.every((u) => Math.abs(Math.hypot(...u) - 1) < 1e-12)).toBe(true);
  });
});

describe("the direction table", () => {
  it("agrees with rayHit except within its step of a panel edge (TOPAZ, CORELLI, SEQUOIA)", () => {
    const dirs = fibonacciSphere(40_000);
    for (const id of ["topaz-cryo", "corelli", "sequoia"]) {
      const panels = instrument(id).detectors!;
      const table = directionTable(panels);
      let hits = 0;
      let disagree = 0;
      for (const u of dirs) {
        const exact = rayHit(panels, u) !== undefined;
        if (exact) hits++;
        if (exact !== table.records(u[0], u[1], u[2])) disagree++;
      }
      expect(disagree / hits).toBeLessThan(0.025);
    }
  });

  it("counts settings as pointCoverage does, up to directions at a panel edge", () => {
    const corelli = instrument("corelli");
    const settings = Array.from({ length: 40 }, (_, k) => [9 * k]);
    const qs: Vec3[] = fibonacciSphere(1500).map((u) => [0.6 * u[0], 0.6 * u[1], 0.6 * u[2]]);
    const fast = recordedCounts(corelli.goniometer, settings, qs, directionTable(corelli.detectors!), corelli.lambdaMin, corelli.lambdaMax);
    const exact = pointCoverage(settings.map((a) => goniometerMatrix(corelli.goniometer, a)), qs, corelli.detectors!, corelli.lambdaMin, corelli.lambdaMax);
    let diff = 0;
    let total = 0;
    fast.forEach((c, i) => {
      diff += Math.abs(c - exact[i]!);
      total += exact[i]!;
    });
    expect(total).toBeGreaterThan(1000);
    expect(diff / total).toBeLessThan(0.02);
  });

  it("records nothing through a switched-off panel", () => {
    const topaz = instrument("topaz-cryo").detectors!;
    const off = applyMasks(topaz, { edgeRows: 0, edgeCols: 0, panelsOff: topaz.map((p) => p.name) });
    const table = directionTable(off);
    const R: Mat3 = goniometerMatrix(instrument("topaz-cryo").goniometer, [0]);
    expect(fibonacciSphere(2000).some((u) => {
      const v = mulVec(R, u);
      return table.records(v[0], v[1], v[2]);
    })).toBe(false);
  });
});
