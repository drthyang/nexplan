/** The instrument catalog, and the chopper spectrometers' energy resolution (a port of Mantid PyChop). */
import { z } from "zod";
import { energyResolution, FERMI_PACKAGES, FREQUENCIES, CNCS_SLOTS, type ChopperSetting, type CncsMode, type FermiInstrument } from "../../core/instrument/pychop.ts";
import { blockedAt, maskedPixelCount } from "../../core/instrument/acceptance.ts";
import { acceptance } from "../../core/instrument/capability.ts";
import { coveredTwoTheta, panelAngles } from "../../core/instrument/simulate.ts";
import { neutronWavelengthA } from "../../core/physics/energy.ts";
import { SNS_INSTRUMENTS } from "../../core/ub/instrumentsSns.ts";
import { DGS_DEFAULT_CHOPPER } from "../../ui/experimentState.ts";
import { axisName, describeGoniometer, resolveInstrument } from "../instrument.ts";
import { acceptanceFields, instrumentField } from "../shared.ts";
import { defineTool, ToolError } from "../tool.ts";

const choppers = (id: string) =>
  id === "cncs"
    ? Object.entries(CNCS_SLOTS).map(([name, slot]) => ({ name, label: `double-disk slot ${slot} mm` }))
    : id === "arcs" || id === "sequoia"
      ? Object.entries(FERMI_PACKAGES[id]).map(([name, p]) => ({ name, label: p.label }))
      : [];

