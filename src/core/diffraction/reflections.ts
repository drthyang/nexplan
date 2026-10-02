/**
 * Full signed reflection list and complex structure factors.
 *
 * Enumeration bound: h_i = a_i · g and |g| ≤ 1/d_min, so |h_i| ≤ |a_i|/d_min
 * holds for any cell, however skewed. The list is never truncated: exceeding
 * `maxCount` is an error that names a d_min that fits.
 */
import type { UnitCell } from "@materia/core/crystal/types";
import { reciprocalMetricTensor } from "@materia/core/crystal/unitCell";
import { amplitudeFor, type Amplitude, type Radiation } from "../scattering/tables.ts";
import type { Expansion, StructureModel } from "../structure/model.ts";
import { isSystematicallyAbsent, type SymOp } from "../symmetry/ops.ts";

export interface ReflectionList {
  readonly count: number;
  readonly h: Int32Array;
  readonly k: Int32Array;
  readonly l: Int32Array;
  /** d-spacing, Å. */
  readonly d: Float64Array;
  /** 1 when systematically absent by the space-group operations. */
  readonly absent: Uint8Array;
  readonly dMin: number;
}

export class ReflectionLimitError extends Error {
  readonly suggestedDMin: number;
  constructor(message: string, suggestedDMin: number) {
    super(message);
    this.suggestedDMin = suggestedDMin;
  }
}

export const DEFAULT_MAX_REFLECTIONS = 2_000_000;

/** Number of lattice points with d ≥ dMin, estimated from the reciprocal-sphere volume. */
export function estimateReflectionCount(volume: number, dMin: number): number {
  return ((4 / 3) * Math.PI * volume) / dMin ** 3;
}

export function enumerateReflections(cell: UnitCell, ops: readonly SymOp[], dMin: number, opts: { maxCount?: number } = {}): ReflectionList {
  if (!(dMin > 0)) throw new Error("d_min must be positive");
  const maxCount = opts.maxCount ?? DEFAULT_MAX_REFLECTIONS;
  const Gs = reciprocalMetricTensor(cell);
  const lim = [cell.a, cell.b, cell.c].map((x) => Math.floor(x / dMin + 1e-9)) as [number, number, number];
  const gMax2 = 1 / (dMin * dMin);
  const H: number[] = [];
  const K: number[] = [];
  const L: number[] = [];
  const D: number[] = [];
  const A: number[] = [];
  const g00 = Gs[0][0], g11 = Gs[1][1], g22 = Gs[2][2];
  const g01 = 2 * Gs[0][1], g02 = 2 * Gs[0][2], g12 = 2 * Gs[1][2];
  for (let h = -lim[0]; h <= lim[0]; h++) {
    for (let k = -lim[1]; k <= lim[1]; k++) {
      for (let l = -lim[2]; l <= lim[2]; l++) {
        if (h === 0 && k === 0 && l === 0) continue;
        const q2 = g00 * h * h + g11 * k * k + g22 * l * l + g01 * h * k + g02 * h * l + g12 * k * l;
        if (q2 > gMax2 * (1 + 1e-12)) continue;
        if (H.length >= maxCount) {
          const detGs =
            Gs[0][0] * (Gs[1][1] * Gs[2][2] - Gs[1][2] * Gs[2][1]) - Gs[0][1] * (Gs[1][0] * Gs[2][2] - Gs[1][2] * Gs[2][0]) + Gs[0][2] * (Gs[1][0] * Gs[2][1] - Gs[1][1] * Gs[2][0]);
          const vol = 1 / Math.sqrt(detGs);
          const suggestion = dMin * Math.cbrt(estimateReflectionCount(vol, dMin) / maxCount) * 1.05;
          throw new ReflectionLimitError(`More than ${maxCount.toLocaleString()} reflections with d ≥ ${dMin} Å; increase d_min (about ${suggestion.toFixed(3)} Å fits).`, suggestion);
        }
        H.push(h);
        K.push(k);
        L.push(l);
        D.push(1 / Math.sqrt(q2));
        A.push(isSystematicallyAbsent(ops, [h, k, l]) ? 1 : 0);
      }
    }
  }
  // Sort by decreasing d, then h, k, l for determinism.
  const idx = H.map((_, i) => i).sort((i, j) => D[j]! - D[i]! || H[j]! - H[i]! || K[j]! - K[i]! || L[j]! - L[i]!);
  return {
    count: idx.length,
    h: Int32Array.from(idx, (i) => H[i]!),
    k: Int32Array.from(idx, (i) => K[i]!),
    l: Int32Array.from(idx, (i) => L[i]!),
    d: Float64Array.from(idx, (i) => D[i]!),
    absent: Uint8Array.from(idx, (i) => A[i]!),
    dMin,
  };
}

