/**
 * Instrument and simulation state, kept in App so it survives page switches.
 * It holds no detector geometry: that loads with the simulation pages.
 */
import { neutronWavelengthA } from "../core/physics/energy.ts";
import type { GoniometerModel } from "../core/ub/goniometer.ts";
import { GENERIC_INSTRUMENT, SNS_CATALOG, type CatalogEntry } from "../core/ub/instrumentCatalog.ts";
import { NO_MASKS, type MaskFile, type MaskSettings, type ShadowShape } from "../core/instrument/acceptance.ts";
import { energyResolution, type ChopperSetting, type CncsMode, type FermiInstrument } from "../core/instrument/pychop.ts";

/** The Orientation page's goniometer and Laue-view settings. */
export interface GonioState {
  readonly angles: readonly number[];
  readonly lambdaMin: number;
  readonly lambdaMax: number;
  readonly frame: "lab" | "sample";
  readonly showEwald: boolean;
}

export const DEFAULT_GONIO: GonioState = { angles: [0, 0, 0], lambdaMin: 0.4, lambdaMax: 3.5, frame: "lab", showEwald: false };

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
  /** Powder on an instrument with focused banks: the bank shown (null = the one nearest 2θ = 90°), or a single panel instead. */
  readonly bank: number | null;
  readonly powderView: "bank" | "panel";
  /** Powder peak widths: the instrument's published resolution where there is one, or the Δd/d of the bar. */
  readonly peakWidth: "instrument" | "fixed";
  /** Relative resolution Δd/d (FWHM) of simulated peaks and rings. */
  readonly dOverD: number;
  /** Instruments that take both (chopper spectrometers): which sample is simulated. */
  readonly sample: "single-crystal" | "powder";
  /** Chopper spectrometers: incident energy (meV) and elastic resolution ΔE/E (FWHM). */
  readonly eiMeV: number;
  readonly eRes: number;
  /** Detector masks per detector geometry (TOPAZ cryogenic and ambient share one). */
  readonly masks: Readonly<Record<string, MaskSettings>>;
  /** Sample-environment shadows per instrument id. */
  readonly shadows: Readonly<Record<string, readonly ShadowShape[]>>;
  /** Suggested binning: projection axes (r.l.u., rows), bins per resolution FWHM in Q and in energy, the sample's mosaic (FWHM, deg), and the d down to which it bins (Å; absent: the calculation's d_min). */
  readonly binning: Binning;
  /** Chopper spectrometers, per instrument id: the chopper setting for the energy resolution, and the binning inputs. */
  readonly dgs: Readonly<Record<string, DgsSettings>>;
}

export interface Binning {
  readonly axes: readonly (readonly number[])[];
  readonly perFwhmQ: number;
  readonly perFwhmE: number;
  readonly mosaicDeg: number;
  readonly dMin?: number;
  /** A slice: this axis is integrated over a slab about `centre` (r.l.u.) instead of binned. */
  readonly slab?: { readonly axis: number; readonly centre: number };
  /**
   * Mantid's Q.convention for the MDNorm call (absent: "inelastic", Mantid's default). NEXPLAN's indices are
   * crystallographic (q = k_f − k_i = UB·h); with the same UB, Mantid's default labels that reflection −h.
   */
  readonly qConvention?: "inelastic" | "crystallography";
}

/**
 * A chopper spectrometer's chopper (a Fermi package and its frequency, or a CNCS mode and the double-disk frequency),
 * its energy-transfer range (meV; absent: −0.2 Ei to 0.95 Ei, SNS autoreduction's default), and for the Q estimate
 * the sample size (mm) and the incident divergence (FWHM, mrad).
 */
export interface DgsSettings {
  readonly chopper: string;
  readonly frequency: number;
  readonly eMin?: number;
  readonly eMax?: number;
  readonly sampleMm: number;
  readonly divergenceMrad: number;
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
  bank: null,
  powderView: "bank",
  peakWidth: "instrument",
  dOverD: 0.005,
  sample: "single-crystal",
  eiMeV: 60,
  eRes: 0.04,
  masks: {},
  shadows: {},
  binning: { axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], perFwhmQ: 2, perFwhmE: 3, mosaicDeg: 0 },
  dgs: {},
};

