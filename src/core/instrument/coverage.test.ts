import { describe, expect, it } from "vitest";
import type { Vec3 } from "@materia/core/math/types";
import { mulMat, mulVec } from "@materia/core/math/mat3";
import instruments from "../../data/instruments.json";
import { axisRotation, goniometerMatrix, laueCondition } from "../ub/goniometer.ts";
import { UNIVERSAL } from "../ub/instruments.ts";
import { ubFromU } from "../ub/ub.ts";
import { coveragePanelLambdas, coverageSolver } from "./coverage.ts";
import { rayHit, type DetectorPanel } from "./detectors.ts";
import { cylinderAngles, directionAngles, reflectionCoverage } from "./simulate.ts";

const DEG = Math.PI / 180;
const I: [Vec3, Vec3, Vec3] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const cubic = (a: number) => ubFromU(I, { a, b: a, c: a, alpha: 90, beta: 90, gamma: 90 });
const dirOf = (gammaDeg: number, nuDeg: number): Vec3 => [Math.cos(nuDeg * DEG) * Math.sin(gammaDeg * DEG), Math.sin(nuDeg * DEG), Math.cos(nuDeg * DEG) * Math.cos(gammaDeg * DEG)];
const angleBetween = (a: Vec3, b: Vec3) => Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / Math.hypot(...a) / Math.hypot(...b))));

const omegaOnly = { ...UNIVERSAL, axes: [{ ...UNIVERSAL.axes[0]!, min: 0, max: 360 }] };
const ambient = { ...UNIVERSAL, axes: [{ ...UNIVERSAL.axes[0]!, min: 0, max: 360 }, { ...UNIVERSAL.axes[1]!, fixed: 135 }, { ...UNIVERSAL.axes[2]!, min: 0, max: 360 }] };
const topaz = instruments.instruments.find((i) => i.id === "TOPAZ")!;
const panels = topaz.panels as unknown as DetectorPanel[];

