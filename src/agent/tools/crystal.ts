/**
 * Single crystals on TOPAZ, CORELLI and the chopper spectrometers: what the detectors record at a setting, a setting
 * for one reflection, a plan's completeness, suggested settings (TOPAZ's planner) and the binning a plan fills.
 */
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { mulMat, mulVec } from "@materia/core/math/mat3";
import { z } from "zod";
import type { CalcSuccess } from "../../app/compute.ts";
import { tofFromWavelength } from "../../core/diffraction/tof.ts";
import { blockedAt } from "../../core/instrument/acceptance.ts";
import { DGS_DEFAULT_ENERGY, energyBinning, mdnormBinning, Q_STEPS, suggestBinning } from "../../core/instrument/binning.ts";
import { rayHit } from "../../core/instrument/detectors.ts";
import { panelSamples, type Beam } from "../../core/instrument/hklRange.ts";
import { DEFAULT_PLACEMENT, familyCounts, suggestSettings, wantedStatus, type PlanGoal } from "../../core/instrument/plan.ts";
import { braggCrossings, crossingsToScan, reflectionCoverage, scanSettings, simulateSettings, type ScanResult } from "../../core/instrument/simulate.ts";
import { goniometerMatrix, laueCondition } from "../../core/ub/goniometer.ts";
import { planeGeometry } from "../../core/ub/mount.ts";
import { dgsOf } from "../../ui/experimentState.ts";
import { hklText } from "../../ui/format.ts";
import { hklMiss, presentReflections, PRESENT_CAP } from "../../ui/ubShared.ts";
import { angleWarnings, axisIndex, axisName, beamSummary, describeGoniometer, dMinNote, resolveAngles, resolveInstrument, type ResolvedInstrument } from "../instrument.ts";
import { resolveOrientation, type ResolvedOrientation } from "../orientation.ts";
import { anglesField, dMinField, hklField, instrumentFields, limitField, orientationField, outputPath, planFields, structureId, vec3, writeText, type InstrumentArgs } from "../shared.ts";
import { defineTool, ToolError, type ToolContext } from "../tool.ts";
import { DEFAULT_D_MIN, DEFAULT_WAVELENGTH } from "../workspace.ts";

export const crystalFields = { structure_id: structureId, d_min: dMinField, orientation: orientationField, ...instrumentFields };

type Points = ReturnType<typeof presentReflections>;

export interface CrystalSetup {
  readonly ins: ResolvedInstrument;
  readonly r: CalcSuccess;
  readonly o: ResolvedOrientation;
  /** The strongest present reflections (up to PRESENT_CAP), with their symmetry families: what the pages simulate. */
  readonly points: Points;
  readonly mono: boolean;
}

/** Instrument, calculation, orientation and reflections for a single-crystal tool. */
export async function crystalSetup(ctx: ToolContext, args: InstrumentArgs & { structure_id: string; d_min?: number | undefined; orientation?: Parameters<typeof resolveOrientation>[1] }): Promise<CrystalSetup> {
  const ins = await resolveInstrument(args, ctx.workspace);
  if (!ins.preset.modes?.includes("single-crystal") || !ins.model.axes.some((ax) => ax.fixed === undefined))
    throw new ToolError(`${ins.preset.label} has no goniometer to turn a crystal; the single-crystal tools take topaz-cryo, topaz-ambient, corelli, arcs, sequoia or cncs.`);
  const r = await ctx.workspace.calculate(args.structure_id, { radiation: "neutron", wavelength: DEFAULT_WAVELENGTH, dMin: args.d_min ?? DEFAULT_D_MIN });
  const o = await resolveOrientation(r, args.orientation);
  return { ins, r, o, points: presentReflections(r), mono: ins.preset.incident !== undefined };
}

/** What every single-crystal result states: instrument, beam, orientation, the reflections simulated, and notes. */
export function context(s: CrystalSetup, extraNotes: readonly string[] = []) {
  const present = s.r.reflections.cls.reduce((n, c) => n + (c === 0 ? 1 : 0), 0);
  const note = dMinNote(s.ins, s.r.provenance.dMin);
  const notes = [...s.ins.notes, ...s.o.warnings, ...(note ? [note] : []), ...extraNotes];
  return {
    instrument: s.ins.preset.label,
    beam: beamSummary(s.ins),
    orientation: s.o.description,
    reflections: `${s.points.length}${present > s.points.length ? ` strongest of ${present}` : ""} present reflections down to d_min = ${s.r.provenance.dMin} Å`,
    ...(notes.length ? { notes } : {}),
  };
}

/** Indices as a vector (the schemas check the length). */
const v3 = (a: readonly number[]) => a as unknown as Vec3;

