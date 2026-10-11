/**
 * What each instrument can and cannot record, whatever the sample: detector acceptance, d and Q reach, resolution,
 * energy range, goniometer, the fraction of reciprocal space a goniometer reaches, and which instruments suit a
 * measurement goal. Built on core/instrument/capability.ts and directionTable.ts, and on the instrument data the
 * other tools use (catalog, Mantid IDF geometry, NOMAD and POWGEN widths, PyChop).
 */
import { dSpacing } from "@materia/core/crystal/unitCell";
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { mulMat, mulVec, transpose } from "@materia/core/math/mat3";
import { z } from "zod";
import { blockedAt, maskedPixelCount } from "../../core/instrument/acceptance.ts";
import { acceptance, dReach, directQ, fibonacciSphere } from "../../core/instrument/capability.ts";
import { directionTable, recordedCounts } from "../../core/instrument/directionTable.ts";
import { candidateGrid } from "../../core/instrument/plan.ts";
import { energyResolution } from "../../core/instrument/pychop.ts";
import { braggCrossings, coveredTwoTheta, panelAngles, reflectionCoverage } from "../../core/instrument/simulate.ts";
import { neutronEnergyMeV, neutronWavelengthA } from "../../core/physics/energy.ts";
import { axisRotation, type GoniometerModel } from "../../core/ub/goniometer.ts";
import { SNS_CATALOG } from "../../core/ub/instrumentCatalog.ts";
import { SNS_INSTRUMENTS } from "../../core/ub/instrumentsSns.ts";
import { chopperOf, dgsOf } from "../../ui/experimentState.ts";
import { hklText } from "../../ui/format.ts";
import { axisName, beamSummary, describeGoniometer, focusedBanksOf, frameShape, fwhmInD, resolveAngles, resolveInstrument, type ResolvedInstrument } from "../instrument.ts";
import { resolveOrientation } from "../orientation.ts";
import { hklField, instrumentFields, orientationField, planFields, structureId } from "../shared.ts";
import { defineTool, ToolError } from "../tool.ts";
import { DEFAULT_D_MIN, DEFAULT_WAVELENGTH } from "../workspace.ts";
import { resolvePlan } from "./crystal.ts";

const TWO_PI = 2 * Math.PI;
const I3: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** What NEXPLAN does not model for each instrument, beyond the limits every instrument shares. */
const INSTRUMENT_CAVEATS: Readonly<Record<string, readonly string[]>> = {
  "topaz-cryo": ["Single-crystal Laue: reflection positions only, no peak widths or mosaic. The cryogenic goniometer turns ω only, so one rotation axis sets what is reachable (reciprocal_coverage)."],
  "topaz-ambient": ["Single-crystal Laue: reflection positions only, no peak widths or mosaic. χ is fixed at 135°; ω and φ turn."],
  corelli: [
    "Simulated as white-beam Laue diffraction: the cross-correlation chopper that separates elastic scattering is not modelled.",
    "One vertical rotation axis: reflections near the rotation axis are reached only within the detectors' vertical coverage (reciprocal_coverage gives the fraction).",
  ],
  nomad: [
    "Banks 0–4 use calibrated DIFC (ORNL's 2023A GSAS-II file); bank 5 is geometric with a nominal 2θ of 7°, and bank 0's 2θ of 15° is nominal.",
    "The Δd/d per bank was measured in 2014 with 50 of the 99 eight-packs installed; calibrations can exclude packs, which is not modelled.",
    "Total scattering (S(Q), G(r), the Q range and damping of a PDF) is not modelled: Bragg lines only.",
  ],
  powgen: [
    "One focused bank of all 40 panels at an effective 2θ of 90° and L2 of 3.18 m; its DIFC comes from that geometry, not a cycle's calibration.",
    "Measured peak profiles exist only for the 0.8, 1.5 and 2.665 Å frames (2026B high-resolution guide, 60 Hz); the other frames use a fixed Δd/d.",
  ],
  arcs: ["Elastic line only: no inelastic intensity, flux or Q–E coverage of a single crystal (Mantid's DGS Planner does that); the |Q| limits here are kinematic, over the detectors' 2θ range."],
  sequoia: ["Elastic line only: no inelastic intensity, flux or Q–E coverage of a single crystal (Mantid's DGS Planner does that); the |Q| limits here are kinematic, over the detectors' 2θ range."],
  cncs: ["Elastic line only: no inelastic intensity, flux or Q–E coverage of a single crystal (Mantid's DGS Planner does that); the |Q| limits here are kinematic, over the detectors' 2θ range."],
};

