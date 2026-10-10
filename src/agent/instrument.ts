/**
 * An instrument as the tools use it: the catalog entry with its detector geometry, the user's band or chopper, and
 * the goniometer limits, masks and shadows that every hit test honours, built with the web app's own state
 * functions (ui/experimentState.ts) so a tool and the app agree for the same choices.
 */
import { backToBackFwhm, backToBackValidFrom, type TofShape } from "../core/diffraction/tof.ts";
import { applyMasks, maskedPixelCount, parseMantidMask, type MaskFile, type MaskSettings, type ShadowShape, type Shadows } from "../core/instrument/acceptance.ts";
import type { Blocked, DetectorPanel } from "../core/instrument/detectors.ts";
import { focusedBank } from "../core/instrument/focus.ts";
import { CNCS_SLOTS, FERMI_PACKAGES, FREQUENCIES } from "../core/instrument/pychop.ts";
import { panelAngles, type PanelAngles } from "../core/instrument/simulate.ts";
import type { GoniometerModel } from "../core/ub/goniometer.ts";
import type { ChopperFrame, InstrumentPreset } from "../core/ub/instruments.ts";
import { SNS_INSTRUMENTS } from "../core/ub/instrumentsSns.ts";
import {
  catalogEntry,
  chooseInstrument,
  CUSTOM_CHOPPER,
  DEFAULT_EXPERIMENT,
  DGS_DEFAULT_CHOPPER,
  dgsOf,
  limitedGoniometer,
  masksOf,
  shadowsOf,
  withDgs,
  withEi,
  withIncident,
  withLimits,
  withMasks,
  withShadows,
  type ExperimentState,
} from "../ui/experimentState.ts";
import { readText, type InstrumentArgs } from "./shared.ts";
import type { Workspace } from "./workspace.ts";
import { ToolError } from "./tool.ts";

export interface ResolvedInstrument {
  /** The web app's state for these choices (band, Ei and ΔE/E, chopper, limits, masks, shadows). */
  readonly exp: ExperimentState;
  /** The preset with the user's goniometer limits and masked detectors. */
  readonly preset: InstrumentPreset;
  readonly model: GoniometerModel;
  readonly panels: readonly DetectorPanel[];
  readonly info: readonly PanelAngles[];
  readonly l1: number;
  readonly shadows: Shadows | undefined;
  /** What the caller should know about the choices made (a chopper that does not transmit, masked pixels). */
  readonly notes: readonly string[];
}

const ASCII: Readonly<Record<string, string>> = { ω: "omega", χ: "chi", φ: "phi", ψ: "psi" };

/** An axis name in ASCII (omega, chi, phi, psi). */
export const axisName = (name: string) => ASCII[name] ?? name;

/** The index of an axis given by index or by name (ASCII or Greek). */
export function axisIndex(model: GoniometerModel, ref: number | string): number {
  if (typeof ref === "number") {
    if (ref < model.axes.length) return ref;
  } else {
    const want = axisName(ref.trim()).toLowerCase();
    const k = model.axes.findIndex((ax) => axisName(ax.name).toLowerCase() === want);
    if (k >= 0) return k;
  }
  throw new ToolError(`${model.label} has no axis ${JSON.stringify(ref)}; its axes are ${model.axes.map((ax, i) => `${i} ${axisName(ax.name)}`).join(", ") || "none (the sample is fixed)"}.`);
}

/** The goniometer for a caller: each axis with its ASCII name, range and fixed value. */
export const describeGoniometer = (model: GoniometerModel) => ({
  label: model.label,
  note: model.note,
  axes: model.axes.map((ax, i) => ({ index: i, name: axisName(ax.name), direction: ax.direction, sense: ax.sense === 1 ? "counter-clockwise" : "clockwise", ...(ax.fixed !== undefined ? { fixed: ax.fixed } : { min: ax.min, max: ax.max }), ...(ax.log ? { log: ax.log } : {}) })),
});

/**
 * Goniometer angles from a list (axis order) or a map by axis name, on top of `base` (default zeros); fixed axes
 * always take their fixed value.
 */
export function resolveAngles(model: GoniometerModel, given: readonly number[] | Readonly<Record<string, number>> | undefined, base?: readonly number[]): number[] {
  const out = model.axes.map((ax, i) => ax.fixed ?? base?.[i] ?? 0);
  if (Array.isArray(given)) {
    if (given.length > model.axes.length) throw new ToolError(`${given.length} angles given, but ${model.label} has ${model.axes.length} axes (${model.axes.map((ax) => axisName(ax.name)).join(", ") || "none"}).`);
    given.forEach((v, i) => model.axes[i]!.fixed === undefined && (out[i] = v));
  } else if (given) for (const [name, v] of Object.entries(given)) {
    const k = axisIndex(model, name);
    if (model.axes[k]!.fixed === undefined) out[k] = v;
  }
  return out;
}

