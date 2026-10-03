/**
 * Instrument and simulation state, kept in App so it survives page switches.
 * It holds no detector geometry: that loads with the simulation pages.
 */
import { neutronWavelengthA } from "../core/physics/energy.ts";
import type { GoniometerModel } from "../core/ub/goniometer.ts";
import { GENERIC_INSTRUMENT, SNS_CATALOG, type CatalogEntry } from "../core/ub/instrumentCatalog.ts";

export interface ExperimentState {
  /** An SNS instrument id from the catalog, or GENERIC_INSTRUMENT for the generic beam. */
  readonly instrumentId: string;
  /** Goniometer angles (deg), one per axis of the instrument's goniometer. */
  readonly angles: readonly number[];
  readonly lambdaMin: number;
  readonly lambdaMax: number;
  /** Rotation scan over one axis (single crystal); `interleave` adds the half-way steps. */
  readonly scan: { readonly axis: number; readonly start: number; readonly end: number; readonly step: number; readonly interleave?: boolean };
  /** Orientation list (single crystal, e.g. TOPAZ's ~10 chosen settings): goniometer angles per setting. */
  readonly orientations: readonly (readonly number[])[];
  /** Wanted reflections (hkl) that an orientation list should record: TOPAZ's "chosen peaks". Kept across instruments. */
  readonly wanted: readonly (readonly number[])[];
  /** When a recording of a wanted reflection is well placed: λ in the inner bandFraction of the band, edgeFraction of a panel from its edges. */
  readonly placement: { readonly bandFraction: number; readonly edgeFraction: number };
  /** Goniometer limits set by the user, per instrument id: axis index → [min, max] (deg), replacing the catalog range. */
  readonly limits: Readonly<Record<string, Readonly<Record<number, readonly [number, number]>>>>;
  /** Powder: the panel whose pattern is simulated (null = the one nearest 2θ = 90°). */
  readonly panel: number | null;
  /** Relative resolution Δd/d (FWHM) of simulated peaks and rings. */
  readonly dOverD: number;
  /** Instruments that take both (chopper spectrometers): which sample is simulated. */
  readonly sample: "single-crystal" | "powder";
  /** Chopper spectrometers: incident energy (meV) and elastic resolution ΔE/E (FWHM). */
  readonly eiMeV: number;
  readonly eRes: number;
}

export const DEFAULT_EXPERIMENT: ExperimentState = {
  instrumentId: GENERIC_INSTRUMENT,
  angles: [0, 0, 0],
  lambdaMin: 0.4,
  lambdaMax: 3.5,
  scan: { axis: 0, start: 0, end: 360, step: 5 },
  orientations: [],
  wanted: [],
  placement: { bandFraction: 0.5, edgeFraction: 0.1 },
  limits: {},
  panel: null,
  dOverD: 0.005,
  sample: "single-crystal",
  eiMeV: 60,
  eRes: 0.04,
};

export const catalogEntry = (id: string): CatalogEntry | undefined => SNS_CATALOG.find((i) => i.id === id);

/** Ei (meV) and ΔE/E set the band: λ = √(81.8042/Ei), Δλ/λ = ΔE/(2E), split about λ. */
export function withEi(exp: ExperimentState, eiMeV: number, eRes: number): ExperimentState {
  const lambda = neutronWavelengthA(eiMeV);
  const half = eRes / 4;
  return { ...exp, eiMeV, eRes, lambdaMin: lambda * (1 - half), lambdaMax: lambda * (1 + half) };
}

/** Switch instrument: its goniometer at zero (fixed axes at their values), its band or Ei, its sample kind. */
export function chooseInstrument(exp: ExperimentState, id: string): ExperimentState {
  const ins = catalogEntry(id);
  if (!ins) return { ...exp, instrumentId: GENERIC_INSTRUMENT };
  const modes = ins.modes ?? ["single-crystal"];
  const firstFree = Math.max(0, ins.goniometer.axes.findIndex((ax) => ax.fixed === undefined));
  const next: ExperimentState = {
    ...exp,
    instrumentId: id,
    angles: ins.goniometer.axes.map((ax) => ax.fixed ?? 0),
    panel: null,
    sample: modes.includes(exp.sample) ? exp.sample : modes[0]!,
    scan: ins.plan?.kind === "scan" ? { axis: firstFree, start: ins.plan.start, end: ins.plan.end, step: ins.plan.step, interleave: false } : { ...exp.scan, axis: firstFree },
    orientations: [],
  };
  return ins.incident ? withEi(next, ins.incident.eiMeV, ins.incident.elasticFwhm) : { ...next, lambdaMin: ins.lambdaMin, lambdaMax: ins.lambdaMax };
}

/** The sample kind simulated on this instrument (the one it supports, or the chosen one when it takes both). */
export function sampleKind(exp: ExperimentState): "single-crystal" | "powder" {
  const modes = catalogEntry(exp.instrumentId)?.modes ?? ["single-crystal"];
  return modes.includes(exp.sample) ? exp.sample : modes[0]!;
}

/** The goniometer with the user's limits in place of the catalog ranges. */
export function limitedGoniometer(model: GoniometerModel, limits: Readonly<Record<number, readonly [number, number]>> | undefined): GoniometerModel {
  if (!limits || !Object.keys(limits).length) return model;
  return { ...model, axes: model.axes.map((ax, i) => (limits[i] ? { ...ax, min: limits[i]![0], max: limits[i]![1] } : ax)) };
}

/** Set (or with null, clear) the current instrument's limits on one axis; the angle is kept inside them. */
export function withLimits(exp: ExperimentState, axis: number, range: readonly [number, number] | null): ExperimentState {
  const id = exp.instrumentId;
  const current = { ...(exp.limits[id] ?? {}) };
  if (range) current[axis] = range[0] <= range[1] ? [range[0], range[1]] : [range[1], range[0]];
  else delete current[axis];
  const r = current[axis] ?? (catalogEntry(id)?.goniometer.axes[axis] && [catalogEntry(id)!.goniometer.axes[axis]!.min, catalogEntry(id)!.goniometer.axes[axis]!.max]);
  const angles = r ? exp.angles.map((v, i) => (i === axis ? Math.min(r[1]!, Math.max(r[0]!, v)) : v)) : exp.angles;
  return { ...exp, angles, limits: { ...exp.limits, [id]: current } };
}
