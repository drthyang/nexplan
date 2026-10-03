/**
 * Exact reflection coverage, solved per detector element.
 *
 * A reflection h (q = UB·h in the sample frame, d = 1/|q|) reaches the
 * detector element along unit direction u when a goniometer setting turns q
 * onto q̂ = (u − ẑ)/|u − ẑ| (k_f = k_i + q with k_i along +z) and the
 * wavelength λ = 2d·sin θ, 2θ = ∠(u, ẑ), is in the band.
 *
 * The goniometer is R = R₀·R₁·…; with the fixed axes collected into M's:
 *  - one free axis:  R = M₀·Rot(n₁, s₁a)·M₁. Rotating about n₁ keeps the
 *    component along n₁, so w = M₁·q̂ₛ and t = M₀ᵀ·q̂ need w·n₁ = t·n₁; the
 *    angle a then follows from the components perpendicular to n₁.
 *  - two free axes:  R = M₀·Rot(n₁, s₁a)·M₁·Rot(n₂, s₂b)·M₂. The component
 *    of M₁·Rot(n₂, s₂b)·w along n₁ is C + P cos(s₂b) + Q sin(s₂b) (Rodrigues),
 *    which must equal t·n₁: at most two b per turn, each giving one a.
 * Both angles are checked against the axis ranges. Elements are pixels of
 * finite size, so the conditions are met within the element's angular
 * half-size (k_f turns twice as fast as q, so q̂ gets half of it).
 *
 * This is the continuous version of NeuXtalViz's stepped "individual peak"
 * coverage (simulate.ts reflectionCoverage), without sampling gaps.
 */
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { mulMat, mulVec, transpose } from "@materia/core/math/mat3";
import { axisRotation, type GoniometerModel } from "../ub/goniometer.ts";
import type { DetectorPanel } from "./detectors.ts";

const DEG = Math.PI / 180;
const I3: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const unit = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(...a));
const clamp1 = (x: number) => Math.max(-1, Math.min(1, x));

/** Some angle ≡ deg (mod 360) inside [min − slack, max + slack]. */
function inRange(deg: number, min: number, max: number, slack: number): number | undefined {
  if (max - min >= 360 - 1e-9) return deg;
  const lo = min - slack;
  const k = Math.ceil((lo - deg) / 360 - 1e-12);
  const a = deg + 360 * k;
  return a <= max + slack ? a : undefined;
}

interface Axis {
  readonly index: number;
  readonly n: Vec3;
  readonly s: 1 | -1;
  readonly min: number;
  readonly max: number;
}

export interface CoverageSolution {
  /** Wavelength (Å) at which the reflection reaches this direction. */
  readonly lambda: number;
  /** Goniometer angles (deg) that send it there; fixed axes at their fixed values. */
  readonly angles: readonly number[];
  /** Which of the given reflections (e.g. which symmetry equivalent). */
  readonly reflection: number;
}

export interface CoverageSolver {
  readonly d: number;
  /** Whether some allowed setting sends a reflection along unit direction u (element half-size tolKf, rad). */
  solve(u: Vec3, tolKf: number): CoverageSolution | undefined;
}

/**
 * Solver for reflections `hs` sharing one d-spacing (a reflection and its
 * equivalents), with the free (not `fixed`) goniometer axes swept over their
 * [min, max] ranges. Supports one or two free axes.
 */
