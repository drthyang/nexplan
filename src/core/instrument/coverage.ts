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
 * finite size, so each condition is met within the element's reach along that
 * condition's direction. With 2θ and the azimuth φ about the beam,
 * q̂ = (cos θ cos φ, cos θ sin φ, −sin θ): a step of the scattered direction u by
 * α along 2θ and β across it (azimuthally) moves q̂ by α/2 along ∂q̂/∂θ and by
 * β/(2 sin θ) along the azimuth. So q̂ moves half as fast as u along 2θ but
 * faster than u azimuthally at angles below 2θ = 60°; each condition's tolerance
 * is the element's extent (its support function, to first order) along the
 * u-direction that changes that condition.
 *
 * Masked elements are not reachable, nor are directions the sample
 * environment blocks (acceptance.ts): a shadow fixed in the lab blocks the
 * direction outright, one that turns with a stage is tested at each solution's
 * angles, and the search goes on past a blocked one.
 *
 * This is the continuous version of NeuXtalViz's stepped "individual peak"
 * coverage (simulate.ts reflectionCoverage), without sampling gaps.
 */
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { mulMat, mulVec, transpose } from "@materia/core/math/mat3";
import { axisRotation, type GoniometerModel } from "../ub/goniometer.ts";
import { labFixed, shadowBlocks, shadowTest, type Shadows } from "./acceptance.ts";
import { rayHit, recordsAt, type DetectorPanel } from "./detectors.ts";

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
  /**
   * Whether some allowed setting sends a reflection anywhere in the element at unit direction u: a disc of angular
   * radius tolKf (rad), or with `half` the element's two half-sides as vectors in the tangent plane at u (rad).
   */
  solve(u: Vec3, tolKf: number, half?: readonly [Vec3, Vec3]): CoverageSolution | undefined;
}

/**
 * Solver for reflections `hs` sharing one d-spacing (a reflection and its
 * equivalents), with the free (not `fixed`) goniometer axes swept over their
 * [min, max] ranges. Supports one or two free axes.
 */
export function coverageSolver(model: GoniometerModel, UB: Mat3, hs: readonly Vec3[], lambdaMin: number, lambdaMax: number, shadows?: Shadows): CoverageSolver {
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

  const labOnly = shadows !== undefined && labFixed(shadows.shapes, shadows.model);
  const labBlocked = labOnly ? shadowTest(shadows.shapes, shadows.model, []) : undefined;
  /** A solution the environment leaves open (shadows that turn with a stage, at its angles). */
  const open = (sol: CoverageSolution, u: Vec3) => labOnly || !shadowBlocks(shadows, sol.angles, u);

  /** Outer (or only) axis: the angle that turns w onto t about n₁, if allowed (tolAng across the cone, tolRot along it). */
  const outer = (w: Vec3, t: Vec3, tolAng: number, tolRot: number): number | undefined => {
    const wn = dot(w, f1.n);
    const tn = dot(t, f1.n);
    if (Math.abs(Math.acos(clamp1(wn)) - Math.acos(clamp1(tn))) > tolAng) return undefined;
    const wp = sub(w, scale(f1.n, wn));
    const tp = sub(t, scale(f1.n, tn));
    const lw = Math.hypot(...wp);
    const lt = Math.hypot(...tp);
    if (lw < 1e-9 || lt < 1e-9) return inRange(f1.min, f1.min, f1.max, 0); // along the axis: any angle
    const rot = Math.atan2(dot(f1.n, cross(wp, tp)), dot(wp, tp)) / DEG; // counter-clockwise about n₁
    return inRange(rot / f1.s, f1.min, f1.max, tolRot / lt / DEG);
  };

  return {
    d,
    solve(u: Vec3, tolKf: number, half?: readonly [Vec3, Vec3]) {
      if (labBlocked?.(u[0], u[1], u[2])) return undefined;
      const theta = Math.acos(clamp1(u[2])) / 2;
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);
      const st = Math.max(1e-9, sinT);
      const phi = Math.atan2(u[1], u[0]);
      const cp = Math.cos(phi);
      const sp = Math.sin(phi);
      // Unit tangents at u along 2θ and along the azimuth, and the element's reach along a u-space gradient
      // gT·e2θ + gP·eφ (the support function of the disc or of the rectangle).
      const e2t: Vec3 = [Math.cos(2 * theta) * cp, Math.cos(2 * theta) * sp, -Math.sin(2 * theta)];
      const ephi: Vec3 = [-sp, cp, 0];
      const reach = (gT: number, gP: number) =>
        half ? Math.abs(gT * dot(e2t, half[0]) + gP * dot(ephi, half[0])) + Math.abs(gT * dot(e2t, half[1]) + gP * dot(ephi, half[1])) : tolKf * Math.hypot(gT, gP);
      const lambda = 2 * d * sinT;
      const dl = d * cosT * reach(1, 0); // λ = 2d sin θ changes by d cos θ per radian of 2θ
      if (lambda + dl < lambdaMin || lambda - dl > lambdaMax) return undefined;
      const qhat = unit(sub(u, [0, 0, 1]));
      const t = mulVec(M0t, qhat);
      // q̂ moves by α/2 along e_r = ∂q̂/∂θ and β/(2 sin θ) along e_φ for a step α·e2θ + β·eφ of u; so along a unit
      // direction D (frame of t) it reaches as far as the element's reach along (D·e_r/2)·e2θ + (D·e_φ/(2 sin θ))·eφ.
      const er = mulVec(M0t, [-sinT * cp, -sinT * sp, -cosT]);
      const ep = mulVec(M0t, ephi);
      const tolAlong = (D: Vec3) => {
        const l = Math.hypot(...D);
        if (l < 1e-12) return Math.max(reach(0.5, 0), reach(0, 1 / (2 * st)));
        return reach(dot(D, er) / (2 * l), dot(D, ep) / (2 * st * l));
      };
      const tolAng = tolAlong(sub(f1.n, scale(t, dot(f1.n, t)))); // across the cone about n₁
      const tolRot = tolAlong(cross(f1.n, t)); // along it
      const lam = Math.min(lambdaMax, Math.max(lambdaMin, lambda));
      for (let r = 0; r < ws.length; r++) {
        const w = ws[r]!;
        if (!f2) {
          const a = outer(w, t, tolAng, tolRot);
          const sol = a === undefined ? undefined : { lambda: lam, angles: anglesOf(a), reflection: r };
          if (sol && open(sol, u)) return sol;
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
          const a = outer(w1, t, tolAng, tolRot);
          const sol = a === undefined ? undefined : { lambda: lam, angles: anglesOf(a, b), reflection: r };
          if (sol && open(sol, u)) return sol;
        }
      }
      return undefined;
    },
  };
}

