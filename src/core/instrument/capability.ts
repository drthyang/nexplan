/**
 * What an instrument can record whatever the sample: the solid angle and the angular ranges its detectors cover,
 * the d range a band reaches over them, the kinematic |Q| limits of a direct-geometry spectrometer at an energy
 * transfer, and evenly spread directions for estimating how much of reciprocal space a goniometer reaches.
 *
 *  - Solid angle: the fraction of evenly spread directions (Fibonacci lattice) whose ray lands on a recording pixel
 *    (rayHit: the nearest panel along the ray, so overlapping panels count once; masks and shadows honoured), × 4π.
 *  - Angles: 2θ from the beam (+z); the horizontal angle γ = atan2(u_x, u_z) and the elevation ν = asin(u_y) of
 *    the unrolled detector map (simulate.ts).
 *  - d reach in a band: d = λ/(2 sin θ), so d_min = λmin/(2 sin θ_max) and d_max = λmax/(2 sin θ_min).
 *  - Direct geometry at incident energy E_i and transfer E: k_i = 2π/λ(E_i), k_f = 2π/λ(E_i − E), and
 *    |Q|² = k_i² + k_f² − 2 k_i k_f cos 2θ (1/Å, with 2π, as Mantid's |Q|); λ(E) = √(81.8042/E) (energy.ts).
 *  - Directions: the Fibonacci lattice on the sphere, n points of equal area to O(1/n).
 */
import type { Vec3 } from "@materia/core/math/types";
import { neutronWavelengthA } from "../physics/energy.ts";
import { rayHit, type Blocked, type DetectorPanel } from "./detectors.ts";
import { panelSamples } from "./hklRange.ts";
import { coveredTwoTheta, panelAngles } from "./simulate.ts";

const DEG = 180 / Math.PI;

export interface Acceptance {
  /** Solid angle of the recording pixels (sr), and as a fraction of 4π. */
  readonly solidAngle: number;
  readonly fraction: number;
  /** Scattering angles covered, as sorted disjoint intervals (deg). */
  readonly twoTheta: [number, number][];
  /** Horizontal angles γ covered (deg, −180 to 180), as sorted disjoint intervals. */
  readonly horizontal: [number, number][];
  /** Lowest and highest elevation ν reached (deg). */
  readonly elevation: { readonly min: number; readonly max: number };
}

/** Union of intervals, sorted and disjoint; intervals less than `gap` apart merge (e.g. the gaps between tubes). */
export function mergeIntervals(iv: readonly (readonly [number, number])[], gap = 0): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of [...iv].sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1);
    if (last && a <= last[1] + gap + 1e-9) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * The detector acceptance of panels: masked pixels and switched-off panels left out, and `blocked` (the sample
 * environment's shadows) left out of the solid angle. The solid angle samples `directions` rays (its standard error
 * is √(f(1 − f)/directions) of 4π); the angular ranges sample each panel's face on an n × n grid with its edges, and
 * intervals less than `gap` degrees apart (the gaps between tubes) are merged.
 */
export function acceptance(panels: readonly DetectorPanel[], blocked?: Blocked, opts: { readonly directions?: number; readonly n?: number; readonly gap?: number } = {}): Acceptance {
  const dirs = fibonacciSphere(opts.directions ?? 60_000);
  const hits = dirs.reduce((k, u) => k + (rayHit(panels, u, blocked) ? 1 : 0), 0);
  const n = opts.n ?? 12;
  const gap = opts.gap ?? 1;
  const on = panels.filter((p) => !p.off);
  const horizontal: [number, number][] = [];
  let nuMin = Infinity;
  let nuMax = -Infinity;
  for (const dirs of panelSamples(on, n)) {
    if (!dirs.length) continue;
    // A panel's horizontal span, taken on the side of ±180° it does not straddle.
    const g = dirs.map((u) => Math.atan2(u[0], u[2]) * DEG);
    const lo = Math.min(...g);
    const hi = Math.max(...g);
    if (hi - lo > 180) {
      const shifted = g.map((x) => (x < 0 ? x + 360 : x));
      const a = Math.min(...shifted);
      const b = Math.max(...shifted);
      horizontal.push([a, Math.min(180, b)]);
      if (b > 180) horizontal.push([-180, b - 360]);
    } else horizontal.push([lo, hi]);
    for (const u of dirs) {
      const nu = Math.asin(Math.max(-1, Math.min(1, u[1]))) * DEG;
      nuMin = Math.min(nuMin, nu);
      nuMax = Math.max(nuMax, nu);
    }
  }
  return {
    solidAngle: (4 * Math.PI * hits) / dirs.length,
    fraction: hits / dirs.length,
    twoTheta: mergeIntervals(coveredTwoTheta(on.map(panelAngles)), gap),
    horizontal: mergeIntervals(horizontal, gap),
    elevation: { min: Number.isFinite(nuMin) ? nuMin : 0, max: Number.isFinite(nuMax) ? nuMax : 0 },
  };
}

/** The d range (Å) a band reaches over scattering angles twoThetaMin–twoThetaMax (deg). */
export function dReach(twoThetaMin: number, twoThetaMax: number, lambdaMin: number, lambdaMax: number): { dMin: number; dMax: number } {
  const s = (tt: number) => Math.sin(tt / (2 * DEG));
  return { dMin: lambdaMin / (2 * s(twoThetaMax)), dMax: lambdaMax / (2 * s(twoThetaMin)) };
}

/** |Q| (1/Å, with 2π) at incident energy eiMeV, energy transfer transferMeV (< eiMeV) and scattering angle 2θ (deg). */
export function directQ(eiMeV: number, transferMeV: number, twoThetaDeg: number): number {
  if (!(transferMeV < eiMeV)) return NaN;
  const ki = (2 * Math.PI) / neutronWavelengthA(eiMeV);
  const kf = (2 * Math.PI) / neutronWavelengthA(eiMeV - transferMeV);
  return Math.sqrt(Math.max(0, ki * ki + kf * kf - 2 * ki * kf * Math.cos(twoThetaDeg / DEG)));
}

/** n unit vectors spread evenly over the sphere (the Fibonacci lattice). */
export function fibonacciSphere(n: number): Vec3[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: n }, (_, i) => {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    return [r * Math.cos(golden * i), y, r * Math.sin(golden * i)] as Vec3;
  });
}