export function coverageSolver(model: GoniometerModel, UB: Mat3, hs: readonly Vec3[], lambdaMin: number, lambdaMax: number): CoverageSolver {
  const axes = model.axes;
  const free: Axis[] = axes
    .map((ax, index) => ({ ax, index }))
    .filter(({ ax }) => ax.fixed === undefined)
    .map(({ ax, index }) => ({ index, n: unit(ax.direction), s: ax.sense, min: ax.min, max: ax.max }));
  if (free.length < 1 || free.length > 2) throw new Error(`Exact coverage needs one or two free goniometer axes (this goniometer has ${free.length}).`);
  const fixedProduct = (from: number, to: number): Mat3 => {
    let M = I3;
    for (let i = from; i < to; i++) M = mulMat(M, axisRotation(axes[i]!.direction, axes[i]!.sense * (axes[i]!.fixed ?? 0)));
    return M;
  };
  const f1 = free[0]!;
  const f2 = free[1];
  const M0 = fixedProduct(0, f1.index);
  const M0t = transpose(M0);
  const M1 = fixedProduct(f1.index + 1, f2 ? f2.index : axes.length);
  const M2 = f2 ? fixedProduct(f2.index + 1, axes.length) : I3;
  const qs = hs.map((h) => mulVec(UB, h));
  const d = 1 / Math.hypot(...qs[0]!);
  // Directions after the innermost fixed rotations: w = M₁·q̂ₛ (one free axis) or M₂·q̂ₛ (two).
  const ws = qs.map((q) => mulVec(f2 ? M2 : M1, unit(q)));
  const m = f2 ? mulVec(transpose(M1), f1.n) : f1.n; // n₁ᵀ·M₁·v = m·v

  const anglesOf = (a: number, b?: number) => axes.map((ax, i) => (ax.fixed !== undefined ? ax.fixed : i === f1.index ? a : f2 && i === f2.index ? b! : 0));

  /** Outer (or only) axis: the angle that turns w onto t about n₁, if allowed. */
  const outer = (w: Vec3, t: Vec3, tolAng: number): number | undefined => {
    const wn = dot(w, f1.n);
    const tn = dot(t, f1.n);
    if (Math.abs(Math.acos(clamp1(wn)) - Math.acos(clamp1(tn))) > tolAng) return undefined;
    const wp = sub(w, scale(f1.n, wn));
    const tp = sub(t, scale(f1.n, tn));
    const lw = Math.hypot(...wp);
    const lt = Math.hypot(...tp);
    if (lw < 1e-9 || lt < 1e-9) return inRange(f1.min, f1.min, f1.max, 0); // along the axis: any angle
    const rot = Math.atan2(dot(f1.n, cross(wp, tp)), dot(wp, tp)) / DEG; // counter-clockwise about n₁
    return inRange(rot / f1.s, f1.min, f1.max, tolAng / lt / DEG);
  };

  return {
    d,
    solve(u: Vec3, tolKf: number) {
      const cos2t = clamp1(u[2]);
      const theta = Math.acos(cos2t) / 2;
      const lambda = 2 * d * Math.sin(theta);
      const dl = d * Math.cos(theta) * tolKf; // λ change across the element (2θ ± tolKf)
      if (lambda + dl < lambdaMin || lambda - dl > lambdaMax) return undefined;
      const qhat = unit(sub(u, [0, 0, 1]));
      const t = mulVec(M0t, qhat);
      const tolAng = tolKf / 2;
      const lam = Math.min(lambdaMax, Math.max(lambdaMin, lambda));
      for (let r = 0; r < ws.length; r++) {
        const w = ws[r]!;
        if (!f2) {
          const a = outer(w, t, tolAng);
          if (a !== undefined) return { lambda: lam, angles: anglesOf(a), reflection: r };
          continue;
        }
        // Inner axis: n₁·M₁·Rot(n₂, β)·w = C + P cos β + Q sin β must equal t·n₁ (β = s₂·b).
        const wn = dot(w, f2.n);
        const wpar = scale(f2.n, wn);
        const C = dot(m, wpar);
        const P = dot(m, sub(w, wpar));
        const Q = dot(m, cross(f2.n, w));
        const val = dot(t, f1.n);
        const tolDot = tolAng * Math.sqrt(Math.max(0, 1 - val * val)) + tolAng * tolAng;
        const amp = Math.hypot(P, Q);
        const betas: number[] = [];
        if (amp < 1e-12) {
          if (Math.abs(C - val) <= tolDot) betas.push(f2.s * f2.min);
        } else {
          const c = (val - C) / amp;
          if (Math.abs(c) <= 1 + tolDot / amp) {
            const phase = Math.atan2(Q, P);
            const half = Math.acos(clamp1(c));
            betas.push((phase + half) / DEG, (phase - half) / DEG);
          }
          // Partial ranges: an end of the range may already be within tolerance.
          if (f2.max - f2.min < 360)
            for (const end of [f2.min, f2.max]) {
              const be = f2.s * end * DEG;
              if (Math.abs(C + P * Math.cos(be) + Q * Math.sin(be) - val) <= tolDot) betas.push(f2.s * end);
            }
        }
        for (const beta of betas) {
          const b = inRange(beta / f2.s, f2.min, f2.max, amp > 0 ? tolDot / amp / DEG : 0);
          if (b === undefined) continue;
          const w1 = mulVec(M1, mulVec(axisRotation(f2.n, f2.s * b), w));
          const a = outer(w1, t, tolAng);
          if (a !== undefined) return { lambda: lam, angles: anglesOf(a, b), reflection: r };
        }
      }
      return undefined;
    },
  };
}

/** λ (Å, NaN where not reachable) for each cell of each panel, on the panels' element grids. */
export function coveragePanelLambdas(panels: readonly DetectorPanel[], grids: readonly { readonly nx: number; readonly ny: number }[], solver: CoverageSolver): Float32Array[] {
  return panels.map((p, k) => {
    const { nx, ny } = grids[k]!;
    const out = new Float32Array(nx * ny).fill(NaN);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const x = ((i + 0.5) / nx - 0.5) * p.width;
        const y = ((j + 0.5) / ny - 0.5) * p.height;
        const v: Vec3 = [p.center[0] + x * p.base[0] + y * p.up[0], p.center[1] + x * p.base[1] + y * p.up[1], p.center[2] + x * p.base[2] + y * p.up[2]];
        const l2 = Math.hypot(...v);
        const tol = Math.hypot(p.width / nx, p.height / ny) / 2 / l2;
        const sol = solver.solve(scale(v, 1 / l2), tol);
        if (sol) out[j * nx + i] = sol.lambda;
      }
    return out;
  });
}

/** λ (NaN where not reachable or off the detectors) on the unrolled-map raster of mapCells (top row first). */
export function coverageMapLambdas(panelOf: Int16Array, width: number, height: number, nuMax: number, solver: CoverageSolver): Float32Array {
  const out = new Float32Array(width * height).fill(NaN);
  const dg = (360 / width) * DEG;
  const dn = ((2 * nuMax) / height) * DEG;
  for (let j = 0; j < height; j++) {
    const nu = (nuMax - ((j + 0.5) / height) * 2 * nuMax) * DEG;
    const tol = Math.hypot(dg * Math.cos(nu), dn) / 2;
    for (let i = 0; i < width; i++) {
      const c = j * width + i;
      if (panelOf[c]! < 0) continue;
      const g = (-180 + ((i + 0.5) / width) * 360) * DEG;
      const sol = solver.solve([Math.cos(nu) * Math.sin(g), Math.sin(nu), Math.cos(nu) * Math.cos(g)], tol);
      if (sol) out[c] = sol.lambda;
    }
  }
  return out;
}