/** Notes for angles outside a free axis's range (a full turn wraps, a narrower range is a limit). */
export function angleWarnings(model: GoniometerModel, angles: readonly number[]): string[] {
  return model.axes.flatMap((ax, i) => {
    const v = angles[i]!;
    if (ax.fixed !== undefined || ax.max - ax.min >= 360 || (v >= ax.min - 1e-9 && v <= ax.max + 1e-9)) return [];
    return [`${axisName(ax.name)} = ${v}° is outside its range ${ax.min}° to ${ax.max}°.`];
  });
}

const choppersOf = (id: string): readonly string[] => (id === "cncs" ? Object.keys(CNCS_SLOTS) : id === "arcs" || id === "sequoia" ? Object.keys(FERMI_PACKAGES[id]) : []);

/**
 * The instrument with the caller's choices applied (validated, with a message that says what is allowed). Goniometer
 * limits, masks and shadows come from `args`, else from what configure_instrument set in the session's workspace.
 */
export async function resolveInstrument(given: InstrumentArgs, workspace?: Workspace): Promise<ResolvedInstrument> {
  const id = given.instrument;
  const session = workspace?.acceptance(id);
  const args: InstrumentArgs = {
    ...given,
    ...(given.goniometer_limits === undefined && session?.goniometer_limits ? { goniometer_limits: session.goniometer_limits } : {}),
    ...(given.masks === undefined && session?.masks ? { masks: session.masks } : {}),
    ...(given.shadows === undefined && session?.shadows ? { shadows: session.shadows } : {}),
  };
  const entry = catalogEntry(id);
  if (!entry) throw new ToolError(`Unknown instrument '${id}'.`);
  let exp = chooseInstrument(DEFAULT_EXPERIMENT, id);
  const notes: string[] = [];

  // Chopper spectrometers: chopper setting, then Ei, then an explicit width.
  const dgs = DGS_DEFAULT_CHOPPER[id];
  if (!entry.incident) {
    for (const k of ["ei_mev", "chopper", "chopper_frequency", "elastic_fwhm"] as const) if (args[k] !== undefined) throw new ToolError(`${k} applies to the chopper spectrometers (arcs, sequoia, cncs), not ${id}.`);
  } else {
    if (args.lambda_min !== undefined || args.lambda_max !== undefined) throw new ToolError(`${entry.label} is monochromatic: set ei_mev (and the chopper for its width), not a wavelength band.`);
    if (args.chopper !== undefined || args.chopper_frequency !== undefined) {
      const chopper = args.chopper ?? dgs!.chopper;
      const frequency = args.chopper_frequency ?? dgs!.frequency;
      if (!choppersOf(id).includes(chopper)) throw new ToolError(`${entry.label} has no chopper '${chopper}'; choose ${choppersOf(id).join(", ")}.`);
      const freqs = FREQUENCIES[id as keyof typeof FREQUENCIES];
      if (!freqs.includes(frequency)) throw new ToolError(`${entry.label}'s chopper runs at ${freqs.join(", ")} Hz, not ${frequency}.`);
      exp = withDgs(exp, { ...dgsOf(exp), chopper, frequency });
    }
    if (args.ei_mev !== undefined) {
      const { eiMin, eiMax } = entry.incident;
      if (args.ei_mev < eiMin || args.ei_mev > eiMax) throw new ToolError(`${entry.label} takes Ei from ${eiMin} to ${eiMax} meV, not ${args.ei_mev}.`);
      exp = withIncident(exp, args.ei_mev);
    }
    if (args.elastic_fwhm !== undefined) exp = withEi({ ...exp, dgs: { ...exp.dgs, [id]: { ...dgsOf(exp), chopper: CUSTOM_CHOPPER } } }, exp.eiMeV, args.elastic_fwhm);
  }

  // White beam: a POWGEN frame, or an explicit band.
  if (args.frame !== undefined) {
    const frames = entry.frames?.list;
    if (!frames) throw new ToolError(`${entry.label} has no chopper frames; set lambda_min and lambda_max instead.`);
    const f = frames.find((x) => Math.abs(x.centre - args.frame!) < 5e-3);
    if (!f) throw new ToolError(`${entry.label} has no ${args.frame} Å frame; its frames are centred at ${frames.map((x) => `${x.centre} Å (${x.hz} Hz)`).join(", ")}.`);
    exp = { ...exp, lambdaMin: f.lambdaMin, lambdaMax: f.lambdaMax };
  }
  if (args.lambda_min !== undefined || args.lambda_max !== undefined) {
    const lambdaMin = args.lambda_min ?? exp.lambdaMin;
    const lambdaMax = args.lambda_max ?? exp.lambdaMax;
    if (!(lambdaMax > lambdaMin)) throw new ToolError(`The band needs lambda_min < lambda_max (got ${lambdaMin}–${lambdaMax} Å).`);
    exp = { ...exp, lambdaMin, lambdaMax };
  }

  const catalog = SNS_INSTRUMENTS.find((i) => i.id === id)!;
  for (const lim of args.goniometer_limits ?? []) {
    const k = axisIndex(catalog.goniometer, lim.axis);
    if (catalog.goniometer.axes[k]!.fixed !== undefined) throw new ToolError(`${axisName(catalog.goniometer.axes[k]!.name)} is fixed on ${entry.label}; only free axes take limits.`);
    exp = withLimits(exp, k, [lim.min, lim.max]);
  }

  if (args.masks) {
    const m = args.masks;
    let file: MaskFile | undefined;
    if (m.mask_file !== undefined) {
      const f = await readText(m.mask_file, "mask file");
      try {
        file = parseMantidMask(f.text, f.name);
      } catch (e) {
        throw new ToolError(`${f.path}: ${(e as Error).message}`);
      }
    }
    if (m.detector_ids !== undefined) {
      if (!/^[\d,\s-]*$/.test(m.detector_ids)) throw new ToolError(`detector_ids takes ranges such as '0-15,4096', not '${m.detector_ids}'.`);
      file = { name: file?.name ?? "detector_ids", detids: [file?.detids, m.detector_ids].filter(Boolean).join(","), components: file?.components ?? [] };
    }
    const names = new Set(catalog.detectors!.map((p) => p.name));
    const unknown = (m.panels_off ?? []).filter((n) => !names.has(n));
    if (unknown.length) throw new ToolError(`${entry.label} has no panel ${unknown.join(", ")}; its panels are ${[...names].slice(0, 6).join(", ")}, … (list_instruments with include_panels lists them).`);
    const masks: MaskSettings = { edgeRows: m.edge_rows ?? 0, edgeCols: m.edge_cols ?? 0, panelsOff: m.panels_off ?? [], ...(file ? { file } : {}) };
    exp = withMasks(exp, masks);
  }
  if (args.shadows?.length) {
    const shapes: ShadowShape[] = args.shadows.map((s) => {
      const frame = s.turns_with !== undefined ? { turnsWith: s.turns_with } : {};
      switch (s.kind) {
        case "opening":
          return { kind: "opening", halfAngle: s.half_angle, ...frame };
        case "sector":
          return { kind: "sector", gamma: s.gamma, halfWidth: s.half_width, ...frame };
        case "box":
          return { kind: "box", gammaMin: s.gamma_min, gammaMax: s.gamma_max, nuMin: s.nu_min, nuMax: s.nu_max, ...frame };
      }
    });
    exp = withShadows(exp, shapes);
  }

  // As the simulation pages build it (snsShared.tsx useSnsInstrument).
  const model = limitedGoniometer(catalog.goniometer, exp.limits[id]);
  const panels = applyMasks(catalog.detectors!, masksOf(exp));
  const shapes = shadowsOf(exp);
  const masked = maskedPixelCount(panels);
  if (session && (given.goniometer_limits === undefined || given.masks === undefined || given.shadows === undefined))
    notes.push(`Set for ${entry.label} in this session (configure_instrument): ${[session.goniometer_limits?.length ? `limits on ${session.goniometer_limits.length} axis${session.goniometer_limits.length > 1 ? "es" : ""}` : "", session.masks ? "masks" : "", session.shadows?.length ? `${session.shadows.length} shadow${session.shadows.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(", ")}.`);
  if (masked.pixels) notes.push(`${((100 * masked.pixels) / masked.total).toFixed(1)} % of the detector pixels are masked${masked.panelsOff ? ` (${masked.panelsOff} panels off)` : ""}.`);
  if (entry.incident && dgsOf(exp).chopper !== CUSTOM_CHOPPER) {
    // withIncident keeps the previous width where the chopper does not transmit: say so.
    const d = dgsOf(exp);
    if (Number.isNaN(withIncident({ ...exp, eRes: Number.NaN }, exp.eiMeV).eRes))
      notes.push(`PyChop gives no transmission for ${d.chopper} at ${d.frequency} Hz and Ei = ${exp.eiMeV} meV, so the elastic width ΔE/E = ${exp.eRes} is used. Choose another chopper or frequency, or set elastic_fwhm.`);
  }
  return {
    exp,
    preset: { ...catalog, goniometer: model, detectors: panels },
    model,
    panels,
    info: panels.map(panelAngles),
    l1: catalog.l1 ?? 0,
    shadows: shapes.length ? { shapes, model } : undefined,
    notes,
  };
}

/** The beam as a caller should read it: the band, or Ei with its elastic width and chopper. */
export function beamSummary(r: ResolvedInstrument) {
  const e = r.exp;
  const entry = catalogEntry(e.instrumentId)!;
  if (entry.incident) {
    const d = dgsOf(e);
    return { ei_mev: e.eiMeV, wavelength: (e.lambdaMin + e.lambdaMax) / 2, elastic_fwhm_fraction: e.eRes, elastic_fwhm_mev: e.eRes * e.eiMeV, chopper: d.chopper === CUSTOM_CHOPPER ? "custom width" : `${d.chopper} at ${d.frequency} Hz`, lambda_min: e.lambdaMin, lambda_max: e.lambdaMax };
  }
  const frame = entry.frames?.list.find((f) => Math.abs(f.lambdaMin - e.lambdaMin) < 1e-6 && Math.abs(f.lambdaMax - e.lambdaMax) < 1e-6);
  return { lambda_min: e.lambdaMin, lambda_max: e.lambdaMax, ...(frame ? { frame: `${frame.centre} Å at ${frame.hz} Hz` } : {}) };
}

/** The shortest d the detectors reach in the band: λmin / (2 sin θmax). */
export function detectorReach(r: ResolvedInstrument): number {
  const tt = Math.max(...r.info.filter((_, i) => !r.panels[i]!.off).map((a) => a.twoThetaMax));
  return r.exp.lambdaMin / (2 * Math.sin((tt * Math.PI) / 360));
}

/** The web app's d_min note: what the detectors reach below the calculated d_min, and the value to use instead. */
export function dMinNote(r: ResolvedInstrument, dMin: number): string | undefined {
  const reach = detectorReach(r);
  if (!(reach < dMin - 1e-9)) return undefined;
  const suggest = Math.max(0.3, Math.floor(reach * 100) / 100);
  return `The detectors reach d = ${reach.toFixed(3)} Å; reflections are calculated down to d_min = ${dMin} Å only.${suggest < dMin ? ` Pass d_min = ${suggest} to include more (the reflection list grows as 1/d³).` : ""}`;
}

/**
 * The instrument's focused banks (NOMAD six, POWGEN one) as the Powder page builds them: member panels by name,
 * the published 2θ, L2 and DIFC where there are some; banks masked or shadowed throughout are left out. None for a
 * chopper spectrometer (it records the elastic 2θ pattern).
 */
export function focusedBanksOf(ins: ResolvedInstrument, blocked?: Blocked) {
  const { preset, panels, l1, exp } = ins;
  if (preset.incident) return [];
  return (preset.banks?.list ?? [])
    .map((spec, index) => {
      const idx = spec.panels.map((n) => panels.findIndex((q) => q.name === n)).filter((i) => i >= 0);
      return {
        index,
        spec,
        idx,
        bank: focusedBank(spec.name, idx.map((i) => panels[i]!), l1, exp.lambdaMin, exp.lambdaMax, {
          ...(spec.twoThetaDeg !== undefined ? { twoThetaDeg: spec.twoThetaDeg } : {}),
          ...(spec.l2 !== undefined ? { l2: spec.l2 } : {}),
          ...(spec.difc !== undefined ? { difc: spec.difc } : {}),
          ...(blocked ? { blocked } : {}),
        }),
      };
    })
    .filter((f) => f.idx.length > 0 && f.bank.omega > 0);
}

/** GSAS-II TOF profile of a POWGEN frame, held at the shortest d where the fitted parameters are physical (as the Powder page). */
export function frameShape(pr: NonNullable<ChopperFrame["profile"]>): Extract<TofShape, { kind: "backToBack" }> {
  const base = { kind: "backToBack" as const, alpha1: pr.alpha, beta0: pr.beta0, beta1: pr.beta1, betaq: pr.betaq, sig0: pr.sig0, sig1: pr.sig1, sig2: pr.sig2, sigq: pr.sigq };
  const validFrom = backToBackValidFrom(base);
  return { ...base, ...(validFrom !== undefined ? { validFrom } : {}) };
}

/** FWHM in d (Å) of a line at d for a TOF peak shape on a bank of the given DIFC. */
export const fwhmInD = (shape: TofShape, difc: number, d: number) => (shape.kind === "gaussian" ? shape.dOverD * d : backToBackFwhm(shape, d) / difc);
