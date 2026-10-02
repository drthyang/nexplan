/**
 * Constant-wavelength powder pattern from a signed reflection list.
 *
 * Intensity at each distinct d is the explicit sum of |F|² over every signed
 * hkl at that d, so no multiplicity or Laue-class logic enters the intensity.
 * Symmetry families are computed only to label peaks and report multiplicity.
 */
import { pseudoVoigt } from "@materia/core/diffraction/profile";
import type { SymOp } from "../symmetry/ops.ts";
import type { ReflectionList, StructureFactors } from "./reflections.ts";

export type Polarization =
  | { readonly kind: "none" } // neutrons
  | { readonly kind: "unpolarized" } // laboratory X-ray, no monochromator: (1 + cos²2θ)/2
  | { readonly kind: "monochromator"; readonly twoThetaMDeg: number } // (1 + cos²2θ_M cos²2θ)/(1 + cos²2θ_M)
  | { readonly kind: "linear"; readonly fraction: number }; // synchrotron: f·1 + (1−f)·cos²2θ, f = fraction polarized ⟂ to the scattering plane

export interface PowderSettings {
  readonly wavelength: number;
  /** Apply the CW powder Lorentz factor 1/(sin²θ cosθ). */
  readonly lorentz: boolean;
  readonly polarization: Polarization;
}

export interface PowderFamily {
  /** Representative index (lexicographically largest equivalent). */
  readonly hkl: readonly [number, number, number];
  readonly multiplicity: number;
  readonly f2: number;
}

/** All signed reflections at one d: the shared part of CW and TOF peaks. */
export interface PeakGroup {
  readonly d: number;
  readonly q: number;
  /** Σ|F|² over all signed hkl at this d. */
  readonly sumF2: number;
  readonly families: readonly PowderFamily[];
}

export interface PowderPeak extends PeakGroup {
  /** CW: scattering angle (deg). TOF: undefined (fixed bank angle). */
  readonly twoTheta?: number;
  /** TOF: flight time (µs). */
  readonly tof?: number;
  /** Wavelength at which this peak is measured (Å); varies per peak in TOF. */
  readonly lambda: number;
  /** Lorentz(-polarization) factor applied: CW 1/(sin²θ cosθ)·P, TOF sinθ·d⁴. */
  readonly lp: number;
  /** sumF2 · lp, the integrated intensity (relative units). */
  readonly intensity: number;
}

const DEG = Math.PI / 180;

export function polarizationFactor(p: Polarization, twoTheta: number): number {
  const c2 = Math.cos(twoTheta) ** 2;
  switch (p.kind) {
    case "none":
      return 1;
    case "unpolarized":
      return (1 + c2) / 2;
    case "monochromator": {
      const cm = Math.cos(p.twoThetaMDeg * DEG) ** 2;
      return (1 + cm * c2) / (1 + cm);
    }
    case "linear":
      return p.fraction + (1 - p.fraction) * c2;
  }
}

/** Lorentz factor for CW powder (Debye–Scherrer and Bragg–Brentano): 1/(sin²θ cosθ). */
export function powderLorentz(theta: number): number {
  return 1 / (Math.sin(theta) ** 2 * Math.cos(theta));
}

/** Canonical family key: lexicographically largest of {Rᵀh} (and −Rᵀh when Friedel pairs merge). */
export function familyRepresentative(ops: readonly SymOp[], h: readonly [number, number, number], friedel: boolean): [number, number, number] {
  let best: [number, number, number] | undefined;
  const consider = (v: [number, number, number]) => {
    if (!best || v[0] > best[0] || (v[0] === best[0] && (v[1] > best[1] || (v[1] === best[1] && v[2] > best[2])))) best = v;
  };
  for (const op of ops) {
    const R = op.R;
    const v: [number, number, number] = [
      h[0] * R[0][0] + h[1] * R[1][0] + h[2] * R[2][0],
      h[0] * R[0][1] + h[1] * R[1][1] + h[2] * R[2][1],
      h[0] * R[0][2] + h[1] * R[1][2] + h[2] * R[2][2],
    ];
    consider(v);
    if (friedel) consider([-v[0], -v[1], -v[2]]);
  }
  return best!;
}

/**
 * Group reflections by d. Reflections whose d differ by less than `relDTol`·d
 * form one group (exact and accidental overlaps alike) and the contributing
 * families are listed. Systematic absences are excluded.
 */