/** Limits shared by every instrument, with this one's geometry source. */
function sharedCaveats(ins: ResolvedInstrument): string[] {
  const tubes = ins.panels.some((p) => p.kind === "tube-pack");
  return [
    `Detector positions are nominal: ${ins.preset.source.match(/Detectors: (.*?)\.?$/)?.[1] ?? "the Mantid instrument definition"}, at Mantid commit 67c2f43, not a cycle's calibration.`,
    "No flux, counting time, detector efficiency, background or absorption: what can be recorded, not how well.",
    ...(tubes ? ["Gaps between the tubes of a pack are not modelled."] : []),
  ];
}

/** d and Q reached over the covered 2θ (a chopper spectrometer's band is its elastic width about λ: pass λ for both). */
const reachOf = (twoTheta: readonly (readonly [number, number])[], lambdaMin: number, lambdaMax: number) => {
  const r = dReach(twoTheta[0]![0], twoTheta.at(-1)![1], lambdaMin, lambdaMax);
  return { d_min: r.dMin, d_max: r.dMax, q_min: TWO_PI / r.dMax, q_max: TWO_PI / r.dMin };
};

/** The covered 2θ intervals of the recording panels, or an error when every panel is masked. */
function coveredOf(ins: ResolvedInstrument): [number, number][] {
  const tt = coveredTwoTheta(ins.info.filter((_, i) => !ins.panels[i]!.off));
  if (!tt.length) throw new ToolError(`Every panel of ${ins.preset.label} is masked: nothing is recorded.`);
  return tt;
}

/** POWGEN frames: band, the d range the reduction keeps, and the measured relative width at a few d. */
function framesOf(ins: ResolvedInstrument) {
  const difc = focusedBanksOf(ins)[0]?.bank.difc;
  return (ins.preset.frames?.list ?? []).map((f) => ({
    centre: f.centre,
    hz: f.hz,
    band: [f.lambdaMin, f.lambdaMax],
    d_range: [f.dMin, f.dMax],
    ...(f.profile && difc
      ? {
          fwhm_percent_at_d: Object.fromEntries(
            [0.5, 1, 2, 4]
              .filter((d) => d >= f.dMin && d <= f.dMax)
              .map((d) => [`${d}`, (100 * fwhmInD(frameShape(f.profile!), difc, d)) / d]),
          ),
        }
      : { fwhm: "no measured profile for this frame" }),
  }));
}

