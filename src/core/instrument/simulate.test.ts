import { describe, expect, it } from "vitest";
import type { Vec3 } from "@materia/core/math/types";
import instruments from "../../data/instruments.json";
import { difcFromGeometry } from "../diffraction/tof.ts";
import { goniometerMatrix, laueCondition } from "../ub/goniometer.ts";
import { UNIVERSAL } from "../ub/instruments.ts";
import { mulMat, mulVec } from "@materia/core/math/mat3";
import { ubFromU } from "../ub/ub.ts";
import type { DetectorPanel } from "./detectors.ts";
import { braggCrossings, crossingsToScan, coneDirections, coveredTwoTheta, cylinderAngles, dRangeAt, directionAngles, observeAt, panelAngles, panelDifc, panelsSeeing, simulateScan, twoThetaRangeForD } from "./simulate.ts";

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

describe("SNS chopper spectrometers: coverage from the Mantid IDFs vs ORNL specifications", () => {
  // Pixel-centre angles: γ horizontal from the beam, ν elevation (simulate.ts cylinderAngles).
  const coverage = (id: string, keep: (p: DetectorPanel) => boolean = () => true) => {
    const ins = instruments.instruments.find((i) => i.id === id)!;
    const ps = (ins.panels as unknown as DetectorPanel[]).filter(keep);
    let gLo = Infinity, gHi = -Infinity, nLo = Infinity, nHi = -Infinity, l2Lo = Infinity, l2Hi = -Infinity;
    for (const p of ps) {
      l2Lo = Math.min(l2Lo, Math.hypot(...p.center));
      l2Hi = Math.max(l2Hi, Math.hypot(...p.center));
      for (let i = 0; i < p.nCols; i++)
        for (let j = 0; j < p.nRows; j++) {
          const x = ((i + 0.5) / p.nCols - 0.5) * p.width;
          const y = ((j + 0.5) / p.nRows - 0.5) * p.height;
          const v = [0, 1, 2].map((k) => p.center[k]! + x * p.base[k]! + y * p.up[k]!) as unknown as Vec3;
          const { gamma, nu } = cylinderAngles(v);
          gLo = Math.min(gLo, gamma);
          gHi = Math.max(gHi, gamma);
          nLo = Math.min(nLo, nu);
          nHi = Math.max(nHi, nu);
        }
    }
    return { l1: ins.l1, panels: ps.length, gLo, gHi, nLo, nHi, l2Lo, l2Hi };
  };

  it("ARCS: L1 13.6 m, detectors 3.0–3.4 m, −28° to 135° horizontal, −27° to 26° vertical (ORNL ARCS spec sheet)", () => {
    const c = coverage("ARCS");
    expect(c.panels).toBe(115);
    expect(c.l1).toBeCloseTo(13.6, 6);
    expect(c.l2Lo).toBeGreaterThan(2.95);
    expect(c.l2Hi).toBeLessThan(3.4);
    expect(c.gLo).toBeCloseTo(-28, 0);
    expect(Math.abs(c.gHi - 135)).toBeLessThan(1.5);
    expect(Math.abs(c.nLo + 27)).toBeLessThan(1);
    expect(Math.abs(c.nHi - 26)).toBeLessThan(1);
  });

  it("SEQUOIA: L1 20.0 m, detectors 5.5–6.3 m, −30° to 60° horizontal, ±18° vertical for rows B–D (ORNL SEQUOIA spec sheet)", () => {
    const all = coverage("SEQUOIA");
    expect(all.panels).toBe(117);
    expect(all.l1).toBeCloseTo(20.0, 1);
    expect(all.l2Lo).toBeGreaterThan(5.4);
    expect(all.l2Hi).toBeLessThan(6.3);
    expect(Math.abs(all.gLo + 30)).toBeLessThan(1);
    expect(Math.abs(all.gHi - 60)).toBeLessThan(1);
    // ORNL's ±18° describes rows B–D; the four A-row packs below them reach ν ≈ −30°.
    const bd = coverage("SEQUOIA", (p) => !p.name.startsWith("A"));
    expect(bd.panels).toBe(113);
    expect(Math.abs(bd.nHi - 18)).toBeLessThan(1.5);
    expect(Math.abs(bd.nLo + 18)).toBeLessThan(2);
    expect(all.nLo).toBeLessThan(-29);
  });

  it("CNCS: L1 36.2 m, detectors 3.5 m, ±16° vertical (ORNL CNCS spec sheet); horizontal span as the IDF gives it", () => {
    const c = coverage("CNCS");
    expect(c.panels).toBe(50);
    expect(c.l1).toBeCloseTo(36.26, 2);
    expect(c.l2Lo).toBeGreaterThan(3.45);
    expect(c.l2Hi).toBeLessThan(3.52);
    expect(Math.abs(c.nLo + 16)).toBeLessThan(0.5);
    expect(Math.abs(c.nHi - 16)).toBeLessThan(0.5);
    // ORNL quotes −50° to +140°; the current IDF spans −53.6° to 132.6° (186°, vs 190° quoted). Recorded, not hidden.
    expect(c.gLo).toBeCloseTo(-53.6, 0);
    expect(c.gHi).toBeCloseTo(132.6, 0);
  });
});

