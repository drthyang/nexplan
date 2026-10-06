/**
 * Suggested histogram binning for a measurement (Mantid MDNorm / BinMD, garnet): the HKL range it records
 * (hklRange.ts) with a bin size per projection axis from the instrumental Q resolution (qResolution.ts), and for a
 * chopper spectrometer an energy-transfer range and bin from its energy resolution (pychop.ts).
 *
 * The resolution varies over the detectors and the band, so it is sampled where the measurement records: at a subset
 * of its settings, at pixels sampled on each panel, and at five wavelengths across the band (or energy transfers
 * across the range). Along projection axis i, FWHM_i = 2.3548·√C_ii with C = M·Σ·Mᵀ/(2π)², M = (UB·W)⁻¹·Rᵀ, Σ the
 * lab-frame Q covariance. The bin is the FWHM of the sharpest quarter of those samples (their 25th percentile) over
 * the bins per FWHM, rounded to the nearest of 1, 2, 2.5 or 5 × 10ⁿ; the range is rounded out to whole bins. With
 * |q| ≤ q_max (1/d_min), only what lies inside counts, for the range and for the resolution.
 */
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { inverse, mulMat, transpose } from "@materia/core/math/mat3";
import type { Blocked } from "./detectors.ts";
import { hklExtent, kOfEnergy, type Beam, type HklExtent } from "./hklRange.ts";
import { FWHM_PER_SIGMA } from "./qResolution.ts";

/** The nearest (in ratio) of 1, 2, 2.5 and 5 × 10ⁿ to x. */
export function niceStep(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return NaN;
  const e = Math.floor(Math.log10(x));
  let best = NaN;
  for (const m of [1, 2, 2.5, 5, 10]) {
    const v = m * 10 ** e;
    if (Number.isNaN(best) || Math.abs(Math.log(v / x)) < Math.abs(Math.log(best / x))) best = v;
  }
  return Number(best.toPrecision(6));
}

export interface AxisBinning {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly bins: number;
  /** FWHM (r.l.u.) along this axis: sharpest quarter (25th percentile) and median of the samples. */
  readonly fwhm25: number;
  readonly fwhm50: number;
}

export interface Binning {
  readonly axes: readonly [AxisBinning, AxisBinning, AxisBinning];
  readonly extent: HklExtent;
}

/** Whole bins of `step` covering [min, max], on multiples of the step. */
export function roundRange(min: number, max: number, step: number): { min: number; max: number; bins: number } {
  // A limit already on a multiple of the step (to rounding) stays there.
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const clean = (v: number) => Number(v.toFixed(Math.max(0, -Math.floor(Math.log10(step)) + 2)));
  return { min: clean(lo), max: clean(hi), bins: Math.round((hi - lo) / step) };
}

const quantile = (sorted: Float64Array, p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]!;

/**
 * The binning for settings R (with the shadows at each, `blocked`), pixel samples (hklRange.ts panelSamples), the
 * beam, the orientation UB (q = UB·h, no 2π), projection axes W (columns, r.l.u.) and the lab-frame Q covariance
 * at a pixel direction u and wavelength λ (white beam) or energy transfer E (chopper spectrometer).
 */