/** λ (Å, NaN where not reachable or masked) for each cell of each panel, on the panels' element grids. */
export function coveragePanelLambdas(panels: readonly DetectorPanel[], grids: readonly { readonly nx: number; readonly ny: number }[], solver: CoverageSolver): Float32Array[] {
  return panels.map((p, k) => {
    const { nx, ny } = grids[k]!;
    const out = new Float32Array(nx * ny).fill(NaN);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const x = ((i + 0.5) / nx - 0.5) * p.width;
        const y = ((j + 0.5) / ny - 0.5) * p.height;
        if (!recordsAt(p, x, y)) continue;
        const v: Vec3 = [p.center[0] + x * p.base[0] + y * p.up[0], p.center[1] + x * p.base[1] + y * p.up[1], p.center[2] + x * p.base[2] + y * p.up[2]];
        const l2 = Math.hypot(...v);
        const u = scale(v, 1 / l2);
        // The cell's half-sides, seen from the sample: projected onto the tangent plane at u, in radians.
        const side = (e: Vec3, h: number): Vec3 => scale(sub(e, scale(u, dot(e, u))), h / l2);
        const sol = solver.solve(u, Math.hypot(p.width / nx, p.height / ny) / 2 / l2, [side(p.base, p.width / nx / 2), side(p.up, p.height / ny / 2)]);
        // A ray stops at the nearest panel (NOMAD, SEQUOIA and CNCS have overlaps): checked only for the few cells reached.
        if (sol && rayHit(panels, u)?.panel === k) out[j * nx + i] = sol.lambda;
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
      // The cell's half-sides: along γ (∂u/∂γ = cos ν·(cos γ, 0, −sin γ)) and along ν.
      const half: [Vec3, Vec3] = [scale([Math.cos(g), 0, -Math.sin(g)], (dg / 2) * Math.cos(nu)), scale([-Math.sin(nu) * Math.sin(g), Math.cos(nu), -Math.sin(nu) * Math.cos(g)], dn / 2)];
      const sol = solver.solve([Math.cos(nu) * Math.sin(g), Math.sin(nu), Math.cos(nu) * Math.cos(g)], tol, half);
      if (sol) out[c] = sol.lambda;
    }
  }
  return out;
}