export const catalogEntry = (id: string): CatalogEntry | undefined => SNS_CATALOG.find((i) => i.id === id);

/** Ei (meV) and ΔE/E set the band: λ = √(81.8042/Ei), Δλ/λ = ΔE/(2E), split about λ. */
export function withEi(exp: ExperimentState, eiMeV: number, eRes: number): ExperimentState {
  const lambda = neutronWavelengthA(eiMeV);
  const half = eRes / 4;
  return { ...exp, eiMeV, eRes, lambdaMin: lambda * (1 - half), lambdaMax: lambda * (1 + half) };
}

/**
 * Set Ei and the band it gives. With a chopper setting (not "custom"), the elastic width ΔE/E is PyChop's at that Ei
 * (pychop.ts); where that chopper does not transmit, or with a custom width, the current ΔE/E is kept.
 */
export function withIncident(exp: ExperimentState, eiMeV: number): ExperimentState {
  const c = chopperOf(exp);
  const fwhm = c ? energyResolution(c, eiMeV, 0) : undefined;
  return withEi(exp, eiMeV, fwhm !== undefined ? fwhm / eiMeV : exp.eRes);
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
    bank: null,
    sample: modes.includes(exp.sample) ? exp.sample : modes[0]!,
    scan: ins.plan?.kind === "scan" ? { axis: firstFree, start: ins.plan.start, end: ins.plan.end, step: ins.plan.step, interleave: false } : { ...exp.scan, axis: firstFree },
    orientations: [],
  };
  // A chopper spectrometer's elastic width from its chopper setting; the catalog's where that cannot give one.
  return ins.incident ? withIncident({ ...next, eRes: ins.incident.elasticFwhm }, ins.incident.eiMeV) : { ...next, lambdaMin: ins.lambdaMin, lambdaMax: ins.lambdaMax };
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

const finite = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/** The detector geometry an instrument's masks are kept under. */
const maskKey = (id: string) => catalogEntry(id)?.geometry ?? id;

/** The current instrument's masks (checked, since they come from browser storage). */
export function masksOf(exp: ExperimentState): MaskSettings {
  const m = (exp.masks ?? {})[maskKey(exp.instrumentId)] as Partial<MaskSettings> | undefined;
  if (!m || typeof m !== "object") return NO_MASKS;
  const f = m.file as Partial<MaskFile> | undefined;
  const file = f && typeof f.name === "string" && typeof f.detids === "string" && /^[\d,\s-]*$/.test(f.detids) && Array.isArray(f.components) ? { name: f.name, detids: f.detids, components: f.components.filter((n): n is string => typeof n === "string") } : undefined;
  return {
    edgeRows: finite(m.edgeRows, 0, 4096) ? Math.floor(m.edgeRows) : 0,
    edgeCols: finite(m.edgeCols, 0, 4096) ? Math.floor(m.edgeCols) : 0,
    panelsOff: Array.isArray(m.panelsOff) ? m.panelsOff.filter((n): n is string => typeof n === "string") : [],
    ...(file ? { file } : {}),
  };
}

export const withMasks = (exp: ExperimentState, m: MaskSettings): ExperimentState => ({ ...exp, masks: { ...(exp.masks ?? {}), [maskKey(exp.instrumentId)]: m } });

function validShape(s: unknown): s is ShadowShape {
  if (!s || typeof s !== "object") return false;
  const v = s as Record<string, unknown>;
  if (v.turnsWith !== undefined && !finite(v.turnsWith, 0, 16)) return false;
  switch (v.kind) {
    case "opening":
      return finite(v.halfAngle, 0, 90);
    case "sector":
      return finite(v.gamma, -360, 360) && finite(v.halfWidth, 0, 180);
    case "box":
      return finite(v.gammaMin, -360, 360) && finite(v.gammaMax, -360, 720) && finite(v.nuMin, -90, 90) && finite(v.nuMax, -90, 90);
    default:
      return false;
  }
}

/** The current instrument's sample-environment shadows (checked, since they come from browser storage). */
export function shadowsOf(exp: ExperimentState): readonly ShadowShape[] {
  const list = (exp.shadows ?? {})[exp.instrumentId];
  return Array.isArray(list) ? list.filter(validShape) : [];
}

