/**
 * Neutron time-of-flight powder diffraction at one detector bank.
 *
 * Position (GSAS-II convention, GSASIIlattice.py):  t = ZERO + DIFC·d + DIFA·d²  (µs)
 * DIFC from geometry (Mantid Unit.cpp):              DIFC = (m_n/h)·L·2 sinθ
 *   with m_n/h = 252.778 µs/(m·Å) (CODATA 2018), L = L1 + L2 (m), 2θ the bank angle.
 * Intensity (GSAS-II GSASIIstrMath.py, "TOF Lorentz correction"):
 *   I = Σ|F|² · sinθ · d⁴   for incident-spectrum-normalized data.
 * Peak shape (GSAS-II GSASIIpwd.py; MATERIA tofBackToBack): back-to-back
 *   exponentials ⊗ Gaussian with α = α₁/d, β = β₀ + β₁/d⁴, σ² = σ₀ + σ₁d² + σ₂d⁴,
 *   or a Gaussian of constant relative resolution Δd/d (FWHM_t = (Δd/d)·t).
 *
 * Not modelled: the incident spectrum and detector efficiency (assumed
 * normalized out), absorption, extinction, and the wavelength dependence of b
 * for resonant nuclei (Sears values are for 2200 m/s).
 */
import { tofBackToBack } from "@materia/core/diffraction/profile";
import type { PeakGroup, PowderPeak } from "./powder.ts";

/** Neutron mass / Planck constant in µs/(m·Å), CODATA 2018 (m_n = 1.67492749804e-27 kg, h = 6.62607015e-34 J s exact). */
export const NEUTRON_MASS_OVER_H = (1.67492749804e-27 * 1e6) / (6.62607015e-34 * 1e10);

const DEG = Math.PI / 180;

export interface TofBank {
  /** Bank scattering angle 2θ (deg). */
  readonly twoThetaDeg: number;
  /** DIFC (µs/Å). */
  readonly difc: number;
  /** DIFA (µs/Å²). */
  readonly difa: number;
  /** ZERO (µs). */
  readonly zero: number;
  /** Wavelength band reaching the sample (Å). */
  readonly lambdaMin: number;
  readonly lambdaMax: number;
}

export type TofShape =
  | { readonly kind: "gaussian"; /** Relative resolution Δd/d (FWHM). */ readonly dOverD: number }
  | { readonly kind: "backToBack"; readonly alpha1: number; readonly beta0: number; readonly beta1: number; readonly sig0: number; readonly sig1: number; readonly sig2: number };

/**
 * Flight time (µs) from the moderator to a detector for wavelength λ over a total path L = L1 + L2:
 * t = (m_n/h)·L·λ, the relation Mantid uses to convert TOF to wavelength (no emission-time offset).
 */
export function tofFromWavelength(flightPathM: number, lambdaA: number): number {
  return NEUTRON_MASS_OVER_H * flightPathM * lambdaA;
}

export function difcFromGeometry(flightPathM: number, twoThetaDeg: number): number {
  return NEUTRON_MASS_OVER_H * flightPathM * 2 * Math.sin((twoThetaDeg * DEG) / 2);
}

export function tofFromD(bank: Pick<TofBank, "difc" | "difa" | "zero">, d: number): number {
  return bank.zero + bank.difc * d + bank.difa * d * d;
}

/** Inverse of tofFromD on the physical (d > 0) branch. */
export function dFromTof(bank: Pick<TofBank, "difc" | "difa" | "zero">, t: number): number {
  const c = bank.zero - t;
  if (bank.difa === 0) return -c / bank.difc;
  const disc = bank.difc * bank.difc - 4 * bank.difa * c;
  if (disc < 0) return NaN;
  // Numerically stable root of difa·d² + difc·d + c = 0 with d → −c/difc as difa → 0.
  return (2 * -c) / (bank.difc + Math.sqrt(disc));
}

/** d-range a bank sees for its wavelength band: λ = 2d sinθ. */
export function bankDRange(bank: TofBank): { dMin: number; dMax: number } {
  const s = Math.sin((bank.twoThetaDeg * DEG) / 2);
  return { dMin: bank.lambdaMin / (2 * s), dMax: bank.lambdaMax / (2 * s) };
}

/** TOF Lorentz factor at a fixed bank: sinθ·d⁴ (GSAS-II). */
export function tofLorentz(twoThetaDeg: number, d: number): number {
  return Math.sin((twoThetaDeg * DEG) / 2) * d ** 4;
}

export function tofPeaks(groups: readonly PeakGroup[], bank: TofBank): PowderPeak[] {
  const { dMin, dMax } = bankDRange(bank);
  const s = Math.sin((bank.twoThetaDeg * DEG) / 2);
  const out: PowderPeak[] = [];
  for (const g of groups) {
    if (g.d < dMin * (1 - 1e-12) || g.d > dMax * (1 + 1e-12)) continue;
    const lp = tofLorentz(bank.twoThetaDeg, g.d);
    out.push({ ...g, tof: tofFromD(bank, g.d), lambda: 2 * g.d * s, lp, intensity: g.sumF2 * lp });
  }
  return out;
}

