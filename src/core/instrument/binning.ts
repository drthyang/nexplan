/**
 * Suggested histogram binning for a measurement (Mantid MDNorm / BinMD): the HKL range it records (hklRange.ts),
 * binned with a round step along each axis, and for a chopper spectrometer an energy-transfer axis.
 *
 * The bins are a practical starting point, not a resolution or counting-statistics optimum: single-crystal volumes
 * from TOPAZ and CORELLI are usually binned with about 200–400 bins per axis, and the best bin for a measurement
 * depends on its counts, so it is found by trying. By default each axis gets the round step (autoStep) that puts its
 * recorded range in 201–401 bins, nearest 301; a chosen step applies to every axis. Q bins are centred on zero (and so on integer hkl when 1/step is
 * an integer), the way MDNorm ranges such as −5.025, 0.05, 5.025 are usually written. The energy-transfer step is
 * 1 % of Ei over −0.5 Ei to 0.99 Ei by default, Mantid's default for direct-geometry reduction
 * (DgsConvertToEnergyTransfer.cpp @ 67c2f43).
 */
import type { Mat3, Vec3 } from "@materia/core/math/types";
import type { Blocked } from "./detectors.ts";
import { hklExtent, type Beam, type HklExtent } from "./hklRange.ts";

/** Steps offered for Q axes: 1, 2, 2.5, 4 and 5 × 10ⁿ (r.l.u.), each a divisor of 1 below 0.4. */
const LADDER = [1, 2, 2.5, 4, 5];

/** Round steps (r.l.u.) to choose from by hand. */
export const Q_STEPS = [0.005, 0.01, 0.02, 0.025, 0.04, 0.05, 0.1, 0.2, 0.25];

/** Bins per axis the automatic step aims for: about 300, within 201–401. */
export const AUTO_BINS = { min: 201, target: 301, max: 401 } as const;

/** The round step for a span (r.l.u.): of the 1, 2, 2.5, 4, 5 × 10ⁿ steps, the one giving 201–401 bins nearest 301. */
export function autoStep(span: number): number {
  const ideal = Math.max(span, 1e-6) / AUTO_BINS.target;
  const e = Math.floor(Math.log10(ideal));
  const candidates = [e - 1, e, e + 1].flatMap((k) => LADDER.map((m) => Number((m * 10 ** k).toPrecision(6))));
  const score = (s: number) => Math.abs(Math.log(span / s / AUTO_BINS.target));
  const inWindow = candidates.filter((s) => span / s >= AUTO_BINS.min && span / s <= AUTO_BINS.max);
  return (inWindow.length ? inWindow : candidates).reduce((best, s) => (score(s) < score(best) ? s : best));
}

/** The nearest (in ratio) of 1, 2, 2.5, 4 and 5 × 10ⁿ to x. */
export function binStep(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return NaN;
  const e = Math.floor(Math.log10(x));
  let best = NaN;
  for (const m of [...LADDER, 10]) {
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
}

export interface Binning {
  readonly axes: readonly [AxisBinning, AxisBinning, AxisBinning];
  readonly extent: HklExtent;
}

const clean = (v: number, step: number) => Number(v.toFixed(Math.max(0, -Math.floor(Math.log10(step)) + 3)));

/**
 * Bins of `step` (default autoStep) covering [min, max], centred on multiples of the step: the limits are
 * (k ± ½)·step, so 0 (and integer hkl when 1/step is an integer) is a bin centre.
 */
export function centredBins(min: number, max: number, stepIn?: number): AxisBinning {
  const step = stepIn ?? autoStep(max - min);
  const lo = (Math.floor(min / step + 0.5 + 1e-9) - 0.5) * step;
  const hi = (Math.ceil(max / step - 0.5 - 1e-9) + 0.5) * step;
  return { min: clean(lo, step), max: clean(hi, step), step, bins: Math.round((hi - lo) / step) };
}

/** Whole bins of `step` covering [min, max], with edges on multiples of the step. */
export function roundRange(min: number, max: number, step: number): { min: number; max: number; bins: number } {
  // A limit already on a multiple of the step (to rounding) stays there.
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  return { min: clean(lo, step), max: clean(hi, step), bins: Math.round((hi - lo) / step) };
}

/**
 * The binning for settings R (with the shadows at each, `blocked`), pixel samples (hklRange.ts panelSamples), the
 * beam, the orientation UB (q = UB·h, no 2π) and projection axes W (columns, r.l.u.): the recorded range along each
 * axis within |q| ≤ qMax, in bins of `step` (r.l.u.; absent: autoStep per axis).
 */
export function suggestBinning(
  settings: readonly Mat3[],
  blocked: readonly (Blocked | undefined)[],
  samples: readonly (readonly Vec3[])[],
  beam: Beam,
  UB: Mat3,
  W: Mat3,
  step: number | undefined,
  opts: { readonly qMax?: number } = {},
): Binning | undefined {
  const extent = hklExtent(settings, blocked, samples, beam, UB, W, opts.qMax ?? Infinity);
  if (!extent) return undefined;
  const axes = [0, 1, 2].map((i) => centredBins(extent.min[i]!, extent.max[i]!, step)) as unknown as [AxisBinning, AxisBinning, AxisBinning];
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

/** Mantid's default energy-transfer range and step for direct geometry: −0.5 Ei to 0.99 Ei in steps of 0.01 Ei. */
export const DGS_DEFAULT_ENERGY = { min: -0.5, max: 0.99, step: 0.01 } as const;

/** An energy-transfer axis (meV): steps of 1 % of Ei (Mantid's default), the range rounded out to whole steps. */
export function energyBinning(eiMeV: number, eMin: number, eMax: number): { min: number; max: number; step: number; bins: number } {
  const step = Number((DGS_DEFAULT_ENERGY.step * eiMeV).toPrecision(6));
  return { ...roundRange(eMin, eMax, step), step };
}
