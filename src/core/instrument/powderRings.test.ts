import { describe, expect, it } from "vitest";
import type { Vec3 } from "@materia/core/math/types";
import instruments from "../../data/instruments.json";
import { NEUTRON_MASS_OVER_H as K } from "../diffraction/tof.ts";
import type { DetectorPanel } from "./detectors.ts";
import { elasticPattern, mapCells, panelCells, ringIntensity, ringProfile, ringTrace, sliceLambda } from "./powderRings.ts";
import { cylinderAngles } from "./simulate.ts";

const DEG = Math.PI / 180;

describe("powder ring intensities", () => {
  it("a TOF slice lights the element whose d = t/(K·L·2 sinθ) matches the line", () => {
    const p = ringProfile([{ d: 1, sumF2: 5 }], "tof", 0.005);
    const t = K * 20 * 2 * 1 * Math.sin(45 * DEG);
    expect(sliceLambda({ tof: t }, 20)).toBeCloseTo(2 * Math.sin(45 * DEG), 12);
    expect(ringIntensity(p, { tof: t }, 90, 20)).toBeCloseTo(Math.sin(45 * DEG), 4); // peak 1 × sinθ
    // 3σ off in ln d (σ = 0.005/2.3548): the Gaussian has fallen to e^(−4.5).
    const off = Math.exp((3 * 0.005) / 2.3548);
    expect(ringIntensity(p, { tof: t * off }, 90, 20) / ringIntensity(p, { tof: t }, 90, 20)).toBeCloseTo(Math.exp(-4.5), 3);
    // A longer flight path at the same time sees a shorter wavelength, so a smaller d.
    expect(ringIntensity(p, { tof: t }, 90, 21)).toBeLessThan(1e-6);
  });

  it("at fixed λ the ring sits at 2θ = 2 asin(λ/2d)", () => {
    const p = ringProfile([{ d: 1, sumF2: 1 }], "fixed", 0.002);
    const ring = 2 * Math.asin(0.6) / DEG;
    expect(ringIntensity(p, { lambda: 1.2 }, ring, 3)).toBeCloseTo(1, 4);
    expect(ringIntensity(p, { lambda: 1.2 }, ring - 1, 3)).toBeLessThan(1e-6);
  });

  it("fixed λ: the power in a whole cone follows the CW powder Lorentz factor, ∝ Σ|F|²/sinθ", () => {
    const lines = [
      { d: 2, sumF2: 1 },
      { d: 0.8, sumF2: 1 },
    ];
    const p = ringProfile(lines, "fixed", 1e-3);
    const lambda = 1.2;
    const conePower = (d: number) => {
      const c = (2 * Math.asin(lambda / (2 * d))) / DEG;
      let s = 0;
      const h = 0.0005;
      for (let t = c - 1.5; t <= c + 1.5; t += h) s += ringIntensity(p, { lambda }, t, 3) * 2 * Math.PI * Math.sin(t * DEG) * h * DEG;
      return s;
    };
    const ratio = conePower(2) / conePower(0.8);
    const sin = (d: number) => lambda / (2 * d);
    expect(ratio).toBeCloseTo(sin(0.8) / sin(2), 2);
  });

  it("TOF: integrated over time at one element, a line scales as Σ|F|²·d⁴·sinθ", () => {
    const p = ringProfile([{ d: 1, sumF2: 1 }], "tof", 2e-3);
    const integral = (twoTheta: number) => {
      const t0 = K * 20 * 2 * Math.sin((twoTheta * DEG) / 2);
      let s = 0;
      for (let x = -0.02; x <= 0.02; x += 1e-5) s += ringIntensity(p, { tof: t0 * Math.exp(x) }, twoTheta, 20) * 1e-5;
      return s;
    };
    expect(integral(150) / integral(40)).toBeCloseTo(Math.sin(75 * DEG) / Math.sin(20 * DEG), 4);
  });
});

describe("detector cells", () => {
  const side: DetectorPanel = { name: "side", kind: "rectangular", center: [1, 0, 0], base: [0, 0, -1], up: [0, 1, 0], width: 0.2, height: 0.2, nCols: 10, nRows: 10 };
  const back: DetectorPanel = { name: "back", kind: "rectangular", center: [0, 0, -0.5], base: [1, 0, 0], up: [0, 1, 0], width: 0.2, height: 0.2, nCols: 10, nRows: 10 };

  it("panel cells run from the (−w/2, −h/2) corner, rows along up", () => {
    const c = panelCells(side, 1, 1);
    expect(c.twoTheta[0]).toBeCloseTo(90, 4);
    expect(c.l2[0]).toBeCloseTo(1, 6);
    const g = panelCells(side, 2, 2);
    // Column 0 is at −w/2 along base = +z (forward), so at a smaller 2θ than column 1.
    expect(g.twoTheta[0]!).toBeLessThan(g.twoTheta[1]!);
    expect(g.twoTheta[0]).toBeCloseTo(g.twoTheta[2]!, 5); // rows mirror about the horizontal plane
  });

  it("the map raster finds panels across the γ = ±180° seam and leaves gaps empty", () => {
    const m = mapCells([side, back], 360, 90, 45);
    const at = (gamma: number, nu: number) => Math.floor((nu > 0 ? 45 - nu : 45 - nu) - 0.5) * 360 + Math.floor(gamma + 180);
    expect(m.panel[at(-179.5, 0.5)]).toBe(1);
    expect(m.panel[at(179.5, 0.5)]).toBe(1);
    expect(m.twoTheta[at(179.5, 0.5)]!).toBeGreaterThan(178);
    expect(m.l2[at(179.5, 0.5)]).toBeCloseTo(0.5, 3);
    expect(m.panel[at(90.5, 0.5)]).toBe(0);
    expect(m.panel[at(0.5, 0.5)]).toBe(-1);
    expect(Number.isNaN(m.twoTheta[at(0.5, 0.5)])).toBe(true);
  });
});