describe("exact coverage solver", () => {
  it("forward check: the returned angles really send the reflection along u at the returned λ", () => {
    const UB = cubic(8.0844);
    const hs: Vec3[] = [
      [0, 0, 4],
      [4, 0, 0],
      [0, -4, 0],
    ];
    const solver = coverageSolver(ambient, UB, hs, 0.4, 3.5);
    let solved = 0;
    for (let g = -170; g <= 170; g += 7)
      for (let n = -50; n <= 50; n += 7) {
        const u = dirOf(g, n);
        const sol = solver.solve(u, 1e-7);
        if (!sol) continue;
        solved++;
        const q = mulVec(mulMat(goniometerMatrix(ambient, sol.angles), UB), hs[sol.reflection]!);
        const l = laueCondition(q);
        expect(angleBetween(l.kf, u)).toBeLessThan(1e-5);
        expect(l.lambda).toBeCloseTo(sol.lambda, 5);
      }
    expect(solved).toBeGreaterThan(100);
  });

  it("covers every landing position the stepped (NeuXtalViz-style) sweep finds", () => {
    const UB = cubic(5.431);
    const h: Vec3 = [4, 0, 0];
    const solver = coverageSolver(ambient, UB, [h], 0.4, 3.5);
    const cov = reflectionCoverage(ambient, [0, 135, 0], UB, [{ h }], panels, 0.4, 3.5, 4);
    expect(cov.points.length).toBeGreaterThan(100);
    for (const p of cov.points) {
      const u = p.hit.position;
      const l2 = Math.hypot(...u);
      const sol = solver.solve([u[0] / l2, u[1] / l2, u[2] / l2], 1e-7);
      expect(sol).toBeDefined();
      expect(sol!.lambda).toBeCloseTo(p.lambda, 6);
    }
  });

  it("ω only, q ⟂ ω: only the horizontal plane is reachable (γ = 2ω), and a partial ω range cuts it", () => {
    const UB = cubic(5.431);
    const full = coverageSolver(omegaOnly, UB, [[4, 0, 0]], 0.4, 3.5);
    const tol = 0.1 * DEG;
    expect(full.solve(dirOf(60, 0), tol)).toBeDefined();
    expect(full.solve(dirOf(-60, 0), tol)).toBeDefined();
    expect(full.solve(dirOf(60, 5), tol)).toBeUndefined();
    expect(full.solve(dirOf(60, 0.04), tol)).toBeDefined(); // within the element
    // ω in [0°, 90°]: γ = 2ω in [0°, 180°], so γ = −60° (ω = 330°) is out of reach.
    const part = coverageSolver({ ...omegaOnly, axes: [{ ...omegaOnly.axes[0]!, min: 0, max: 90 }] }, UB, [[4, 0, 0]], 0.4, 3.5);
    expect(part.solve(dirOf(60, 0), tol)?.angles[0]).toBeCloseTo(30, 6);
    expect(part.solve(dirOf(-60, 0), tol)).toBeUndefined();
  });

  it("an element is reached when the track crosses it: |ν| ≤ its half-size at every 2θ (q̂ moves 1/(2 sin θ) as fast as u azimuthally)", () => {
    // ω only, q along a: the track is the horizontal plane. An element of angular radius tol centred at elevation ν
    // touches it exactly when |ν| ≤ tol. A single tolerance of tol/2 on q̂ accepted only |ν| ≤ tol·sin θ.
    const solver = coverageSolver(omegaOnly, cubic(10), [[1, 0, 0]], 0.01, 50);
    const tol = 0.1 * DEG;
    for (const tt of [10, 30, 60, 90, 150]) {
      expect(solver.solve(dirOf(tt, 0.9 * 0.1), tol), `2θ ${tt}°`).toBeDefined();
      expect(solver.solve(dirOf(tt, 1.1 * 0.1), tol), `2θ ${tt}°`).toBeUndefined();
    }
  });

  it("panel cells: every cell a dense ω sweep lands in is covered, with at most a cell or so more (TOPAZ cryogenic)", () => {
    const grids = panels.map((p) => ({ nx: Math.min(64, p.nCols), ny: Math.min(128, p.nRows) }));
    // A tilted crystal (U = R_x(25°)·R_z(10°)), so that q along b is not on the ω axis.
    const UB = mulMat(mulMat(axisRotation([1, 0, 0], 25), axisRotation([0, 0, 1], 10)), cubic(8.0844));
    for (const h of [[0, 4, 0], [1, 1, 1], [5, -3, 3]] as Vec3[]) {
      const lam = coveragePanelLambdas(panels, grids, coverageSolver(omegaOnly, UB, [h], 0.4, 3.5));
      const swept = new Set<string>();
      for (let w = 0; w < 360; w += 0.002) {
        const s = laueCondition(mulVec(mulMat(goniometerMatrix(omegaOnly, [w]), UB), h));
        if (!(s.lambda >= 0.4 && s.lambda <= 3.5)) continue;
        const hit = rayHit(panels, s.kf.map((v) => v / Math.hypot(...s.kf)) as unknown as Vec3);
        if (!hit) continue;
        const p = panels[hit.panel]!;
        const g = grids[hit.panel]!;
        swept.add(`${hit.panel}:${Math.floor(((hit.col - 0.5) / p.nCols) * g.nx)}:${Math.floor(((hit.row - 0.5) / p.nRows) * g.ny)}`);
      }
      const covered = new Set<string>();
      lam.forEach((l, k) => l.forEach((v, c) => !Number.isNaN(v) && covered.add(`${k}:${c % grids[k]!.nx}:${Math.floor(c / grids[k]!.nx)}`)));
      expect(swept.size, `${h}`).toBeGreaterThan(20);
      const missed = [...swept].filter((c) => !covered.has(c)).length;
      const extra = [...covered].filter((c) => !swept.has(c)).length;
      expect(missed, `${h} missed`).toBeLessThanOrEqual(1);
      expect(extra, `${h} extra`).toBeLessThanOrEqual(Math.ceil(0.05 * swept.size));
    }
  });

  it("ω, φ with χ = 135°: reachable exactly where |q̂_y| ≤ cos 45°; never outside the Bragg window", () => {
    const UB = cubic(5.431);
    const solver = coverageSolver(ambient, UB, [[4, 0, 0]], 0.4, 3.5);
    const d = 5.431 / 4;
    let inside = 0;
    let outside = 0;
    for (let g = -175; g <= 175; g += 5)
      for (let n = -60; n <= 60; n += 5) {
        const u = dirOf(g, n);
        const tt = directionAngles(u).twoTheta;
        const lambda = 2 * d * Math.sin((tt * DEG) / 2);
        const q = [u[0], u[1], u[2] - 1];
        const qy = Math.abs(q[1]!) / Math.hypot(...q);
        const sol = solver.solve(u, 1e-9);
        if (lambda < 0.4 || lambda > 3.5) {
          expect(sol).toBeUndefined();
          continue;
        }
        if (qy < Math.SQRT1_2 - 1e-3) {
          expect(sol).toBeDefined();
          inside++;
        }
        if (qy > Math.SQRT1_2 + 1e-3) {
          expect(sol).toBeUndefined();
          outside++;
        }
      }
    expect(inside).toBeGreaterThan(100);
    expect(outside).toBeGreaterThan(20);
  });

  it("panel images: covered cells only inside the Bragg window, and low-index large-d reflections on ω alone stay on a couple of panels", () => {
    const grids = panels.map((p) => ({ nx: Math.min(64, p.nCols), ny: Math.min(128, p.nRows) }));
    const UB = cubic(8.0844);
    const solver = coverageSolver(omegaOnly, UB, [[1, 1, 1]], 0.4, 3.5);
    const lam = coveragePanelLambdas(panels, grids, solver);
    const hit = lam.map((l) => l.some((v) => !Number.isNaN(v)));
    const n = hit.filter(Boolean).length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(3);
    for (const l of lam) for (const v of l) if (!Number.isNaN(v)) expect(v >= 0.4 && v <= 3.5).toBe(true);
    // The covered cells lie on a track (one free axis): a thin set, not panel-filling.
    const cells = lam.reduce((s, l) => s + l.filter((v) => !Number.isNaN(v)).length, 0);
    expect(cells).toBeLessThan(0.1 * 64 * 64 * n);
    void cylinderAngles;
  });
});
