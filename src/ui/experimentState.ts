/**
 * Instrument and simulation state, kept in App so it survives page switches.
 * It holds no detector geometry: that loads with the simulation pages.
 */
import { neutronWavelengthA } from "../core/physics/energy.ts";
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