describe("monochromatic rotation scans: exact Bragg crossings", () => {
  // Six 2 m faces at 1 m: every direction lands on a panel.
  const faces: [Vec3, Vec3, Vec3][] = [
    [[1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [1, 0, 0], [0, 1, 0]],
  ];
  const cube: DetectorPanel[] = faces.map(([center, base, up], i) => ({ name: `f${i}`, kind: "rectangular", center, base, up, width: 2.0001, height: 2.0001, nCols: 1, nRows: 1 }));
  const UB = ubFromU(
    [
      [0.8, 0.6, 0],
      [-0.6, 0.8, 0],
      [0, 0, 1],
    ],
    { a: 4.1, b: 5.3, c: 6.2, alpha: 90, beta: 97, gamma: 90 },
  );
  const refl: { h: Vec3; family: number }[] = [];
  for (let h = -2; h <= 2; h++) for (let k = -2; k <= 2; k++) for (let l = -2; l <= 2; l++) if (h || k || l) refl.push({ h: [h, k, l], family: refl.length });
  const lambda = 1.7;
  const base = [0, 30, 0]; // χ = 30° tilts the rotation geometry away from the trivial case
  const model = UNIVERSAL;

  it("matches a brute-force 0.01° scan, and λ is exactly the incident wavelength at every crossing", () => {
    const exact = braggCrossings(model, 0, base, { start: 0, end: 360 }, UB, refl, cube, lambda);
    expect(exact.length).toBeGreaterThan(40);
    for (const c of exact) {
      const R = goniometerMatrix(model, base.map((v, i) => (i === 0 ? c.angle : v)));
      expect(laueCondition(mulVec(mulMat(R, UB), refl[c.index]!.h)).lambda).toBeCloseTo(lambda, 9);
      expect(c.hit).toBeDefined();
    }
    // Brute force: sign changes of λ(ψ) − λ0, refined by linear interpolation.
    const brute: { index: number; angle: number }[] = [];
    const f = (i: number, deg: number) => {
      const R = goniometerMatrix(model, base.map((v, j) => (j === 0 ? deg : v)));
      const q = mulVec(mulMat(R, UB), refl[i]!.h);
      const q2 = q[0] ** 2 + q[1] ** 2 + q[2] ** 2;
      return q[2] + (lambda * q2) / 2; // zero at the Bragg condition, smooth in ψ
    };
    const step = 0.01;
    refl.forEach((_, i) => {
      let prev = f(i, 0);
      for (let a = step; a <= 360 + 1e-9; a += step) {
        const cur = f(i, a);
        if (prev === 0 || prev * cur < 0) brute.push({ index: i, angle: a - step + (step * prev) / (prev - cur) });
        prev = cur;
      }
    });
    expect(brute.length).toBe(exact.length);
    for (const b of brute) {
      const m = exact.find((e) => e.index === b.index && Math.abs(e.angle - b.angle) < 0.01);
      expect(m).toBeDefined();
    }
  });

  it("bins crossings into steps with monotonic completeness, wrapping the scan range", () => {
    const exact = braggCrossings(model, 0, base, { start: -180, end: 540 }, UB, refl, cube, lambda);
    const once = braggCrossings(model, 0, base, { start: 0, end: 360 }, UB, refl, cube, lambda);
    expect(exact.length).toBeGreaterThanOrEqual(2 * once.length - 2); // two turns
    const scan = crossingsToScan(exact, refl, 0, base, { start: -180, end: 540, step: 1 });
    expect(scan.steps).toHaveLength(721);
    expect(scan.steps.reduce((n, s) => n + s.observed, 0)).toBe(exact.length);
    for (let i = 1; i < scan.steps.length; i++) expect(scan.steps[i]!.completeness).toBeGreaterThanOrEqual(scan.steps[i - 1]!.completeness);
  });
});