/** Unit-area peak shape in TOF (µs⁻¹) at offset Δ = t − t_peak. */
export function tofShapeAt(shape: TofShape, peak: PowderPeak, delta: number): number {
  if (shape.kind === "gaussian") {
    const sigma = (shape.dOverD * peak.tof!) / (2 * Math.sqrt(2 * Math.LN2));
    return Math.exp(-0.5 * (delta / sigma) ** 2) / (sigma * Math.sqrt(2 * Math.PI));
  }
  return tofBackToBack(delta, backToBackAt(shape, peak.d));
}

export function backToBackAt(shape: Extract<TofShape, { kind: "backToBack" }>, d: number) {
  return {
    alpha: shape.alpha1 / d,
    beta: shape.beta0 + shape.beta1 / d ** 4,
    sigma: Math.sqrt(Math.max(1e-12, shape.sig0 + shape.sig1 * d * d + shape.sig2 * d ** 4)),
  };
}

/** Half-width (µs) beyond which a peak's shape is negligible (< 1e-7 of its area). */
function reach(shape: TofShape, peak: PowderPeak): { left: number; right: number } {
  if (shape.kind === "gaussian") {
    const sigma = (shape.dOverD * peak.tof!) / (2 * Math.sqrt(2 * Math.LN2));
    return { left: 6 * sigma, right: 6 * sigma };
  }
  const p = backToBackAt(shape, peak.d);
  return { left: 6 * p.sigma + 17 / p.alpha, right: 6 * p.sigma + 17 / p.beta };
}

/** Narrowest relative width among the peaks, to set the logarithmic grid step. */
function narrowestRelativeWidth(shape: TofShape, peaks: readonly PowderPeak[]): number {
  let w = Infinity;
  for (const p of peaks) {
    if (shape.kind === "gaussian") w = Math.min(w, shape.dOverD);
    else {
      const b = backToBackAt(shape, p.d);
      const width = Math.max(2.3548 * b.sigma, 0.7 / b.alpha + 0.7 / b.beta);
      w = Math.min(w, width / p.tof!);
    }
  }
  return w;
}

/**
 * Pattern on a logarithmic TOF grid (constant Δt/t, as TOF data are usually
 * binned), each peak a unit-area shape times its integrated intensity, so the
 * area over TOF equals Σ intensities. For a d or Q axis the same density is
 * transformed with its Jacobian (|dt/dd| = DIFC + 2·DIFA·d; |dt/dQ| = |dt/dd|·d²/2π)
 * so areas are preserved on every axis.
 */
export function synthesizeTof(
  peaks: readonly PowderPeak[],
  bank: TofBank,
  shape: TofShape,
  axis: "tof" | "d" | "q",
  opts: { pointsPerWidth?: number; maxPoints?: number } = {},
): { x: Float64Array; y: Float64Array } {
  if (peaks.length === 0) return { x: new Float64Array(), y: new Float64Array() };
  const ppw = opts.pointsPerWidth ?? 10;
  const maxPoints = opts.maxPoints ?? 400_000;
  const { dMin, dMax } = bankDRange(bank);
  let tMin = Math.max(1e-6, tofFromD(bank, dMin));
  let tMax = tofFromD(bank, dMax);
  for (const p of peaks) {
    const r = reach(shape, p);
    tMin = Math.max(1e-6, Math.min(tMin, p.tof! - r.left));
    tMax = Math.max(tMax, p.tof! + r.right);
  }
  const rel = Math.max(narrowestRelativeWidth(shape, peaks) / ppw, Math.log(tMax / tMin) / maxPoints);
  const n = Math.ceil(Math.log(tMax / tMin) / Math.log1p(rel)) + 1;
  const t = Float64Array.from({ length: n }, (_, i) => tMin * (1 + rel) ** i);
  const y = new Float64Array(n);
  const indexOf = (tv: number) => Math.min(n - 1, Math.max(0, Math.floor(Math.log(tv / tMin) / Math.log1p(rel))));
  for (const p of peaks) {
    const r = reach(shape, p);
    const lo = indexOf(p.tof! - r.left);
    const hi = indexOf(p.tof! + r.right) + 1;
    for (let i = lo; i <= Math.min(hi, n - 1); i++) y[i]! += p.intensity * tofShapeAt(shape, p, t[i]! - p.tof!);
  }
  if (axis === "tof") return { x: t, y };
  // Density transform to d (or Q), reversed for Q so x increases.
  const x = new Float64Array(n);
  const yd = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = dFromTof(bank, t[i]!);
    const dtdd = bank.difc + 2 * bank.difa * d;
    if (axis === "d") {
      x[i] = d;
      yd[i] = y[i]! * dtdd;
    } else {
      const j = n - 1 - i;
      x[j] = (2 * Math.PI) / d;
      yd[j] = (y[i]! * dtdd * d * d) / (2 * Math.PI);
    }
  }
  return { x, y: yd };
}

/** Trapezoid integral on a non-uniform grid. */
export function trapezoid(x: Float64Array, y: Float64Array): number {
  let s = 0;
  for (let i = 1; i < x.length; i++) s += 0.5 * (y[i]! + y[i - 1]!) * (x[i]! - x[i - 1]!);
  return s;
}