export const withShadows = (exp: ExperimentState, list: readonly ShadowShape[]): ExperimentState => ({ ...exp, shadows: { ...(exp.shadows ?? {}), [exp.instrumentId]: list } });

/** The binning inputs (checked, since they come from browser storage). */
export function binningOf(exp: ExperimentState): Binning {
  const b = exp.binning as Partial<Binning> | undefined;
  const axes = Array.isArray(b?.axes) && b.axes.length === 3 && b.axes.every((r) => Array.isArray(r) && r.length === 3 && r.every((v) => finite(v, -100, 100))) ? b.axes : DEFAULT_EXPERIMENT.binning.axes;
  return {
    axes,
    perFwhmQ: finite(b?.perFwhmQ, 1, 10) ? b.perFwhmQ : 2,
    perFwhmE: finite(b?.perFwhmE, 1, 10) ? b.perFwhmE : 3,
    mosaicDeg: finite(b?.mosaicDeg, 0, 20) ? b.mosaicDeg : 0,
    ...(finite(b?.dMin, 0.05, 100) ? { dMin: b.dMin } : {}),
    ...(b?.slab && [0, 1, 2].includes(b.slab.axis) && finite(b.slab.centre, -1000, 1000) ? { slab: { axis: b.slab.axis, centre: b.slab.centre } } : {}),
    ...(b?.qConvention === "crystallography" ? { qConvention: "crystallography" as const } : {}),
  };
}

/** Chopper settings by default: PyChop's 300 Hz, with the resolution packages, and CNCS High Flux. */
export const DGS_DEFAULT_CHOPPER: Readonly<Record<string, { readonly chopper: string; readonly frequency: number }>> = {
  arcs: { chopper: "ARCS-100-1.5-AST", frequency: 300 },
  sequoia: { chopper: "SEQ-100-2.0-AST", frequency: 300 },
  cncs: { chopper: "High Flux", frequency: 300 },
};

/** The chopper value for a ΔE/E typed by hand instead of PyChop's. */
export const CUSTOM_CHOPPER = "custom";

/** The current instrument's PyChop setting, or undefined (not a chopper spectrometer, or a custom ΔE/E). */
export function chopperOf(exp: ExperimentState): ChopperSetting | undefined {
  const def = DGS_DEFAULT_CHOPPER[exp.instrumentId];
  if (!def) return undefined;
  const d = dgsOf(exp, def);
  if (d.chopper === CUSTOM_CHOPPER) return undefined;
  return exp.instrumentId === "cncs" ? { instrument: "cncs", mode: d.chopper as CncsMode, frequency: d.frequency } : { instrument: exp.instrumentId as FermiInstrument, package: d.chopper, frequency: d.frequency };
}

/** The current chopper spectrometer's settings, or its defaults (DGS_DEFAULT_CHOPPER). */
export function dgsOf(exp: ExperimentState, defaults: { chopper: string; frequency: number } = DGS_DEFAULT_CHOPPER[exp.instrumentId] ?? { chopper: CUSTOM_CHOPPER, frequency: 300 }): DgsSettings {
  const d = (exp.dgs ?? {})[exp.instrumentId] as Partial<DgsSettings> | undefined;
  return {
    chopper: typeof d?.chopper === "string" ? d.chopper : defaults.chopper,
    frequency: finite(d?.frequency, 1, 1000) ? d.frequency : defaults.frequency,
    ...(finite(d?.eMin, -1e5, 1e5) ? { eMin: d.eMin } : {}),
    ...(finite(d?.eMax, -1e5, 1e5) ? { eMax: d.eMax } : {}),
    sampleMm: finite(d?.sampleMm, 0, 1000) ? d.sampleMm : 5,
    divergenceMrad: finite(d?.divergenceMrad, 0, 1000) ? d.divergenceMrad : 0,
  };
}

/** Set the chopper spectrometer's settings; a new chopper setting sets the elastic width (withIncident). */
export const withDgs = (exp: ExperimentState, d: DgsSettings): ExperimentState => withIncident({ ...exp, dgs: { ...(exp.dgs ?? {}), [exp.instrumentId]: d } }, exp.eiMeV);