export function suggestBinning(
  settings: readonly Mat3[],
  blocked: readonly (Blocked | undefined)[],
  samples: readonly (readonly Vec3[])[],
  beam: Beam,
  UB: Mat3,
  W: Mat3,
  covariance: (u: Vec3, at: number) => Mat3 | undefined,
  perFwhm: number,
  opts: { readonly maxSettings?: number; readonly points?: number; readonly qMax?: number } = {},
): Binning | undefined {
  const qMax = opts.qMax ?? Infinity;
  const extent = hklExtent(settings, blocked, samples, beam, UB, W, qMax);
  if (!extent) return undefined;
  const toX = inverse(mulMat(UB, W));
  const points = opts.points ?? 5;
  const ats = Array.from({ length: points }, (_, i) => {
    const t = points > 1 ? i / (points - 1) : 0.5;
    return beam.kind === "white" ? beam.lambdaMin + t * (beam.lambdaMax - beam.lambdaMin) : beam.eMin + t * (beam.eMax - beam.eMin);
  });
  // An evenly spread subset of the settings is enough for the statistics.
  const every = Math.max(1, Math.ceil(settings.length / (opts.maxSettings ?? 24)));
  const fwhm: number[][] = [[], [], []];
  const sigmas = new Map<string, Mat3 | undefined>();
  settings.forEach((R, k) => {
    if (k % every) return;
    const M = mulMat(toX, transpose(R));
    const block = blocked[k];
    samples.forEach((list, p) =>
      list.forEach((u, s) => {
        if (block?.(u[0], u[1], u[2])) return;
        for (const at of ats) {
          // Only what lies within |q| ≤ q_max: q = (u − ẑ)/λ, or k_f·u − k_i·ẑ.
          const kf = beam.kind === "white" ? 1 / at : kOfEnergy(beam.eiMeV - at);
          const ki = beam.kind === "white" ? 1 / at : kOfEnergy(beam.eiMeV);
          if (Math.hypot(kf * u[0], kf * u[1], kf * u[2] - ki) > qMax) continue;
          // The lab covariance depends on the pixel and λ (or E) only: computed once, reused for every setting.
          const key = `${p}:${s}:${at}`;
          if (!sigmas.has(key)) sigmas.set(key, covariance(u, at));
          const S = sigmas.get(key);
          if (!S) continue;
          for (let i = 0; i < 3; i++) {
            const m = M[i]!;
            let v = 0;
            for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) v += m[a]! * S[a]![b]! * m[b]!;
            fwhm[i]!.push((FWHM_PER_SIGMA * Math.sqrt(Math.max(0, v))) / (2 * Math.PI));
          }
        }
      }),
    );
  });
  if (!fwhm[0]!.length) return undefined;
  const axes = [0, 1, 2].map((i) => {
    const sorted = Float64Array.from(fwhm[i]!).sort();
    const fwhm25 = quantile(sorted, 0.25);
    const step = niceStep(fwhm25 / perFwhm);
    const r = roundRange(extent.min[i]!, extent.max[i]!, step);
    return { ...r, step, fwhm25, fwhm50: quantile(sorted, 0.5) };
  }) as unknown as [AxisBinning, AxisBinning, AxisBinning];
  return { axes, extent };
}

/** Mantid's Q.convention: "inelastic" (q = k_i − k_f, Mantid's default) or "crystallography" (q = k_f − k_i, as here). */
export type QConvention = "inelastic" | "crystallography";

/**
 * One MDNorm DimensionNBinning value for a projection axis whose recorded range is given in NEXPLAN's
 * (crystallographic) indices: "min,step,max", or "min,max" for a slab of the given thickness about `slab.centre`
 * (MDNorm v1 integrates an axis given two values). Mantid's default convention labels the reflection NEXPLAN calls h
 * as −h with the same UB (ISAW UB files keep UB's sign; ISAW peaks files flip hkl), so for it every limit is mirrored.
 */
export function mdnormBinning(axis: { readonly min: number; readonly step: number; readonly max: number }, convention: QConvention, slab?: { readonly centre: number; readonly thickness: number }): string {
  const num = (x: number) => Number(x.toFixed(6));
  const sign = convention === "inelastic" ? -1 : 1;
  if (slab) return `${num(sign * slab.centre - slab.thickness / 2)},${num(sign * slab.centre + slab.thickness / 2)}`;
  return convention === "inelastic" ? `${num(-axis.max)},${axis.step},${num(-axis.min)}` : `${num(axis.min)},${axis.step},${num(axis.max)}`;
}

/** An energy-transfer axis (meV): the range rounded out to whole bins of FWHM(E = 0)/perFwhm, the bin rounded to the nearest nice step (1, 2, 2.5, 5 × 10ⁿ, on a log scale). */
export function energyBinning(elasticFwhm: number, eMin: number, eMax: number, perFwhm: number): { min: number; max: number; step: number; bins: number } {
  const step = niceStep(elasticFwhm / perFwhm);
  return { ...roundRange(eMin, eMax, step), step };
}