export const instrumentLimits = defineTool({
  name: "instrument_limits",
  title: "What an instrument can and cannot record",
  description:
    "The limits of one SNS instrument, independent of the sample: detector coverage (solid angle, 2θ, horizontal and vertical ranges), the d and Q range its band (or Ei) reaches, resolution (NOMAD Δd/d per bank, POWGEN profiles per frame, PyChop energy widths), the goniometer and its ranges, and for chopper spectrometers the kinematic |Q| limits at energy transfers. " +
    "Ends with what NEXPLAN does not model for it. The band, Ei and chopper, and the goniometer limits, masks and shadows set with configure_instrument, change the answer as they would in a measurement.",
  input: z.strictObject({
    ...instrumentFields,
    transfers: z.array(z.number()).optional().describe("Chopper spectrometers: energy transfers (meV) for the |Q| limits and widths; default 0, 0.25, 0.5 and 0.75 Ei."),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run(args, { workspace }) {
    const ins = await resolveInstrument(args, workspace);
    const { preset, exp, panels, model } = ins;
    const blocked = blockedAt(ins.shadows, exp.angles);
    const tt = coveredOf(ins);
    const acc = acceptance(panels, blocked);
    const masked = maskedPixelCount(panels);
    const mono = preset.incident;
    const lambda0 = (exp.lambdaMin + exp.lambdaMax) / 2;
    const banks = focusedBanksOf(ins, blocked);
    let energy: object | undefined;
    if (mono) {
      const ei = exp.eiMeV;
      const chopper = chopperOf(exp);
      const transfers = args.transfers ?? [0, 0.25, 0.5, 0.75].map((x) => x * ei);
      energy = {
        ei_mev: ei,
        ei_range_mev: [mono.eiMin, mono.eiMax],
        chopper: chopper ? `${dgsOf(exp).chopper} at ${dgsOf(exp).frequency} Hz` : "custom width",
        kinematics: transfers.map((e) => {
          const w = chopper && e < ei ? energyResolution(chopper, ei, e) : undefined;
          return e >= ei ? { transfer_mev: e, note: "transfer must be below Ei" } : { transfer_mev: e, q_min: directQ(ei, e, tt[0]![0]), q_max: directQ(ei, e, tt.at(-1)![1]), ...(w !== undefined ? { fwhm_mev: w } : {}) };
        }),
        note: "|Q| (1/Å, with 2π) over the covered 2θ, increasing with 2θ: gaps in 2θ leave gaps in |Q|. Inelastic coverage of a single crystal is not modelled.",
      };
    }
    const singleCrystal = preset.modes?.includes("single-crystal") && model.axes.some((ax) => ax.fixed === undefined);
    return {
      instrument: preset.id,
      label: preset.label,
      samples: preset.modes,
      beam: beamSummary(ins),
      l1_m: ins.l1,
      detectors: {
        panels: panels.length,
        panels_off: masked.panelsOff,
        pixels_masked_percent: masked.total ? (100 * masked.pixels) / masked.total : 0,
        solid_angle_sr: acc.solidAngle,
        fraction_of_sphere: acc.fraction,
        two_theta_deg: acc.twoTheta,
        horizontal_deg: acc.horizontal,
        elevation_deg: [acc.elevation.min, acc.elevation.max],
        angles: "2θ from the beam; horizontal γ = atan2(x, z) from the beam, positive towards +x; elevation ν above the horizontal plane. Gaps under 1° (between tubes and packs) are merged.",
      },
      reach: { ...(mono ? reachOf(tt, lambda0, lambda0) : reachOf(tt, exp.lambdaMin, exp.lambdaMax)), note: mono ? `At λ = ${lambda0.toPrecision(5)} Å (Ei ${exp.eiMeV} meV); a higher Ei reaches shorter d.` : "d = λ/(2 sin θ) over the band and the covered 2θ; Q = 2π/d." },
      ...(banks.length
        ? {
            focused_banks: banks.map((f) => ({
              index: f.index,
              name: f.spec.name,
              two_theta: f.bank.twoThetaDeg,
              two_theta_span: [f.bank.twoThetaMin, f.bank.twoThetaMax],
              l2: f.bank.l2,
              difc: f.bank.difc,
              difc_source: f.spec.difc !== undefined ? "calibrated (published)" : "geometric",
              d_range: [f.bank.dMin, f.bank.dMax],
              ...(f.spec.dOverD !== undefined ? { d_over_d: f.spec.dOverD } : {}),
            })),
          }
        : {}),
      ...(preset.frames ? { frames: framesOf(ins) } : {}),
      ...(energy ? { energy } : {}),
      goniometer: model.axes.length ? describeGoniometer(model) : "none: the sample is fixed",
      ...(singleCrystal ? { single_crystal: { shortest_d: (mono ? reachOf(tt, lambda0, lambda0) : reachOf(tt, exp.lambdaMin, exp.lambdaMax)).d_min, plan: preset.plan, see: "reciprocal_coverage for the fraction of reciprocal space the goniometer reaches" } } : {}),
      resolution: mono
        ? "Energy width from PyChop (energy.kinematics); Δd/d is at least ΔE/(2E) from the energy width alone."
        : banks.some((f) => f.spec.dOverD !== undefined)
          ? "Measured Δd/d per focused bank."
          : preset.frames
            ? "GSAS-II profiles per chopper frame (frames)."
            : "Not modelled: single-crystal peak positions only.",
      not_modelled: [...(INSTRUMENT_CAVEATS[preset.id] ?? []), ...sharedCaveats(ins)],
      ...(ins.notes.length ? { notes: ins.notes } : {}),
    };
  },
});

/** The free axis's rotation direction in the sample frame (one free axis): the axis seen through the axes inside it. */
function sampleAxis(model: GoniometerModel, k: number, base: readonly number[]): Vec3 {
  let inner = I3;
  model.axes.slice(k + 1).forEach((ax, j) => {
    inner = mulMat(inner, axisRotation(ax.direction, ax.sense * (ax.fixed ?? base[k + 1 + j] ?? 0)));
  });
  return mulVec(transpose(inner), model.axes[k]!.direction);
}

interface ReachResult {
  readonly shells: { d: [number, number]; q: [number, number]; fraction: number; max_out_of_plane_deg?: number; mean_recordings?: number }[];
  readonly volumeFraction: number;
  readonly method: string;
}

/**
 * The fraction of reciprocal space (sample frame) a set of settings, or the free axes over their whole ranges,
 * records in |q| shells from 1/dMax to 1/dMin: evenly spread directions in each shell (Fibonacci lattice), each
 * point tested at every setting (white beam: the direction table; monochromatic: exact Bragg crossings over the
 * scanned range). The fraction does not depend on the crystal's orientation.
 */
function reach(ins: ResolvedInstrument, opts: { dMin: number; dMax: number; shells: number; directions: number; plan?: ReturnType<typeof resolvePlan>; maxSettings: number; base: readonly number[] }): ReachResult {
  const { model, exp, panels, shadows } = ins;
  const free = model.axes.flatMap((ax, i) => (ax.fixed === undefined ? [i] : []));
  if (!free.length) throw new ToolError(`${ins.preset.label} has no goniometer: the sample is fixed.`);
  const dirs = fibonacciSphere(opts.directions);
  const qLo = 1 / opts.dMax;
  const qHi = 1 / opts.dMin;
  const edges = Array.from({ length: opts.shells + 1 }, (_, k) => qLo + ((qHi - qLo) * k) / opts.shells);
  const points: Vec3[] = [];
  for (let s = 0; s < opts.shells; s++) {
    const q = (edges[s]! + edges[s + 1]!) / 2;
    for (const u of dirs) points.push([q * u[0], q * u[1], q * u[2]]);
  }
  const mono = ins.preset.incident !== undefined;
  const plan = opts.plan;
  let counts: Uint16Array;
  let method: string;
  if (mono && (!plan || plan.kind === "scan")) {
    const k = plan?.kind === "scan" ? plan.axis : free[0]!;
    const ax = model.axes[k]!;
    const range = plan?.kind === "scan" ? { start: plan.scan.start - plan.scan.step / 2, end: plan.scan.end + plan.scan.step / 2 } : { start: ax.min, end: Math.min(ax.max, ax.min + 360) - 1e-9 };
    counts = new Uint16Array(points.length);
    for (const c of braggCrossings(model, k, plan?.base ?? opts.base, range, I3, points.map((h) => ({ h, family: 0 })), panels, (exp.lambdaMin + exp.lambdaMax) / 2, shadows)) if (c.hit) counts[c.index]!++;
    method = `exact Bragg crossings as ${axisName(ax.name)} turns from ${range.start.toFixed(1)}° to ${range.end.toFixed(1)}°`;
  } else {
    const grid = plan ? { settings: plan.settings, step: 0 } : candidateGrid(model, opts.base, opts.maxSettings);
    const table = directionTable(panels);
    counts = recordedCounts(model, grid.settings, points, table, exp.lambdaMin, exp.lambdaMax, shadows);
    method = plan ? `the plan's ${grid.settings.length} settings` : `${grid.settings.length} settings on a ${grid.step}° grid of ${free.map((i) => axisName(model.axes[i]!.name)).join(", ")} over their ranges`;
    method += `; detector directions tabulated at ${table.step}°`;
  }
  // With one free axis, how far from the plane perpendicular to it the reached q lie.
  const axis = free.length === 1 ? sampleAxis(model, free[0]!, plan?.base ?? opts.base) : undefined;
  const shells = Array.from({ length: opts.shells }, (_, s) => {
    let reached = 0;
    let sum = 0;
    let elev = 0;
    for (let i = s * dirs.length; i < (s + 1) * dirs.length; i++) {
      if (!counts[i]) continue;
      reached++;
      sum += counts[i]!;
      if (axis) elev = Math.max(elev, (Math.asin(Math.min(1, Math.abs(dirs[i - s * dirs.length]![0] * axis[0] + dirs[i - s * dirs.length]![1] * axis[1] + dirs[i - s * dirs.length]![2] * axis[2]))) * 180) / Math.PI);
    }
    return {
      d: [1 / edges[s]!, 1 / edges[s + 1]!] as [number, number],
      q: [TWO_PI * edges[s]!, TWO_PI * edges[s + 1]!] as [number, number],
      fraction: reached / dirs.length,
      ...(axis && reached ? { max_out_of_plane_deg: elev } : {}),
      ...(plan && reached ? { mean_recordings: sum / reached } : {}),
    };
  });
  const vol = (a: number, b: number) => b ** 3 - a ** 3;
  const volumeFraction = shells.reduce((acc, sh, s) => acc + sh.fraction * vol(edges[s]!, edges[s + 1]!), 0) / vol(qLo, qHi);
  return { shells, volumeFraction, method };
}

export const reciprocalCoverage = defineTool({
  name: "reciprocal_coverage",
  title: "How much of reciprocal space an instrument reaches",
  description:
    "The fraction of reciprocal space a single-crystal instrument records, in |Q| shells from d_max to d_min: with the free goniometer axes swept over their ranges (what the instrument could ever reach), or for a plan (an orientation list or a scan). Independent of the crystal and its orientation. " +
    "With one rotation axis (TOPAZ cryogenic, CORELLI, the chopper spectrometers' ψ) it also gives how far out of the plane perpendicular to that axis q is reached: the cone about the axis beyond that is never measured. Goniometer limits, masks and shadows set with configure_instrument apply.",
  input: z.strictObject({
    ...instrumentFields,
    ...planFields,
    d_min: z.number().positive().optional().describe(`Innermost shell edge, the shortest d (Å); default ${DEFAULT_D_MIN}.`),
    d_max: z.number().positive().optional().describe("Outermost shell edge, the longest d (Å); default 10."),
    shells: z.number().int().min(1).max(20).optional().describe("Number of |Q| shells (equal widths in |Q|); default 6."),
    directions: z.number().int().min(50).max(5000).optional().describe("Directions sampled per shell; default 600 (the fractions are good to about 1/√directions)."),
    full_range: z.boolean().optional().describe("Sweep the free axes over their ranges (default when no settings or scan are given) even if the instrument has a usual scan."),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run(args, { workspace }) {
    const ins = await resolveInstrument(args, workspace);
    const dMin = args.d_min ?? DEFAULT_D_MIN;
    const dMax = args.d_max ?? 10;
    if (!(dMax > dMin)) throw new ToolError("d_max must exceed d_min.");
    const usePlan = !args.full_range && (args.settings !== undefined || args.scan !== undefined);
    const plan = usePlan ? resolvePlan(ins, args) : undefined;
    const base = resolveAngles(ins.model, args.angles);
    const r = reach(ins, { dMin, dMax, shells: args.shells ?? 6, directions: args.directions ?? 600, ...(plan ? { plan } : {}), maxSettings: 4000, base });
    const tt = coveredOf(ins);
    return {
      instrument: ins.preset.label,
      beam: beamSummary(ins),
      measured: plan ? (plan.kind === "list" ? `orientation list of ${plan.settings.length}` : `scan of ${axisName(ins.model.axes[plan.axis]!.name)} ${plan.scan.start}–${plan.scan.end}° in ${plan.scan.step}° steps`) : "the free axes over their whole ranges",
      method: r.method,
      volume_fraction: r.volumeFraction,
      shells: r.shells,
      shortest_d_recordable: reachOf(tt, ins.exp.lambdaMin, ins.exp.lambdaMax).d_min,
      units: { d: "Å", q: "1/Å, with 2π" },
      ...(ins.notes.length ? { notes: ins.notes } : {}),
    };
  },
});

export const compareInstruments = defineTool({
  name: "compare_instruments",
  title: "Which instrument suits a measurement",
  description:
    "Checks every SNS instrument that takes the sample (powder or single crystal) against a measurement goal and says which suit it and why the others do not: the d range needed (and the Ei a chopper spectrometer needs to reach it), the resolution Δd/d needed or the line pairs to resolve (powder), the fraction of reciprocal space reached down to d_min and the wanted reflections recordable (single crystal). " +
    "Deterministic, from the instrument data the other tools use; flux and counting time are not compared.",
  input: z.strictObject({
    sample: z.enum(["powder", "single-crystal"]),
    d_min: z.number().positive().optional().describe(`Shortest d needed (Å); default ${DEFAULT_D_MIN}.`),
    d_max: z.number().positive().optional().describe("Longest d needed (Å)."),
    resolution: z.number().positive().max(0.5).optional().describe("Powder: the relative width Δd/d (FWHM) needed."),
    structure_id: structureId.optional().describe("For resolve_pairs and wanted."),
    resolve_pairs: z.array(z.array(hklField).length(2)).optional().describe("Powder: pairs of reflections to separate (≥ 1 FWHM apart), e.g. [[[5,1,1],[4,4,0]]]."),
    wanted: z.array(hklField).optional().describe("Single crystal: reflections to record (needs structure_id; an orientation makes the check specific to that mount)."),
    orientation: orientationField,
    ei_mev: z.number().positive().optional().describe("Chopper spectrometers: the incident energy to judge them at; default the lowest Ei in their range that reaches d_min."),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run(args, ctx) {
    const dMin = args.d_min ?? DEFAULT_D_MIN;
    const dMax = args.d_max;
    if (dMax !== undefined && !(dMax > dMin)) throw new ToolError("d_max must exceed d_min.");
    if ((args.resolve_pairs || args.wanted) && !args.structure_id) throw new ToolError("resolve_pairs and wanted need structure_id.");
    if (args.sample === "powder" && (args.wanted || args.orientation)) throw new ToolError("wanted and orientation are for single crystals.");
    if (args.sample === "single-crystal" && (args.resolve_pairs || args.resolution !== undefined)) throw new ToolError("resolution and resolve_pairs are for powders: single-crystal peak widths are not modelled.");
    const calc = args.structure_id ? await ctx.workspace.calculate(args.structure_id, { radiation: "neutron", wavelength: DEFAULT_WAVELENGTH, dMin }) : undefined;
    const pairs = (args.resolve_pairs ?? []).map(([a, b]) => {
      const d = (h: readonly number[]) => dSpacing(calc!.structure.cell, h[0]!, h[1]!, h[2]!);
      const d1 = d(a!);
      const d2 = d(b!);
      return { label: `(${hklText(a!)})/(${hklText(b!)})`, d: (d1 + d2) / 2, sep: Math.abs(d1 - d2) / ((d1 + d2) / 2) };
    });

    const rows = [];
    for (const entry of SNS_CATALOG.filter((i) => i.modes?.includes(args.sample))) {
      const reasons: string[] = [];
      const met: Record<string, boolean | null> = {};
      let ei: number | undefined;
      if (entry.incident) {
        const preset = SNS_INSTRUMENTS.find((i) => i.id === entry.id)!;
        const tt = coveredTwoTheta(preset.detectors!.map(panelAngles));
        const sMax = Math.sin((tt.at(-1)![1] * Math.PI) / 360);
        const eiNeeded = neutronEnergyMeV(2 * dMin * sMax);
        // Rounded up to 0.01 meV so that it still reaches d_min.
        ei = args.ei_mev ?? Math.min(entry.incident.eiMax, Math.max(entry.incident.eiMin, Math.ceil(eiNeeded * 100) / 100));
        if (eiNeeded > entry.incident.eiMax) reasons.push(`Reaching d = ${dMin} Å needs Ei ≥ ${eiNeeded.toPrecision(3)} meV, above its ${entry.incident.eiMax} meV maximum.`);
        else if (args.ei_mev !== undefined && args.ei_mev < eiNeeded) reasons.push(`At Ei = ${args.ei_mev} meV it reaches only down to d = ${(neutronWavelengthA(args.ei_mev) / (2 * sMax)).toPrecision(3)} Å; d = ${dMin} Å needs Ei ≥ ${eiNeeded.toPrecision(3)} meV.`);
      }
      const ins = await resolveInstrument({ instrument: entry.id, ...(ei !== undefined ? { ei_mev: ei } : {}) }, ctx.workspace);
      const tt = coveredOf(ins);
      const lambda0 = (ins.exp.lambdaMin + ins.exp.lambdaMax) / 2;
      const r = entry.incident ? reachOf(tt, lambda0, lambda0) : reachOf(tt, ins.exp.lambdaMin, ins.exp.lambdaMax);
      const row: Record<string, unknown> = { instrument: entry.id, label: entry.label, ...(ei !== undefined ? { ei_mev: ins.exp.eiMeV } : {}), d_reach: [r.d_min, r.d_max] };

      if (args.sample === "powder") {
        // What records each d, and how sharply: NOMAD banks, POWGEN frames, or a chopper spectrometer's elastic line.
        const banks = focusedBanksOf(ins);
        const frames = ins.preset.frames?.list ?? [];
        const difc = banks[0]?.bank.difc ?? 0;
        const covers = (d: number) =>
          entry.id === "powgen" ? frames.some((f) => d >= f.dMin && d <= f.dMax) : banks.length ? banks.some((f) => d >= f.bank.dMin && d <= f.bank.dMax) : d >= r.d_min && d <= r.d_max;
        const best = (d: number): { rel: number; where: string } | undefined => {
          if (entry.incident) return { rel: ins.exp.eRes / 2, where: `energy width alone, ΔE/E = ${ins.exp.eRes.toPrecision(3)} (a lower bound)` };
          if (entry.id === "powgen")
            return frames
              .filter((f) => f.profile && d >= f.dMin && d <= f.dMax)
              .map((f) => ({ rel: fwhmInD(frameShape(f.profile!), difc, d) / d, where: `${f.centre} Å frame` }))
              .reduce<{ rel: number; where: string } | undefined>((b, o) => (!b || o.rel < b.rel ? o : b), undefined);
          return banks
            .filter((f) => f.spec.dOverD !== undefined && d >= f.bank.dMin && d <= f.bank.dMax)
            .map((f) => ({ rel: f.spec.dOverD!, where: f.spec.name }))
            .reduce<{ rel: number; where: string } | undefined>((b, o) => (!b || o.rel < b.rel ? o : b), undefined);
        };
        met.d_min = covers(dMin);
        if (!met.d_min && !reasons.some((x) => x.startsWith("Reaching"))) reasons.push(`Does not record d = ${dMin} Å (it reaches ${r.d_min.toPrecision(3)}–${r.d_max.toPrecision(3)} Å).`);
        if (dMax !== undefined) {
          met.d_max = covers(dMax);
          if (!met.d_max) reasons.push(`Does not record d = ${dMax} Å.`);
          if (entry.id === "powgen" && met.d_min && met.d_max && !frames.some((f) => dMin >= f.dMin && dMax <= f.dMax)) reasons.push(`No single frame records ${dMin}–${dMax} Å: it takes several frames (${frames.filter((f) => f.dMin <= dMax && f.dMax >= dMin).map((f) => `${f.centre} Å`).join(", ")}).`);
        }
        const atD = [dMin, ...(dMax !== undefined ? [dMax] : [])].map((d) => ({ d, ...best(d) }));
        row.resolution = atD.map((x) => ("rel" in x && x.rel !== undefined ? { d: x.d, d_over_d: x.rel, from: x.where } : { d: x.d, d_over_d: null, from: "no published width here" }));
        if (args.resolution !== undefined) {
          const worst = atD.map((x) => ("rel" in x ? x.rel : undefined));
          met.resolution = worst.some((v) => v !== undefined && v > args.resolution!) ? false : worst.some((v) => v === undefined) || entry.incident ? null : true;
          if (met.resolution === false) reasons.push(`Its best Δd/d (${worst.map((v) => (100 * v!).toFixed(2)).join(", ")} %) is coarser than the ${(100 * args.resolution).toFixed(2)} % needed.`);
          if (met.resolution === null) reasons.push(entry.incident ? "Only a lower bound on Δd/d is known (from the energy width): the resolution cannot be confirmed." : "No published width at some of the d needed.");
        }
        if (pairs.length) {
          row.pairs = pairs.map((p) => {
            const b = best(p.d);
            const ok = b ? (entry.incident ? (p.sep < b.rel ? false : null) : p.sep >= b.rel) : null;
            return { pair: p.label, separation_percent: 100 * p.sep, fwhm_percent: b ? 100 * b.rel : null, resolved: ok, ...(b ? { by: b.where } : {}) };
          });
          const unresolved = (row.pairs as { resolved: boolean | null }[]).filter((p) => p.resolved === false).length;
          met.pairs = unresolved === 0 && !(row.pairs as { resolved: boolean | null }[]).some((p) => p.resolved === null) ? true : unresolved ? false : null;
          if (unresolved) reasons.push(`${unresolved} of ${pairs.length} line pairs closer than one FWHM.`);
        }
      } else {
        // Single crystal: the reach down to d_min, and the wanted reflections.
        met.d_min = r.d_min <= dMin + 1e-9;
        if (!met.d_min && !reasons.length) reasons.push(`Records d down to ${r.d_min.toPrecision(3)} Å only.`);
        const cov = reach(ins, { dMin, dMax: dMax ?? 10, shells: 3, directions: 300, maxSettings: 1500, base: ins.exp.angles });
        row.reciprocal_space_reached = { down_to_d_min: cov.volumeFraction, innermost_shell: cov.shells.at(-1)!.fraction, ...(cov.shells.at(-1)!.max_out_of_plane_deg !== undefined ? { max_out_of_plane_deg: cov.shells.at(-1)!.max_out_of_plane_deg } : {}) };
        if (args.wanted?.length && calc) {
          const o = await resolveOrientation(calc, args.orientation);
          const { model, panels, exp, shadows } = ins;
          const free = model.axes.flatMap((ax, i) => (ax.fixed === undefined ? [i] : []));
          const recordable = args.wanted.filter((h) => {
            const hs = [h as unknown as Vec3];
            if (ins.preset.incident) {
              const ax = model.axes[free[0]!]!;
              return braggCrossings(model, free[0]!, exp.angles, { start: ax.min, end: Math.min(ax.max, ax.min + 360) - 1e-9 }, o.UB, hs.map((x) => ({ h: x, family: 0 })), panels, (exp.lambdaMin + exp.lambdaMax) / 2, shadows).some((c) => c.hit);
            }
            return reflectionCoverage(model, exp.angles, o.UB, hs.map((x) => ({ h: x })), panels, exp.lambdaMin, exp.lambdaMax, free.length > 1 ? 4 : 1, undefined, shadows).points.length > 0;
          });
          row.wanted = { recordable: recordable.length, of: args.wanted.length, missed: args.wanted.filter((h) => !recordable.includes(h)).map((h) => `(${hklText(h)})`), orientation: o.description };
          met.wanted = recordable.length === args.wanted.length;
          if (!met.wanted) reasons.push(`${args.wanted.length - recordable.length} wanted reflection(s) never reach a detector with this orientation and goniometer.`);
        }
      }
      const values = Object.values(met);
      row.verdict = values.every((v) => v === true) ? "suitable" : values.some((v) => v === false) && met.d_min === false ? "unsuitable" : values.some((v) => v === false) ? "partly" : "check";
      row.checks = met;
      if (reasons.length) row.reasons = reasons;
      rows.push(row);
    }
    const order = { suitable: 0, check: 1, partly: 2, unsuitable: 3 } as Record<string, number>;
    rows.sort((a, b) => order[a.verdict as string]! - order[b.verdict as string]!);
    return {
      goal: { sample: args.sample, d_min: dMin, ...(dMax !== undefined ? { d_max: dMax } : {}), ...(args.resolution !== undefined ? { resolution: args.resolution } : {}) },
      instruments: rows,
      verdicts: "suitable: meets every check; check: no check failed but one could not be decided (no published width); partly: some checks fail; unsuitable: it cannot reach d_min.",
      not_compared: "Flux, counting time, background, sample environment and availability: ask the instrument team.",
    };
  },
});