describe("rings on real detectors (ray-traced cross-check)", () => {
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const twoThetaOf = (v: Vec3) => Math.acos(v[2] / Math.hypot(...v)) / DEG;

  for (const id of ["NOMAD", "POWGEN"]) {
    const ins = instruments.instruments.find((i) => i.id === id)!;
    const panels = ins.panels as unknown as DetectorPanel[];
    const l1 = ins.l1;
    const d = 1.2;
    const tof = K * (l1 + 1.5) * (id === "NOMAD" ? 1.5 : 1.0);

    it(`${id}: the traced ring satisfies t = K·(L1 + L2)·2d·sinθ and lands in panel-image cells at its own 2θ`, () => {
      const trace = ringTrace(panels, l1, { tof }, d, 1440);
      const pts = trace.flatMap((s) => s.points.map((x) => ({ panel: s.panel, x })));
      expect(pts.length).toBeGreaterThan(50);
      let worst = 0;
      for (const { panel, x } of pts) {
        const l2 = Math.hypot(...x);
        const tt = twoThetaOf(x);
        // The TOF condition, to the iteration tolerance.
        expect(Math.abs(K * (l1 + l2) * 2 * d * Math.sin((tt * DEG) / 2) - tof) / tof).toBeLessThan(1e-9);
        // The element grid cell that contains this point (rows from the (−w/2, −h/2) corner along up).
        const p = panels[panel]!;
        const nx = Math.min(64, p.nCols);
        const ny = Math.min(128, p.nRows);
        const off: Vec3 = [x[0] - p.center[0], x[1] - p.center[1], x[2] - p.center[2]];
        const i = Math.min(nx - 1, Math.floor((dot(off, p.base) / p.width + 0.5) * nx));
        const j = Math.min(ny - 1, Math.floor((dot(off, p.up) / p.height + 0.5) * ny));
        const cells = panelCells(p, nx, ny);
        const halfDiag = Math.hypot(p.width / nx, p.height / ny) / 2 / l2 / DEG; // angular half-diagonal of a cell
        const err = Math.abs(cells.twoTheta[j * nx + i]! - tt);
        expect(err).toBeLessThanOrEqual(halfDiag * 1.01);
        worst = Math.max(worst, err / halfDiag);
      }
      expect(worst).toBeGreaterThan(0); // the check is not vacuous
    });

    it(`${id}: the map raster cell under each traced point is on the same panel at its 2θ`, () => {
      const W = 720;
      const H = 240;
      const nuMax = 60;
      const m = mapCells(panels, W, H, nuMax);
      const trace = ringTrace(panels, l1, { tof }, d, 720);
      let total = 0;
      let same = 0;
      for (const s of trace)
        for (const x of s.points) {
          total++;
          const { gamma, nu } = cylinderAngles(x);
          const c = Math.min(H - 1, Math.floor(((nuMax - nu) / (2 * nuMax)) * H)) * W + Math.min(W - 1, Math.floor(((gamma + 180) / 360) * W));
          if (m.panel[c] !== s.panel) continue; // the cell centre falls just off this panel (edge or gap)
          same++;
          expect(Math.abs(m.twoTheta[c]! - twoThetaOf(x))).toBeLessThan(0.75); // half-diagonal of a 0.5° cell
        }
      console.log(`${id}: ${same}/${total} traced points checked on the map raster`);
      expect(total).toBeGreaterThan(30);
      expect(same / total).toBeGreaterThan(0.8);
    });
  }

  it("a single line peaks on its traced ring: intensity there is the line maximum × sinθ", () => {
    const ins = instruments.instruments.find((i) => i.id === "NOMAD")!;
    const panels = ins.panels as unknown as DetectorPanel[];
    const prof = ringProfile([{ d: 1.2, sumF2: 1 }], "tof", 0.01);
    const tof = K * (ins.l1 + 1.5) * 1.5;
    for (const s of ringTrace(panels, ins.l1, { tof }, 1.2, 360))
      for (const x of s.points) {
        const tt = Math.acos(x[2] / Math.hypot(...x)) / DEG;
        expect(ringIntensity(prof, { tof }, tt, ins.l1 + Math.hypot(...x))).toBeCloseTo(Math.sin((tt * DEG) / 2), 4);
      }
  });
});

describe("elastic powder pattern", () => {
  it("peaks keep their integrated intensity, widen as 2·tanθ·Δd/d, and vanish in detector gaps", () => {
    const peaks = [
      { twoTheta: 30, intensity: 2 },
      { twoTheta: 100, intensity: 5 },
      { twoTheta: 70, intensity: 7 }, // falls in the gap
    ];
    const { x, y } = elasticPattern(peaks, 0.01, [
      [10, 60],
      [80, 130],
    ]);
    let area = 0;
    for (let i = 1; i < x.length; i++) area += 0.5 * (y[i]! + y[i - 1]!) * (x[i]! - x[i - 1]!);
    expect(area).toBeCloseTo(7, 3);
    expect(Math.max(...y.filter((_, i) => x[i]! > 65 && x[i]! < 75))).toBe(0);
    // FWHM in degrees at 2θ = 100°: 2·tan(50°)·0.01 rad.
    const fwhm = (2 * Math.tan(50 * DEG) * 0.01) / DEG;
    const at = (t: number) => {
      const f = (t - x[0]!) / (x[1]! - x[0]!);
      const i = Math.floor(f);
      return y[i]! + (f - i) * (y[i + 1]! - y[i]!);
    };
    expect(at(100 + fwhm / 2) / at(100)).toBeCloseTo(0.5, 3);
  });
});