const sameHkl = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** A wanted reflection: its symmetry family among the simulated reflections, or the exact hkl when it is not listed (as the Single-crystal page). */
function wantedTargets(s: CrystalSetup, wanted: readonly (readonly number[])[]) {
  return wanted.map((h, k) => {
    const i = s.points.findIndex((p) => sameHkl(p.h, h));
    const d = 1 / Math.hypot(...mulVec(s.o.UB, h as Vec3));
    if (i < 0) return { h: h as Vec3, d, family: -(k + 1), members: [h as Vec3], note: hklMiss(s.r, h.join(" "), PRESENT_CAP).message };
    const family = s.points[i]!.family;
    return { h: h as Vec3, d, family, members: s.points.filter((p) => p.family === family).map((p) => p.h as Vec3), note: undefined };
  });
}

/** Where one hkl lands at a setting, or why it is not recorded. */
function landing(s: CrystalSetup, R: Mat3, angles: readonly number[], h: readonly number[]) {
  const { exp } = s.ins;
  const l = laueCondition(mulVec(mulMat(R, s.o.UB), h as Vec3));
  if (!Number.isFinite(l.lambda)) return { recorded: false, reason: "q points upstream (q_z ≥ 0) at this setting: it cannot diffract here." };
  const at = { lambda: l.lambda, two_theta: l.twoTheta, azimuth: l.azimuth };
  if (!(l.lambda >= exp.lambdaMin && l.lambda <= exp.lambdaMax)) return { recorded: false, ...at, reason: `It diffracts at λ = ${l.lambda.toFixed(4)} Å, outside the band ${exp.lambdaMin.toPrecision(4)}–${exp.lambdaMax.toPrecision(4)} Å.` };
  const hit = rayHit(s.ins.panels, l.kf, blockedAt(s.ins.shadows, angles));
  if (!hit) return { recorded: false, ...at, reason: "Its k_f lands on no recording pixel (a gap between panels, a masked pixel or a sample-environment shadow)." };
  return { recorded: true, ...at, panel: hit.name, col: hit.col, row: hit.row, tof: tofFromWavelength(s.ins.l1 + hit.l2, l.lambda) };
}