export interface StructureFactors {
  readonly re: Float64Array;
  readonly im: Float64Array;
  /** |F|², units e² (X-ray) or fm² (neutron), per conventional cell. */
  readonly f2: Float64Array;
  /** Σ_j |o_j a_j(s) T_j(s)| at each reflection, the scale for "numerically zero". */
  readonly scale: Float64Array;
  readonly amplitudes: readonly Amplitude[];
}

/**
 * F(h) = Σ_j o_j · a_j(s) · exp(−B_j s²) · exp(+2πi h·x_j), s = 1/(2d), over the
 * expanded cell. a_j is complex (f0 for X-rays; conj(b) for neutrons).
 */
export function structureFactors(model: StructureModel, expansion: Expansion, refl: ReflectionList, radiation: Radiation): StructureFactors {
  const amplitudes = model.sites.map((s) => amplitudeFor(s.species, radiation));
  const n = refl.count;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const f2 = new Float64Array(n);
  const scale = new Float64Array(n);
  const nAtoms = expansion.atoms.length;
  const ax = new Float64Array(nAtoms), ay = new Float64Array(nAtoms), az = new Float64Array(nAtoms);
  const site = new Int32Array(nAtoms);
  expansion.atoms.forEach((a, i) => {
    ax[i] = a.fract[0];
    ay[i] = a.fract[1];
    az[i] = a.fract[2];
    site[i] = a.siteIndex;
  });
  const nSites = model.sites.length;
  const wRe = new Float64Array(nSites);
  const wIm = new Float64Array(nSites);
  const TWO_PI = 2 * Math.PI;
  for (let r = 0; r < n; r++) {
    const s = 1 / (2 * refl.d[r]!);
    for (let j = 0; j < nSites; j++) {
      const st = model.sites[j]!;
      const a = amplitudes[j]!.at(s);
      const w = st.occupancy * Math.exp(-st.bIso * s * s);
      wRe[j] = w * a.re;
      wIm[j] = w * a.im;
    }
    const h = refl.h[r]!, k = refl.k[r]!, l = refl.l[r]!;
    let sr = 0, si = 0, sc = 0;
    for (let i = 0; i < nAtoms; i++) {
      const phase = TWO_PI * (h * ax[i]! + k * ay[i]! + l * az[i]!);
      const c = Math.cos(phase), sn = Math.sin(phase);
      const j = site[i]!;
      sr += wRe[j]! * c - wIm[j]! * sn;
      si += wRe[j]! * sn + wIm[j]! * c;
      sc += Math.hypot(wRe[j]!, wIm[j]!);
    }
    re[r] = sr;
    im[r] = si;
    f2[r] = sr * sr + si * si;
    scale[r] = sc;
  }
  return { re, im, f2, scale, amplitudes };
}

/** Classification: systematic absence (from symmetry), accidental near-zero, or present. */
export type ReflectionClass = "systematic" | "accidental" | "present";
export function classify(refl: ReflectionList, sf: StructureFactors, i: number, relTol = 1e-8): ReflectionClass {
  if (refl.absent[i]) return "systematic";
  return Math.sqrt(sf.f2[i]!) <= relTol * sf.scale[i]! ? "accidental" : "present";
}

export function hasComplexAmplitudes(sf: StructureFactors, model: StructureModel): boolean {
  return sf.amplitudes.some((a, j) => a.at(0).im !== 0 && model.sites[j]!.occupancy > 0);
}