export function groupByD(refl: ReflectionList, sf: StructureFactors, ops: readonly SymOp[], opts: { friedel: boolean; relDTol?: number }): PeakGroup[] {
  const tol = opts.relDTol ?? 1e-9;
  const groups: PeakGroup[] = [];
  let i = 0;
  const n = refl.count;
  while (i < n) {
    const d0 = refl.d[i]!;
    let j = i;
    while (j < n && Math.abs(refl.d[j]! - d0) <= tol * d0) j++;
    const fam = new Map<string, { hkl: [number, number, number]; multiplicity: number; f2: number }>();
    let sumF2 = 0;
    for (let r = i; r < j; r++) {
      if (refl.absent[r]) continue;
      sumF2 += sf.f2[r]!;
      const rep = familyRepresentative(ops, [refl.h[r]!, refl.k[r]!, refl.l[r]!], opts.friedel);
      const key = rep.join(",");
      const e = fam.get(key) ?? { hkl: rep, multiplicity: 0, f2: 0 };
      e.multiplicity++;
      e.f2 += sf.f2[r]!;
      fam.set(key, e);
    }
    if (fam.size > 0) {
      groups.push({ d: d0, q: (2 * Math.PI) / d0, sumF2, families: [...fam.values()].map((f) => ({ hkl: f.hkl, multiplicity: f.multiplicity, f2: f.f2 / f.multiplicity })) });
    }
    i = j;
  }
  return groups;
}

/** CW peaks: groups with d ≥ λ/2, Lorentz 1/(sin²θ cosθ) and the polarization factor. */
export function cwPeaks(groups: readonly PeakGroup[], settings: PowderSettings): PowderPeak[] {
  const out: PowderPeak[] = [];
  for (const g of groups) {
    const x = settings.wavelength / (2 * g.d);
    if (x > 1 + 1e-12) continue;
    const theta = Math.asin(Math.min(1, x));
    const lp = (settings.lorentz ? powderLorentz(theta) : 1) * polarizationFactor(settings.polarization, 2 * theta);
    out.push({ ...g, twoTheta: (2 * theta) / DEG, lambda: settings.wavelength, lp, intensity: g.sumF2 * lp });
  }
  return out;
}

/** Group reflections into CW powder peaks (groupByD + cwPeaks). */
export function powderPeaks(refl: ReflectionList, sf: StructureFactors, ops: readonly SymOp[], settings: PowderSettings, opts: { friedel: boolean; relDTol?: number }): PowderPeak[] {
  return cwPeaks(groupByD(refl, sf, ops, opts), settings);
}

export type PowderAxis = "twoTheta" | "tof" | "d" | "q";

export function peakPosition(p: PowderPeak, axis: PowderAxis): number {
  const v = axis === "twoTheta" ? p.twoTheta : axis === "tof" ? p.tof : axis === "d" ? p.d : p.q;
  if (v === undefined) throw new Error(`Peak has no ${axis} position`);
  return v;
}

/**
 * Broadened pattern on a uniform grid in the chosen axis: each peak is a
 * unit-area pseudo-Voigt (MATERIA profile.ts) scaled by its integrated
 * intensity, so the pattern's area equals Σ intensities within the grid.
 * The FWHM is in the axis's own units; the pattern is synthesized natively on
 * that axis, so no Jacobian resampling is involved.
 */
export function synthesizeProfile(peaks: readonly PowderPeak[], axis: PowderAxis, grid: { min: number; max: number; step: number }, shape: { fwhm: number; eta: number }): { x: Float64Array; y: Float64Array } {
  const n = Math.floor((grid.max - grid.min) / grid.step) + 1;
  if (n > 2_000_000) throw new Error("Profile grid too fine (more than 2 000 000 points)");
  const x = Float64Array.from({ length: n }, (_, i) => grid.min + i * grid.step);
  const y = new Float64Array(n);
  const reach = 40 * shape.fwhm;
  for (const p of peaks) {
    const c = peakPosition(p, axis);
    if (c < grid.min - reach || c > grid.max + reach) continue;
    const lo = Math.max(0, Math.floor((c - reach - grid.min) / grid.step));
    const hi = Math.min(n - 1, Math.ceil((c + reach - grid.min) / grid.step));
    for (let i = lo; i <= hi; i++) y[i]! += p.intensity * pseudoVoigt(x[i]!, c, shape.fwhm, shape.eta);
  }
  return { x, y };
}