export const simulateSetting = defineTool({
  name: "simulate_setting",
  title: "Reflections on the detectors at one setting",
  description:
    "The reflections a single crystal puts on the detectors at one goniometer setting: for each, the Laue wavelength (white beam: λ = −2q_z/|q|², in the band; chopper spectrometers: at Ei within the elastic width), 2θ, azimuth, panel, pixel and time of flight, strongest first. " +
    "Optionally checks given hkl (forbidden or weak ones too) and says where they land or why they are missed. Simulates the strongest present reflections (up to 6000) down to d_min. Goniometer limits, masks and shadows set with configure_instrument apply.",
  input: z.strictObject({
    ...crystalFields,
    angles: anglesField,
    hkl: z.array(hklField).optional().describe("Reflections to check at this setting (any hkl, including absent ones)."),
    limit: limitField(40, 2000),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run(args, ctx) {
    const s = await crystalSetup(ctx, args);
    const { exp, model, panels } = s.ins;
    const angles = resolveAngles(model, args.angles);
    const R = goniometerMatrix(model, angles);
    const RUB = mulMat(R, s.o.UB);
    const blocked = blockedAt(s.ins.shadows, angles);
    let inBand = 0;
    const obs: { i: number; lambda: number; twoTheta: number; azimuth: number; hit: NonNullable<ReturnType<typeof rayHit>> }[] = [];
    s.points.forEach((p, i) => {
      const l = laueCondition(mulVec(RUB, p.h));
      if (!(l.lambda >= exp.lambdaMin && l.lambda <= exp.lambdaMax)) return;
      inBand++;
      const hit = rayHit(panels, l.kf, blocked);
      if (hit) obs.push({ i, lambda: l.lambda, twoTheta: l.twoTheta, azimuth: l.azimuth, hit });
    });
    const limit = args.limit ?? 40;
    const plane = args.orientation?.u && args.orientation.v && !s.o.fileUB ? planeGeometry(s.o.UB, R, { u: args.orientation.u as unknown as Vec3, v: args.orientation.v as unknown as Vec3 }) : undefined;
    return {
      ...context(s, angleWarnings(model, angles)),
      angles: Object.fromEntries(model.axes.map((ax, i) => [axisName(ax.name), angles[i]])),
      ...(plane ? { scattering_plane: { tilt_from_horizontal_deg: plane.tiltDeg, beam_angle_to_plane_deg: plane.beamDeg, normal_lab: plane.normal } } : {}),
      in_band: inBand,
      on_detectors: obs.length,
      observed: obs.slice(0, limit).map((o) => {
        const p = s.points[o.i]!;
        return { hkl: p.h, d: p.d, f2: p.f2, lambda: o.lambda, two_theta: o.twoTheta, azimuth: o.azimuth, panel: o.hit.name, col: o.hit.col, row: o.hit.row, tof: tofFromWavelength(s.ins.l1 + o.hit.l2, o.lambda) };
      }),
      ...(args.hkl?.length ? { checked: args.hkl.map((h) => ({ hkl: h, ...landing(s, R, angles, h) })) } : {}),
      units: { lambda: "Å", two_theta: "deg (from the beam)", azimuth: "deg about the beam from +x towards +y (up)", tof: "µs", col_row: "pixel, from 1", f2: "fm²" },
    };
  },
});

export const findSetting = defineTool({
  name: "find_setting",
  title: "Find a goniometer setting for a reflection",
  description:
    "Goniometer angles that bring one reflection onto a detector near the middle of a panel at a mid-band wavelength, searching the free axes over their ranges (a 1° grid for one free axis, 2° for two; chopper spectrometers solve the Bragg crossings exactly). The other axes stay at `angles`. " +
    "Returns the best setting, the best on each of a few other panels, and how much of the goniometer range records the reflection at all, or why nothing can (e.g. d < λmin/2).",
  input: z.strictObject({
    ...crystalFields,
    hkl: hklField,
    angles: anglesField.describe("Starting angles: axes not searched (fixed, or held) keep these values (deg)."),
    equivalents: z.boolean().optional().describe("Also accept the reflection's symmetry equivalents (default false: this exact hkl)."),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run(args, ctx) {
    const s = await crystalSetup(ctx, args);
    const { exp, model, panels } = s.ins;
    const base = resolveAngles(model, args.angles);
    const lambdaMid = (exp.lambdaMin + exp.lambdaMax) / 2;
    const free = model.axes.flatMap((ax, i) => (ax.fixed === undefined ? [i] : []));
    const hs: Vec3[] = args.equivalents ? wantedTargets(s, [args.hkl])[0]!.members : [v3(args.hkl)];
    type Hit = { angles: number[]; lambda: number; panel: string; col: number; row: number; score: number; hkl: Vec3 };
    const hits: Hit[] = [];
    const consider = (angles: readonly number[], lambda: number, hit: { col: number; row: number; panel: number; name: string }, h: Vec3) => {
      const p = panels[hit.panel]!;
      const off = Math.hypot((hit.col - 0.5) / p.nCols - 0.5, (hit.row - 0.5) / p.nRows - 0.5);
      hits.push({ angles: angles.map((v) => Number(v.toFixed(2))), lambda, panel: hit.name, col: hit.col, row: hit.row, score: Math.abs(lambda - lambdaMid) / (exp.lambdaMax - exp.lambdaMin || 1) + off, hkl: h });
    };
    let settings = 0;
    let step = 0;
    if (s.mono) {
      const k = free[0]!;
      const ax = model.axes[k]!;
      for (const c of braggCrossings(model, k, base, { start: ax.min, end: Math.min(ax.max, ax.min + 360) - 1e-9 }, s.o.UB, hs.map((h) => ({ h, family: 0 })), panels, lambdaMid, s.ins.shadows))
        if (c.hit) consider(base.map((v, i) => (i === k ? c.angle : v)), lambdaMid, c.hit, hs[c.index]!);
    } else {
      const cov = reflectionCoverage(model, base, s.o.UB, hs.map((h) => ({ h })), panels, exp.lambdaMin, exp.lambdaMax, free.length > 1 ? 2 : 1, undefined, s.ins.shadows);
      settings = cov.settings;
      step = cov.step;
      for (const p of cov.points) consider(p.angles, p.lambda, p.hit, hs[p.index]!);
    }
    const d = 1 / Math.hypot(...mulVec(s.o.UB, v3(args.hkl)));
    if (!hits.length)
      return {
        ...context(s),
        hkl: args.hkl,
        d,
        found: false,
        message: `(${hklText(args.hkl)})${args.equivalents ? " and its equivalents" : ""} cannot be recorded with this goniometer and band${d < exp.lambdaMin / 2 ? `: d = ${d.toFixed(4)} Å is below λmin/2 = ${(exp.lambdaMin / 2).toFixed(4)} Å` : ""}.`,
      };
    hits.sort((a, b) => a.score - b.score);
    const perPanel = new Map<string, Hit>();
    for (const h of hits) if (!perPanel.has(h.panel)) perPanel.set(h.panel, h);
    const row = (h: Hit) => ({ angles: Object.fromEntries(model.axes.map((ax, i) => [axisName(ax.name), h.angles[i]])), hkl: h.hkl, panel: h.panel, col: h.col, row: h.row, lambda: h.lambda, score: h.score });
    const recordingSettings = new Set(hits.map((h) => h.angles.join(","))).size;
    return {
      ...context(s),
      hkl: args.hkl,
      d,
      found: true,
      best: row(hits[0]!),
      other_panels: [...perPanel.values()].slice(1, 6).map(row),
      reach: s.mono
        ? { crossings_on_detectors: hits.length, panels: perPanel.size }
        : { settings_recording: recordingSettings, settings_searched: settings, grid_step_deg: step, panels: perPanel.size },
      score: "|λ − mid band|/band width + offset of the pixel from the panel centre (fraction of the panel); lower is better",
    };
  },
});

/** The plan: an orientation list, or a scan of one free axis (the instrument's usual one when none is given). */
export function resolvePlan(ins: ResolvedInstrument, args: { angles?: z.infer<typeof anglesField>; settings?: z.infer<typeof planFields.settings>; scan?: z.infer<typeof planFields.scan> }) {
  const { model, preset } = ins;
  const mono = preset.incident !== undefined;
  if (args.settings && args.scan) throw new ToolError("Give an orientation list (settings) or a scan, not both.");
  const base = resolveAngles(model, args.angles);
  if (args.settings) {
    if (!args.settings.length) throw new ToolError("settings is empty.");
    return { kind: "list" as const, base, settings: args.settings.map((a) => resolveAngles(model, a)) };
  }
  const free = model.axes.flatMap((ax, i) => (ax.fixed === undefined ? [i] : []));
  const usual = preset.plan?.kind === "scan" ? preset.plan : undefined;
  if (!args.scan && !usual) throw new ToolError(`${preset.label} is planned as an orientation list: give settings (suggest_settings proposes them), or a scan.`);
  const axis = args.scan?.axis !== undefined ? axisIndex(model, args.scan.axis) : free[0]!;
  if (model.axes[axis]!.fixed !== undefined) throw new ToolError(`${axisName(model.axes[axis]!.name)} is fixed on ${preset.label}; scan a free axis.`);
  const scan = { start: args.scan?.start ?? usual!.start, end: args.scan?.end ?? usual!.end, step: args.scan?.step ?? usual!.step, interleave: args.scan?.interleave ?? false };
  if (!(scan.end >= scan.start)) throw new ToolError("A scan needs end ≥ start.");
  return { kind: "scan" as const, base, axis, scan, settings: scanSettings(axis, base, scan, scan.interleave && !mono) };
}

export type Plan = ReturnType<typeof resolvePlan>;

/** What the plan records (as the Single-crystal page): per step, reflections on the detectors and cumulative completeness. */
function runPlan(s: CrystalSetup, plan: Plan): ScanResult {
  const { exp, model, panels, shadows } = s.ins;
  const refl = s.points.map((p) => ({ h: p.h as Vec3, family: p.family }));
  if (plan.kind === "scan" && s.mono) {
    // Monochromatic: exact Bragg crossings, each counted in the nearest step.
    const half = plan.scan.step / 2;
    const crossings = braggCrossings(model, plan.axis, plan.base, { start: plan.scan.start - half, end: plan.scan.end + half }, s.o.UB, refl, panels, (exp.lambdaMin + exp.lambdaMax) / 2, shadows);
    return crossingsToScan(crossings, refl, plan.axis, plan.base, plan.scan);
  }
  return simulateSettings(model, plan.settings, s.o.UB, refl, panels, exp.lambdaMin, exp.lambdaMax, shadows);
}

const anglesObject = (s: CrystalSetup, a: readonly number[]) => Object.fromEntries(s.ins.model.axes.map((ax, i) => [axisName(ax.name), Number(a[i]!.toFixed(3))]));

export const simulatePlan = defineTool({
  name: "simulate_plan",
  title: "Simulate a measurement plan",
  description:
    "What a single-crystal measurement plan records: an orientation list (TOPAZ: about ten settings) or a rotation scan (CORELLI: 0–357° in 3° steps; chopper spectrometers: ψ, with the Bragg crossings solved exactly). For each setting or step, the reflections on the detectors and the cumulative completeness (fraction of symmetry families recorded); the step where 90 % is reached; families recorded twice or more (redundancy); and, for wanted reflections, how many settings record them and place them well (mid band, away from panel edges). " +
    "Without settings or scan, the instrument's usual scan. Optionally writes the plan as CSV.",
  input: z.strictObject({
    ...crystalFields,
    ...planFields,
    wanted: z.array(hklField).optional().describe("Reflections the measurement is for: any symmetry equivalent recorded counts."),
    placement: z
      .strictObject({ band_fraction: z.number().gt(0).max(1).optional(), edge_fraction: z.number().min(0).lt(0.5).optional() })
      .optional()
      .describe("Well placed: λ within band_fraction of the half band about mid band (default 0.5) and the hit at least edge_fraction of the panel from its edges (default 0.1)."),
    output_path: outputPath.describe("Write the plan (settings, reflections recorded, cumulative completeness, wanted reflections) as CSV; overwritten if it exists."),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  async run(args, ctx) {
    const s = await crystalSetup(ctx, args);
    const plan = resolvePlan(s.ins, args);
    const res = runPlan(s, plan);
    const { model, panels, exp, shadows } = s.ins;
    const last = res.steps.at(-1)?.completeness ?? 0;
    const reach90 = res.steps.findIndex((st) => st.completeness >= 0.9);
    const refl = s.points.map((p) => ({ h: p.h as Vec3, family: p.family }));
    const twice = !s.mono || plan.kind === "list" ? [...familyCounts(model, plan.settings, s.o.UB, refl, panels, exp.lambdaMin, exp.lambdaMax, shadows).values()].filter((c) => c >= 2).length : undefined;
    const placement = { bandFraction: args.placement?.band_fraction ?? DEFAULT_PLACEMENT.bandFraction, edgeFraction: args.placement?.edge_fraction ?? DEFAULT_PLACEMENT.edgeFraction };
    const targets = wantedTargets(s, args.wanted ?? []);
    let wanted: object[] = [];
    if (targets.length) {
      if (s.mono && plan.kind === "scan") {
        const half = plan.scan.step / 2;
        wanted = targets.map((t) => {
          const hits = braggCrossings(model, plan.axis, plan.base, { start: plan.scan.start - half, end: plan.scan.end + half }, s.o.UB, t.members.map((h) => ({ h, family: 0 })), panels, (exp.lambdaMin + exp.lambdaMax) / 2, shadows).filter((c) => c.hit);
          return { hkl: t.h, d: t.d, crossings_on_detectors: hits.length, at_angles: hits.slice(0, 8).map((c) => Number(c.angle.toFixed(2))), ...(t.note ? { note: t.note } : {}) };
        });
      } else {
        const seen = wantedStatus(model, plan.settings, s.o.UB, targets.map((t) => t.members), panels, exp.lambdaMin, exp.lambdaMax, placement, shadows);
        wanted = targets.map((t, k) => ({ hkl: t.h, d: t.d, equivalents: t.members.length, settings_recording: seen[k]!.recorded, settings_well_placed: seen[k]!.well, ...(t.d < exp.lambdaMin / 2 ? { unreachable: `d < λmin/2 = ${(exp.lambdaMin / 2).toFixed(4)} Å` } : {}), ...(t.note ? { note: t.note } : {}) }));
      }
    }
    const every = Math.max(1, Math.ceil(res.steps.length / 60));
    const steps = res.steps.map((st, k) => ({ step: k + 1, angles: anglesObject(s, st.angles), observed: st.observed, completeness: st.completeness })).filter((_, k) => k % every === 0 || k === res.steps.length - 1 || k === reach90);

    let written: string | undefined;
    if (args.output_path) {
      const axes = model.axes;
      const lines = [
        `# NEXPLAN measurement plan (${plan.kind === "list" ? "orientation list" : "rotation scan"}); ${s.ins.preset.label}`,
        `# structure ${s.r.structure.name || s.r.blockName} (data_${s.r.blockName}), input sha256 ${s.r.provenance.inputSha256}; d_min ${s.r.provenance.dMin} A`,
        `# orientation: ${s.o.description}; lambda band ${exp.lambdaMin.toPrecision(4)}-${exp.lambdaMax.toPrecision(4)} A`,
        `# goniometer: ${axes.map((ax) => (ax.fixed !== undefined ? `${axisName(ax.name)} fixed at ${ax.fixed}` : `${axisName(ax.name)} ${ax.min} to ${ax.max} deg`)).join("; ")}`,
        "# a reflection is recorded when its Laue wavelength is in the band and k_f hits a panel; completeness over symmetry families",
        ["setting", ...axes.map((ax) => `${axisName(ax.name)}_deg`), "reflections_on_detectors", "families_cumulative", "completeness_pct"].join(","),
        ...res.steps.map((st, k) => [k + 1, ...axes.map((ax, i) => ax.fixed ?? st.angles[i] ?? 0), st.observed, Math.round(st.completeness * res.families), (100 * st.completeness).toFixed(2)].join(",")),
      ];
      if (targets.length && !(s.mono && plan.kind === "scan")) {
        lines.push(`# wanted reflections; well placed = lambda in the inner ${Math.round(placement.bandFraction * 100)} % of the band and at least ${Math.round(placement.edgeFraction * 100)} % of a panel from its edges`);
        lines.push("h,k,l,d_A,settings_recording,settings_well_placed");
        wanted.forEach((w) => {
          const x = w as { hkl: number[]; d: number; settings_recording: number; settings_well_placed: number };
          lines.push([...x.hkl, x.d.toFixed(4), x.settings_recording, x.settings_well_placed].join(","));
        });
      }
      written = await writeText(args.output_path, lines.join("\n") + "\n");
    }
    return {
      ...context(s, plan.settings.flatMap((a) => angleWarnings(model, a)).filter((w, i, all) => all.indexOf(w) === i).slice(0, 5)),
      plan: plan.kind === "list" ? { kind: "orientation list", settings: plan.settings.length } : { kind: "rotation scan", axis: axisName(model.axes[plan.axis]!.name), ...plan.scan, settings: plan.settings.length },
      families: res.families,
      families_recorded: res.observedFamilies,
      completeness: last,
      ...(reach90 >= 0 ? { completeness_90_at_step: reach90 + 1 } : {}),
      ...(twice !== undefined ? { families_recorded_twice_or_more: twice } : {}),
      reflections_recorded: res.measured.size,
      steps,
      ...(steps.length < res.steps.length ? { steps_note: `every ${every}th of ${res.steps.length} steps shown (and the last, and where 90 % is reached); output_path writes all` } : {}),
      ...(wanted.length ? { wanted } : {}),
      ...(written ? { written } : {}),
    };
  },
});

export const suggestSettingsTool = defineTool({
  name: "suggest_settings",
  title: "Suggest goniometer settings (TOPAZ planner)",
  description:
    "Proposes an orientation list as TOPAZ is planned: a greedy search over a grid of the free goniometer axes (within their limits) for the settings that record the wanted reflections first, then the most new symmetry families, then second and third recordings. " +
    "Goal 'coverage' (default): up to n settings; greedy gets at least 1 − 1/e of the best n grid settings for its first goal (Nemhauser, Wolsey & Fisher 1978). Goal 'fewest': as few settings as place every wanted reflection well (at most n), each fine-tuned off the grid to centre them; at most ln n + 1 times the fewest (greedy set cover). " +
    "Settings already measured (existing) count, so suggestions extend a list. A starting plan, not an optimum. Can take tens of seconds with two free axes (TOPAZ ambient).",
  input: z.strictObject({
    ...crystalFields,
    angles: anglesField.describe("Current angles; only the fixed axes' values matter."),
    wanted: z.array(hklField).optional().describe("Reflections the measurement is for (forbidden ones too); any symmetry equivalent counts."),
    n: z.number().int().min(1).max(60).optional().describe("Number of settings (goal coverage) or the most allowed (goal fewest); default 10."),
    goal: z.enum(["coverage", "fewest"]).optional().describe("coverage (default) or fewest."),
    existing: z.array(z.union([z.array(z.number()), z.record(z.string(), z.number())])).optional().describe("Settings already in the list (as `angles`): they count as measured."),
    placement: z
      .strictObject({ band_fraction: z.number().gt(0).max(1).optional(), edge_fraction: z.number().min(0).lt(0.5).optional() })
      .optional()
      .describe("Well placed: λ within band_fraction of the half band about mid band (default 0.5), and at least edge_fraction of a panel from its edges (default 0.1)."),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run(args, ctx) {
    const s = await crystalSetup(ctx, args);
    const { model, panels, exp, shadows } = s.ins;
    const targets = wantedTargets(s, args.wanted ?? []);
    const n = args.n ?? 10;
    const goal: PlanGoal = args.goal ?? "coverage";
    const existing = (args.existing ?? []).map((a) => resolveAngles(model, a));
    const placement = { bandFraction: args.placement?.band_fraction ?? DEFAULT_PLACEMENT.bandFraction, edgeFraction: args.placement?.edge_fraction ?? DEFAULT_PLACEMENT.edgeFraction };
    const res = suggestSettings({
      model,
      base: resolveAngles(model, args.angles),
      UB: s.o.UB,
      reflections: s.points.map((p) => ({ h: p.h as Vec3, family: p.family })),
      wanted: targets.map((t) => t.members),
      placement,
      existing,
      panels,
      ...(shadows ? { shadows: shadows.shapes } : {}),
      lambdaMin: exp.lambdaMin,
      lambdaMax: exp.lambdaMax,
      n,
      goal,
    });
    const settings = res.settings.map((a) => a.map((v) => Number(v.toFixed(2))));
    const free = model.axes.filter((ax) => ax.fixed === undefined).map((ax) => axisName(ax.name));
    const added = `${settings.length} setting${settings.length === 1 ? "" : "s"}`;
    const grid = `chosen from ${res.candidates} on a ${res.step}° grid of ${free.join(", ")}`;
    let summary: string;
    if (res.goal === "fewest") {
      const T = res.wantedTotal;
      const cannot = T - res.wellPossible;
      const limit = settings.length === n && (T ? res.wellAfter < res.wellPossible : res.familiesAfter < res.familiesReachable) ? ` Stopped at the limit of ${n}: raise n to place the rest.` : "";
      summary = T
        ? settings.length
          ? `Fewest settings: ${added} (${grid}), placing ${res.wellAfter} of ${T} wanted reflections well${cannot ? `; ${cannot} cannot be placed well with this goniometer, its limits and band` : ""}.${res.refined ? " Each setting is fine-tuned off the grid to put its wanted reflections nearest mid band and the panel centre." : ""}${limit}`
          : `Every wanted reflection that can be placed well already is (${res.wellAfter} of ${T}); nothing added.`
        : `Fewest settings recording every reachable family: ${added} (${grid}); ${res.familiesAfter} of ${res.familiesReachable} families.${limit}`;
    } else {
      const full = res.picks.findIndex((p) => p.wellPlaced === 0 && p.wanted === 0 && p.families === 0);
      summary = `${added}, ${grid}.${res.wantedTotal ? ` Wanted reflections: ${res.wellAfter} of ${res.wantedTotal} well placed, ${res.recordedAfter} recorded${res.recordedBefore ? ` (${res.wellBefore} and ${res.recordedBefore} before)` : ""}.` : ""}${full >= 0 ? ` Every reachable family is recorded after ${full}; the rest add second and third recordings.` : ""}${settings.length < n ? ` Stopped after ${settings.length}: more settings would add nothing.` : ""}`;
    }
    const forbidden = targets.filter((t) => t.note).map((t) => `(${hklText(t.h)}): ${t.note}`);
    return {
      ...context(s, forbidden),
      goniometer: describeGoniometer(model),
      goal: res.goal,
      summary,
      settings: settings.map((a, k) => ({ angles: anglesObject(s, a), ...(res.picks[k] ? { new_wanted_well_placed: res.picks[k]!.wellPlaced, new_wanted_recorded: res.picks[k]!.wanted, new_families: res.picks[k]!.families, second_recordings: res.picks[k]!.second, third_recordings: res.picks[k]!.third } : {}) })),
      settings_as_lists: settings,
      wanted: { total: res.wantedTotal, well_placed_before: res.wellBefore, well_placed_after: res.wellAfter, recorded_before: res.recordedBefore, recorded_after: res.recordedAfter, could_be_well_placed: res.wellPossible },
      families: { recorded_after: res.familiesAfter, reachable: res.familiesReachable, total: new Set(s.points.map((p) => p.family)).size },
      grid: { candidates: res.candidates, step_deg: res.step, refined_off_grid: res.refined },
      next: "simulate_plan with settings = existing + settings_as_lists shows completeness per setting.",
    };
  },
});

export const suggestBinningTool = defineTool({
  name: "suggest_binning",
  title: "HKL binning for Mantid MDNorm",
  description:
    "The reciprocal-space volume a plan records, as Mantid MDNorm binning: along each projection axis (rows of `axes`, r.l.u.), the range of h recorded down to d ≥ d_min (masks and shadows included) in bins of a round step (by default per axis the one giving 201–401 bins), centred on zero; a slab integrates one axis. " +
    "Chopper spectrometers add the energy-transfer axis in steps of 1 % of Ei (−0.5 Ei to 0.99 Ei by default, Mantid's default). Returns the MDNorm call for Mantid's default Q convention (indices mirrored) or the crystallographic one. Starting points: the best bin depends on the counts.",
  input: z.strictObject({
    ...crystalFields,
    ...planFields,
    axes: z.array(vec3).length(3).optional().describe("Projection axes as rows, in r.l.u. (default [[1,0,0],[0,1,0],[0,0,1]]); must be independent."),
    step: z.number().optional().describe(`One Q step (r.l.u.) for every axis, from ${Q_STEPS.join(", ")}; default per axis about 200–400 bins.`),
    bin_d_min: z.number().positive().optional().describe("Bin only d ≥ this (Å); default the calculation's d_min."),
    slab: z.strictObject({ axis: z.number().int().min(0).max(2), centre: z.number(), thickness: z.number().positive() }).optional().describe("Integrate this axis (0–2) over a slab instead of binning it, for a slice."),
    q_convention: z.enum(["inelastic", "crystallography"]).optional().describe("Mantid's Q.convention: inelastic (Mantid's default; limits mirrored, as it labels NEXPLAN's h as −h) or crystallography."),
    e_min: z.number().optional().describe("Chopper spectrometers: lowest energy transfer (meV); default −0.5 Ei."),
    e_max: z.number().optional().describe("Chopper spectrometers: highest energy transfer (meV); default 0.99 Ei."),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run(args, ctx) {
    const s = await crystalSetup(ctx, args);
    const plan = resolvePlan(s.ins, args);
    const { model, panels, exp, shadows } = s.ins;
    if (args.step !== undefined && !Q_STEPS.includes(args.step)) throw new ToolError(`step must be one of ${Q_STEPS.join(", ")} r.l.u.`);
    const rows = (args.axes ?? [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) as number[][];
    const W: Mat3 = [0, 1, 2].map((r) => [0, 1, 2].map((c) => rows[c]![r]!)) as unknown as Mat3;
    const det = W[0][0] * (W[1][1] * W[2][2] - W[1][2] * W[2][1]) - W[0][1] * (W[1][0] * W[2][2] - W[1][2] * W[2][0]) + W[0][2] * (W[1][0] * W[2][1] - W[1][1] * W[2][0]);
    if (Math.abs(det) < 1e-9) throw new ToolError("The three axes are coplanar: choose independent ones.");
    const dMin = args.bin_d_min ?? s.r.provenance.dMin;
    const ei = exp.eiMeV;
    const eMin = args.e_min ?? Number((DGS_DEFAULT_ENERGY.min * ei).toPrecision(4));
    const eMax = args.e_max ?? Number((DGS_DEFAULT_ENERGY.max * ei).toPrecision(4));
    if (!s.mono && (args.e_min !== undefined || args.e_max !== undefined)) throw new ToolError("e_min and e_max apply to the chopper spectrometers.");
    const beam: Beam = s.mono ? { kind: "direct", eiMeV: ei, eMin, eMax: Math.min(eMax, 0.999 * ei) } : { kind: "white", lambdaMin: exp.lambdaMin, lambdaMax: exp.lambdaMax };
    const bins = suggestBinning(plan.settings.map((a) => goniometerMatrix(model, a)), plan.settings.map((a) => blockedAt(shadows, a)), panelSamples(panels, 6), beam, s.o.UB, W, args.step, { qMax: 1 / dMin });
    if (!bins) return { ...context(s), message: "The plan records nothing with these masks, shadows and band." };
    const energy = s.mono ? energyBinning(ei, eMin, eMax) : undefined;
    const inelastic = (args.q_convention ?? "inelastic") === "inelastic";
    const slab = args.slab;
    const binning = (i: number) => mdnormBinning(bins.axes[i as 0 | 1 | 2], inelastic ? "inelastic" : "crystallography", slab?.axis === i ? slab : undefined);
    const total = bins.axes.reduce((n, a, i) => n * (slab?.axis === i ? 1 : a.bins), 1) * (energy?.bins ?? 1);
    const call = [
      `# NEXPLAN binning suggestion: ${s.ins.preset.label}, ${plan.settings.length} setting${plan.settings.length > 1 ? "s" : ""}, d >= ${dMin} A; ${args.step ? `step ${args.step}` : "auto steps (about 200-400 bins per axis)"}${energy ? ", dE step 1 % of Ei" : ""}`,
      inelastic ? `# For Q.convention = "Inelastic" (Mantid's default), which labels NEXPLAN's (h k l) as (-h -k -l): limits mirrored` : `# For Q.convention = "Crystallography": indices as NEXPLAN's (h k l)`,
      `MDNorm(InputWorkspace="data", ${s.mono ? 'SolidAngleWorkspace="sa"' : 'SolidAngleWorkspace="sa", FluxWorkspace="flux"'},`,
      `       QDimension0="${rows[0]!.join(",")}", QDimension1="${rows[1]!.join(",")}", QDimension2="${rows[2]!.join(",")}",`,
      ...bins.axes.map((_, i) => `       Dimension${i}Name="QDimension${i}", Dimension${i}Binning="${binning(i)}",`),
      ...(energy ? [`       Dimension3Name="DeltaE", Dimension3Binning="${energy.min},${energy.step},${energy.max}",`] : []),
      `       OutputWorkspace="result", OutputDataWorkspace="dataMD", OutputNormalizationWorkspace="normMD")`,
    ].join("\n");
    return {
      ...context(s),
      plan: plan.kind === "list" ? `orientation list of ${plan.settings.length}` : `scan of ${axisName(model.axes[plan.axis]!.name)} ${plan.scan.start}–${plan.scan.end}° in ${plan.scan.step}° steps`,
      q_convention: inelastic ? "inelastic (Mantid's default): limits mirrored" : "crystallography",
      axes: bins.axes.map((a, i) => ({ axis: rows[i], recorded: [bins.extent.min[i], bins.extent.max[i]], min: a.min, max: a.max, step: a.step, bins: slab?.axis === i ? 1 : a.bins, mdnorm_binning: binning(i), ...(slab?.axis === i ? { slab } : {}) })),
      q_max: bins.extent.qMax,
      ...(energy ? { energy_transfer: { ...energy, unit: "meV" } } : {}),
      total_bins: total,
      mdnorm_call: call,
      ...(s.mono ? { chopper: dgsOf(exp).chopper } : {}),
    };
  },
});
