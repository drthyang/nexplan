import { describe, expect, it } from "vitest";
import type { Vec3 } from "@materia/core/math/types";
import instruments from "../../data/instruments.json";
import { difcFromGeometry } from "../diffraction/tof.ts";
import { UNIVERSAL } from "../ub/instruments.ts";
import { ubFromU } from "../ub/ub.ts";
import type { DetectorPanel } from "./detectors.ts";
import { coneDirections, coveredTwoTheta, cylinderAngles, dRangeAt, directionAngles, observeAt, panelAngles, panelDifc, panelsSeeing, simulateScan, twoThetaRangeForD } from "./simulate.ts";

const I: [Vec3, Vec3, Vec3] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

describe("angles and powder coverage", () => {
  it("2θ from the beam and azimuth about it", () => {
    expect(directionAngles([0, 0, 1]).twoTheta).toBeCloseTo(0, 12);
    expect(directionAngles([1, 0, 0]).twoTheta).toBeCloseTo(90, 12);
    expect(directionAngles([0, 1, 0]).azimuth).toBeCloseTo(90, 12);
    expect(directionAngles([0, 0, -1]).twoTheta).toBeCloseTo(180, 12);
  });

  it("d range at 2θ follows λ = 2d sinθ", () => {
    const r = dRangeAt(90, 0.5, 3);
    expect(r.dMin).toBeCloseTo(0.5 / (2 * Math.SQRT1_2), 12);
    expect(r.dMax).toBeCloseTo(3 / (2 * Math.SQRT1_2), 12);
  });

  it("unrolled-cylinder angles: γ from the beam towards +x, ν up", () => {
    expect(cylinderAngles([0, 0, 1])).toEqual({ gamma: 0, nu: 0 });
    expect(cylinderAngles([1, 0, 0]).gamma).toBeCloseTo(90, 12);
    expect(cylinderAngles([0, 0, -1]).gamma).toBeCloseTo(180, 12);
    expect(cylinderAngles([0, 1, 1]).nu).toBeCloseTo(45, 12);
    for (const u of coneDirections(60, 12)) expect(directionAngles(u).twoTheta).toBeCloseTo(60, 9);
  });

  it("2θ range of a spacing inverts dRangeAt, and panels are selected by overlap", () => {
    const r = twoThetaRangeForD(1, 0.5, 3)!;
    expect(r.min).toBeCloseTo(2 * (Math.asin(0.25) * 180) / Math.PI, 12);
    expect(r.max).toBe(180); // λmax > 2d: reaches backscattering
    expect(dRangeAt(r.min, 0.5, 3).dMin).toBeCloseTo(1, 12);
    expect(twoThetaRangeForD(0.2, 0.5, 3)).toBeUndefined();
    const a = [
      { twoThetaMin: 10, twoThetaMax: 20, twoThetaCenter: 15, azimuthCenter: 0, l2: 1 },
      { twoThetaMin: 40, twoThetaMax: 50, twoThetaCenter: 45, azimuthCenter: 0, l2: 1 },
      { twoThetaMin: 15, twoThetaMax: 30, twoThetaCenter: 22, azimuthCenter: 0, l2: 1 },
    ];
    expect(panelsSeeing(1, a, 0.5, 3)).toEqual([1, 2]); // 2θ ≥ 28.96°: the 10–20° panel misses it
    expect(panelsSeeing(1, a, 0.5, 0.6)).toEqual([2]); // 2θ 28.96–34.92°
    expect(coveredTwoTheta(a)).toEqual([
      [10, 30],
      [40, 50],
    ]);
  });

  it("panel angles bracket the centre, and DIFC uses L1 + L2", () => {
    const p: DetectorPanel = { name: "x", kind: "rectangular", center: [1, 0, 0], base: [0, 0, 1], up: [0, 1, 0], width: 0.2, height: 0.2, nCols: 10, nRows: 10 };
    const a = panelAngles(p);
    expect(a.twoThetaCenter).toBeCloseTo(90, 12);
    expect(a.twoThetaMin).toBeCloseTo(90 - (Math.atan(0.1) * 180) / Math.PI, 6);
    expect(a.twoThetaMax).toBeCloseTo(90 + (Math.atan(0.1) * 180) / Math.PI, 6);
    expect(panelDifc(p, 20)).toBeCloseTo(difcFromGeometry(21, 90), 9);
  });

  it("NOMAD and POWGEN panels span the angular ranges ORNL quotes", () => {
    const span = (id: string) => {
      const ps = instruments.instruments.find((i) => i.id === id)!.panels as unknown as DetectorPanel[];
      const a = ps.map(panelAngles);
      return [Math.min(...a.map((x) => x.twoThetaMin)), Math.max(...a.map((x) => x.twoThetaMax))];
    };
    const nomad = span("NOMAD");
    expect(nomad[0]).toBeLessThan(4); // ORNL: detector angular range 3–175°
    expect(nomad[1]).toBeGreaterThan(170);
    const powgen = span("POWGEN");
    expect(powgen[0]).toBeGreaterThan(5);
    expect(powgen[1]).toBeLessThan(175);
  });
});

describe("single-crystal observation and rotation scans", () => {
  // A backscattering panel straight upstream: catches q along −z only.
  const back: DetectorPanel = { name: "back", kind: "rectangular", center: [0, 0, -0.5], base: [1, 0, 0], up: [0, 1, 0], width: 0.2, height: 0.2, nCols: 100, nRows: 100 };
  const UB = ubFromU(I, { a: 4, b: 4, c: 4, alpha: 90, beta: 90, gamma: 90 });

  it("observes (0 0 −1) in backscattering at λ = 2d = 8 Å", () => {
    const refl = [
      { h: [0, 0, -1] as Vec3, family: 0 },
      { h: [1, 0, 0] as Vec3, family: 1 },
    ];
    const obs = observeAt(I, UB, refl, [back], 1, 10);
    expect(obs).toHaveLength(1);
    expect(obs[0]!.index).toBe(0);
    expect(obs[0]!.lambda).toBeCloseTo(8, 12);
    expect(obs[0]!.hit.col).toBeCloseTo(50.5, 9);
  });

  it("completeness grows monotonically over a scan and reaches 1 when every family is seen", () => {
    const refl = [
      { h: [0, 0, -1] as Vec3, family: 0 },
      { h: [1, 0, 0] as Vec3, family: 1 },
      { h: [-1, 0, 0] as Vec3, family: 1 },
    ];
    const scan = simulateScan(UNIVERSAL, 0, [0, 0, 0], { start: 0, end: 270, step: 90 }, UB, refl, [back], 1, 10);
    expect(scan.steps).toHaveLength(4);
    for (let i = 1; i < scan.steps.length; i++) expect(scan.steps[i]!.completeness).toBeGreaterThanOrEqual(scan.steps[i - 1]!.completeness);
    expect(scan.families).toBe(2);
    expect(scan.observedFamilies).toBe(2);
    expect(scan.steps.at(-1)!.completeness).toBe(1);
  });
});