export const listInstruments = defineTool({
  name: "list_instruments",
  title: "SNS instruments",
  description:
    "The SNS instruments NEXPLAN simulates, with what each is for: TOPAZ (single-crystal Laue, planned as an orientation list; cryogenic ω or ambient ω, φ with χ = 135°), CORELLI (rotation scans), NOMAD and POWGEN (powder: focused banks, POWGEN chopper frames), ARCS, SEQUOIA and CNCS (chopper spectrometers, elastic line only: powder rings and ψ scans at Ei). " +
    "Without an instrument, a short list; with one, its goniometer axes and ranges, band or Ei range, choppers, banks, frames, detector coverage and sources (and panel names with include_panels, for masks).",
  input: z.strictObject({
    instrument: instrumentField.optional(),
    include_panels: z.boolean().optional().describe("List every detector panel (name, 2θ span, distance, pixels); default false."),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  run(args) {
    if (!args.instrument)
      return {
        instruments: SNS_INSTRUMENTS.map((i) => ({
          id: i.id,
          label: i.label,
          samples: i.modes,
          ...(i.incident ? { ei_mev: { default: i.incident.eiMeV, min: i.incident.eiMin, max: i.incident.eiMax } } : { band_angstrom: [i.lambdaMin, i.lambdaMax] }),
          axes: i.goniometer.axes.map((ax) => (ax.fixed !== undefined ? `${axisName(ax.name)} fixed at ${ax.fixed}°` : axisName(ax.name))).join(", ") || "none (sample fixed)",
          plan: i.plan?.kind === "list" ? "orientation list" : i.plan?.kind === "scan" ? `rotation scan ${i.plan.start}–${i.plan.end}° in ${i.plan.step}° steps` : "sample fixed",
        })),
        generic_beam: "powder_pattern simulates a generic X-ray or neutron beam at one wavelength or one TOF bank; list_reflections and reflection_info need no instrument.",
      };
    const i = SNS_INSTRUMENTS.find((x) => x.id === args.instrument)!;
    const panels = i.detectors ?? [];
    const angles = panels.map(panelAngles);
    const def = DGS_DEFAULT_CHOPPER[i.id];
    return {
      id: i.id,
      label: i.label,
      samples: i.modes,
      goniometer: describeGoniometer(i.goniometer),
      plan: i.plan ?? "sample fixed",
      ...(i.incident
        ? {
            incident: { ei_mev_default: i.incident.eiMeV, ei_mev_min: i.incident.eiMin, ei_mev_max: i.incident.eiMax, elastic_fwhm_default: i.incident.elasticFwhm },
            choppers: { options: choppers(i.id), frequencies_hz: FREQUENCIES[i.id as keyof typeof FREQUENCIES], default: def },
          }
        : { band_angstrom: [i.lambdaMin, i.lambdaMax] }),
      l1_m: i.l1,
      detectors: { panels: panels.length, pixels: panels.reduce((n, p) => n + p.nCols * p.nRows, 0), two_theta_covered_deg: coveredTwoTheta(angles) },
      ...(i.banks ? { focused_banks: i.banks.list.map((b, k) => ({ index: k, name: b.name, panels: b.panels.length, ...(b.twoThetaDeg !== undefined ? { two_theta: b.twoThetaDeg } : {}), ...(b.l2 !== undefined ? { l2: b.l2 } : {}), ...(b.difc !== undefined ? { difc: b.difc } : {}), ...(b.dOverD !== undefined ? { d_over_d: b.dOverD } : {}) })), banks_source: i.banks.source } : {}),
      ...(i.frames ? { frames: i.frames.list.map((f) => ({ centre: f.centre, hz: f.hz, band: [f.lambdaMin, f.lambdaMax], d_range: [f.dMin, f.dMax], measured_profile: f.profile !== undefined })), frames_source: i.frames.source } : {}),
      ...(args.include_panels ? { panel_list: panels.map((p, k) => ({ index: k, name: p.name, two_theta: [angles[k]!.twoThetaMin, angles[k]!.twoThetaMax], two_theta_centre: angles[k]!.twoThetaCenter, azimuth_centre: angles[k]!.azimuthCenter, l2: angles[k]!.l2, pixels: [p.nCols, p.nRows] })) } : {}),
      source: i.source,
    };
  },
});

export const chopperResolution = defineTool({
  name: "chopper_resolution",
  title: "Chopper spectrometer energy resolution",
  description:
    "Energy resolution (FWHM, meV) of ARCS, SEQUOIA or CNCS at an incident energy and energy transfers, for a chopper setting: a TypeScript port of Mantid PyChop (ARCS and SEQUOIA parameters tuned to ORNL vanadium data), tested against PyChop to 1e-6. " +
    "Also the elastic width at every frequency of that chopper, to compare settings. No flux. Reports when the chopper does not transmit at that energy and frequency.",
  input: z.strictObject({
    instrument: z.enum(["arcs", "sequoia", "cncs"]),
    ei_mev: z.number().positive().describe("Incident energy (meV)."),
    chopper: z.string().optional().describe("Fermi package (ARCS-100-1.5-AST, …) or CNCS mode (High Flux, Intermediate, High Resolution); default the instrument's (list_instruments)."),
    frequency: z.number().positive().optional().describe("Final-chopper frequency (Hz); default 300."),
    transfers: z.array(z.number()).optional().describe("Energy transfers (meV, below Ei); default [0], the elastic line."),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  run(args) {
    const id = args.instrument;
    const def = DGS_DEFAULT_CHOPPER[id]!;
    const chopper = args.chopper ?? def.chopper;
    const frequency = args.frequency ?? def.frequency;
    if (!choppers(id).some((c) => c.name === chopper)) throw new ToolError(`${id} has no chopper '${chopper}'; choose ${choppers(id).map((c) => c.name).join(", ")}.`);
    const freqs = FREQUENCIES[id];
    if (!freqs.includes(frequency)) throw new ToolError(`${id}'s chopper runs at ${freqs.join(", ")} Hz, not ${frequency}.`);
    const setting = (f: number): ChopperSetting => (id === "cncs" ? { instrument: "cncs", mode: chopper as CncsMode, frequency: f } : { instrument: id as FermiInstrument, package: chopper, frequency: f });
    const ei = args.ei_mev;
    const transfers = args.transfers ?? [0];
    const rows = transfers.map((e) => {
      const w = e < ei ? energyResolution(setting(frequency), ei, e) : undefined;
      return { transfer_mev: e, fwhm_mev: w ?? null, ...(w === undefined ? { note: e >= ei ? "transfer must be below Ei" : "no transmission at this Ei and frequency" } : { fwhm_fraction_of_ei: w / ei }) };
    });
    return {
      instrument: id,
      chopper,
      frequency_hz: frequency,
      ei_mev: ei,
      wavelength: neutronWavelengthA(ei),
      resolution: rows,
      elastic_by_frequency: freqs.map((f) => {
        const w = energyResolution(setting(f), ei, 0);
        return { frequency_hz: f, fwhm_mev: w ?? null };
      }),
      source: "Mantid PyChop @ 67c2f43 (Chop.py, Instruments.py, MulpyRep.py; arcs/sequoia/cncs.yaml), ported in src/core/instrument/pychop.ts.",
    };
  },
});

export const configureInstrument = defineTool({
  name: "configure_instrument",
  title: "Set an instrument's goniometer limits, masks and shadows",
  description:
    "Sets, for this session, what limits an instrument's acceptance beyond its geometry: narrower goniometer ranges (collisions, a sample environment), detector masks (edge pixels, panels off, Mantid detector IDs or a Mantid mask file) and sample-environment shadows (an opening, a leg, a box; fixed in the lab or turning with a goniometer axis). " +
    "Every later tool on that instrument uses them and says so, as the web app's Detectors page sets them for every page. Fields given replace those set before; clear removes them all. Without fields, reports what is set. Returns the effect: pixels masked and the solid angle left.",
  input: z.strictObject({
    instrument: instrumentField,
    ...acceptanceFields,
    clear: z.boolean().optional().describe("Remove everything set for this instrument."),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(args, { workspace }) {
    const id = args.instrument;
    if (args.clear) workspace.setAcceptance(id, undefined);
    const given = { ...(args.goniometer_limits ? { goniometer_limits: args.goniometer_limits } : {}), ...(args.masks ? { masks: args.masks } : {}), ...(args.shadows ? { shadows: args.shadows } : {}) };
    if (Object.keys(given).length) {
      const next = { ...(workspace.acceptance(id) ?? {}), ...given };
      // Validated before it is kept: unknown panels, axes or mask files fail here.
      await resolveInstrument({ instrument: id, ...next });
      workspace.setAcceptance(id, next);
    }
    const ins = await resolveInstrument({ instrument: id }, workspace);
    const bare = await resolveInstrument({ instrument: id, goniometer_limits: [], masks: {}, shadows: [] });
    const masked = maskedPixelCount(ins.panels);
    const blocked = blockedAt(ins.shadows, ins.exp.angles);
    const now = acceptance(ins.panels, blocked, { directions: 30_000 });
    const before = acceptance(bare.panels, undefined, { directions: 30_000 });
    return {
      instrument: ins.preset.label,
      set: workspace.acceptance(id) ?? "nothing: the full detector, no shadows, the catalog's goniometer ranges",
      goniometer: describeGoniometer(ins.model),
      pixels_masked_percent: masked.total ? (100 * masked.pixels) / masked.total : 0,
      panels_off: masked.panelsOff,
      fraction_of_sphere: { now: now.fraction, without: before.fraction },
      ...(ins.shadows ? { shadows_at: `zero goniometer angles (${ins.model.axes.map((ax) => axisName(ax.name)).join(", ") || "sample fixed"}); shadows that turn with an axis move with it` } : {}),
    };
  },
});
