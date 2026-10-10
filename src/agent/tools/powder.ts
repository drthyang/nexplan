/** Powder patterns: a generic X-ray or neutron beam (one wavelength or one TOF bank), and SNS instruments' banks. */
import { z } from "zod";
import type { CalcSuccess } from "../../app/compute.ts";
import { cwPeaks, type PeakGroup, type Polarization, type PowderAxis, type PowderPeak } from "../../core/diffraction/powder.ts";
import { synthesizeTof, tofPeaks, type TofBank, type TofShape } from "../../core/diffraction/tof.ts";
import { blockedAt } from "../../core/instrument/acceptance.ts";
import { focusedPeaks, focusedTofBank, recordsD } from "../../core/instrument/focus.ts";
import { elasticPattern } from "../../core/instrument/powderRings.ts";
import { coveredTwoTheta, dRangeAt, panelDifc } from "../../core/instrument/simulate.ts";
import { hklText } from "../../ui/format.ts";
import { beamSummary, focusedBanksOf, frameShape, fwhmInD, resolveInstrument } from "../instrument.ts";
import { dMinField, instrumentFields, limitField, outputPath, structureId, writeText } from "../shared.ts";
import { defineTool, ToolError } from "../tool.ts";
import { radiationLabel } from "./structure.ts";
import { DEFAULT_D_MIN, DEFAULT_TOF, DEFAULT_WAVELENGTH } from "../workspace.ts";

const profilePoints = z.number().int().min(0).max(4000).optional().describe("Also return the profile inline, reduced to this many points (each the maximum of its interval, so peaks survive); default 0. For plotting, prefer output_path.");

/** The profile reduced to n points, each the maximum of its interval (peaks keep their height). */
function reduce(x: Float64Array, y: Float64Array, n: number): { x: number[]; y: number[] } {
  if (!n || !x.length) return { x: [], y: [] };
  if (x.length <= n) return { x: Array.from(x), y: Array.from(y) };
  const ox: number[] = [];
  const oy: number[] = [];
  for (let k = 0; k < n; k++) {
    const a = Math.floor((k * x.length) / n);
    const b = Math.max(a + 1, Math.floor(((k + 1) * x.length) / n));
    let best = a;
    for (let i = a; i < b; i++) if (y[i]! > y[best]!) best = i;
    ox.push(x[best]!);
    oy.push(y[best]!);
  }
  return { x: ox, y: oy };
}

const familiesText = (g: PeakGroup) => g.families.map((f) => `(${hklText(f.hkl)})`).join(" + ");

/** Peaks for a caller: hkl families, positions, Σ|F|², Lorentz factor, intensity and intensity relative to the strongest. */
function peakRows(peaks: readonly PowderPeak[], extra?: (p: PowderPeak, i: number) => object) {
  const max = Math.max(0, ...peaks.map((p) => p.intensity));
  return peaks.map((p, i) => ({
    hkl: familiesText(p),
    multiplicity: p.families.reduce((n, f) => n + f.multiplicity, 0),
    d: p.d,
    q: p.q,
    ...(p.twoTheta !== undefined ? { two_theta: p.twoTheta } : {}),
    ...(p.tof !== undefined ? { tof: p.tof } : {}),
    sum_f2: p.sumF2,
    lorentz: p.lp,
    intensity: p.intensity,
    relative: max > 0 ? (100 * p.intensity) / max : 0,
    ...(extra ? extra(p, i) : {}),
  }));
}

async function writeProfile(path: string, header: string[], xName: string, x: Float64Array, y: Float64Array): Promise<string> {
  const lines = [...header.map((h) => `# ${h}`), `${xName},intensity`];
  for (let i = 0; i < x.length; i++) lines.push(`${Number(x[i]!.toPrecision(9))},${Number(y[i]!.toPrecision(7))}`);
  return writeText(path, lines.join("\n") + "\n");
}

const AXIS_NAME: Record<PowderAxis, string> = { twoTheta: "two_theta_deg", d: "d_A", q: "Q_invA", tof: "tof_us" };

export const powderPattern = defineTool({
  name: "powder_pattern",
  title: "Powder pattern (generic beam)",
  description:
    "Bragg powder pattern of a structure for a generic beam: X-rays or neutrons at one wavelength (constant wavelength: Lorentz(-polarization) 1/(sin²θ cosθ), pseudo-Voigt peaks), or neutron time of flight at one detector bank (DIFC from the flight path and 2θ, TOF Lorentz sinθ·d⁴, Gaussian Δd/d peaks). " +
    "Returns the peak list (hkl families, d, Q, 2θ or TOF, Σ|F|², Lorentz factor, intensity); the profile is written to output_path or returned reduced with profile_points. Relative intensities only: no absorption, extinction, preferred orientation or background. For an SNS instrument's banks use instrument_powder_pattern.",
  input: z.strictObject({
    structure_id: structureId,
    radiation: z.enum(["neutron", "xray"]).optional().describe("neutron (default) or xray."),
    mode: z.enum(["cw", "tof"]).optional().describe("cw: one wavelength (default); tof: neutron time of flight at one bank."),
    wavelength: z.number().positive().max(100).optional().describe(`CW wavelength (Å); default ${DEFAULT_WAVELENGTH}. convert_units converts from keV or meV.`),
    d_min: dMinField,
    polarization: z
      .strictObject({
        kind: z.enum(["unpolarized", "monochromator", "linear"]),
        monochromator_two_theta: z.number().min(0).max(180).optional().describe("Monochromator 2θ_M (deg), for kind monochromator."),
        fraction: z.number().min(0).max(1).optional().describe("Fraction polarized perpendicular to the scattering plane (synchrotron ≈ 0.95–1), for kind linear."),
      })
      .optional()
      .describe("X-ray polarization: unpolarized (laboratory, no monochromator; default), monochromator (mosaic crystal, coplanar) or linear (synchrotron)."),
    axis: z.enum(["two_theta", "d", "q", "tof"]).optional().describe("Profile axis; default two_theta for CW, tof for TOF."),
    fwhm: z.number().positive().optional().describe("CW peak FWHM in the axis's units (deg of 2θ, Å or 1/Å); default 0.1."),
    eta: z.number().min(0).max(1).optional().describe("CW pseudo-Voigt Lorentzian fraction (0 Gaussian, 1 Lorentzian); default 0.5."),
    tof: z
      .strictObject({
        two_theta: z.number().gt(0).lt(180).optional().describe("Bank 2θ (deg); default 90."),
        flight_path: z.number().positive().optional().describe("Total flight path L1 + L2 (m); default 20."),
        difc: z.number().positive().optional().describe("DIFC (µs/Å) to use instead of the one from flight path and 2θ."),
        difa: z.number().optional().describe("DIFA (µs/Å²); default 0."),
        zero: z.number().optional().describe("ZERO (µs); default 0."),
        lambda_min: z.number().positive().optional().describe("Band reaching the sample (Å); default 0.5."),
        lambda_max: z.number().positive().optional().describe("Default 3.5."),
        d_over_d: z.number().positive().max(0.5).optional().describe("Gaussian peak FWHM Δd/d; default 0.003."),
      })
      .optional()
      .describe("TOF bank, for mode tof."),
    limit: limitField(50, 2000),
    output_path: outputPath.describe("Write the profile as CSV (axis value, intensity) to this file; overwritten if it exists."),
    profile_points: profilePoints,
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  async run(args, { workspace }) {
    const radiation = args.radiation ?? "neutron";
    const tofMode = args.mode === "tof";
    if (tofMode && radiation !== "neutron") throw new ToolError("Time of flight is for neutrons; use mode cw for X-rays.");
    if (args.tof && !tofMode) throw new ToolError("tof settings apply to mode tof.");
    if (args.polarization && radiation !== "xray") throw new ToolError("Polarization applies to X-rays only.");
    const axis: PowderAxis = args.axis === "two_theta" ? "twoTheta" : (args.axis ?? (tofMode ? "tof" : "twoTheta"));
    if (tofMode && axis === "twoTheta") throw new ToolError("A TOF bank sits at one 2θ: use axis tof, d or q.");
    if (!tofMode && axis === "tof") throw new ToolError("axis tof needs mode tof.");
    const p = args.polarization;
    const polarization: Polarization = !p || p.kind === "unpolarized" ? { kind: "unpolarized" } : p.kind === "monochromator" ? { kind: "monochromator", twoThetaMDeg: p.monochromator_two_theta ?? 26.6 } : { kind: "linear", fraction: p.fraction ?? 0.95 };
    const t = args.tof ?? {};
    const shape: TofShape = { kind: "gaussian", dOverD: t.d_over_d ?? 0.003 };
    const r = await workspace.calculate(args.structure_id, {
      radiation,
      wavelength: args.wavelength ?? DEFAULT_WAVELENGTH,
      dMin: args.d_min ?? DEFAULT_D_MIN,
      polarization,
      neutronMode: tofMode ? "tof" : "cw",
      tof: {
        twoThetaDeg: t.two_theta ?? DEFAULT_TOF.twoThetaDeg,
        flightPathM: t.flight_path ?? DEFAULT_TOF.flightPathM,
        ...(t.difc !== undefined ? { difcOverride: t.difc } : {}),
        difa: t.difa ?? 0,
        zero: t.zero ?? 0,
        lambdaMin: t.lambda_min ?? DEFAULT_TOF.lambdaMin,
        lambdaMax: t.lambda_max ?? DEFAULT_TOF.lambdaMax,
        shape,
      },
      profile: { axis, fwhm: args.fwhm ?? 0.1, eta: args.eta ?? 0.5 },
    });
    return patternResult(r, args, axis, tofMode, workspace.newNotes(args.structure_id, r));
  },
});

async function patternResult(r: CalcSuccess, args: { limit?: number | undefined; output_path?: string | undefined; profile_points?: number | undefined; structure_id: string }, axis: PowderAxis, tofMode: boolean, notes: readonly string[]) {
  const peaks = [...r.peaks].sort((a, b) => b.d - a.d);
  const limit = args.limit ?? 50;
  const written = args.output_path
    ? await writeProfile(args.output_path, [`NEXPLAN powder profile: ${r.structure.name || r.blockName}; ${r.provenance.radiation}`, `d_min ${r.provenance.dMin} A; ${tofMode ? `TOF bank 2theta ${r.bank!.twoThetaDeg} deg, DIFC ${r.bank!.difc} us/A` : `lambda ${r.provenance.wavelength} A`}; input sha256 ${r.provenance.inputSha256}`], AXIS_NAME[axis], r.profile.x, r.profile.y)
    : undefined;
  return {
    structure_id: args.structure_id,
    radiation: radiationLabel(r),
    d_min: r.provenance.dMin,
    ...(tofMode ? { bank: { two_theta: r.bank!.twoThetaDeg, difc: r.bank!.difc, difa: r.bank!.difa, zero: r.bank!.zero, lambda_min: r.bank!.lambdaMin, lambda_max: r.bank!.lambdaMax } } : { wavelength: r.provenance.wavelength }),
    units: { d: "Å", q: "1/Å", two_theta: "deg", tof: "µs", sum_f2: r.provenance.settings.radiation === "xray" ? "electrons²" : "fm²" },
    total_peaks: peaks.length,
    peaks: peakRows(peaks.slice(0, limit)),
    profile: { axis: AXIS_NAME[axis], points: r.profile.x.length, ...(args.profile_points ? reduce(r.profile.x, r.profile.y, args.profile_points) : {}) },
    ...(written ? { written } : {}),
    ...(notes.length ? { notes } : {}),
    conventions: r.provenance.conventions,
  };
}

export const instrumentPowderPattern = defineTool({
  name: "instrument_powder_pattern",
  title: "Powder pattern on an SNS instrument",
  description:
    "Powder pattern as an SNS instrument records it. NOMAD and POWGEN: a focused bank, modelled as focused and divided by vanadium (NOMAD banks 0–5 as Mantid and the TOPAS files number them; POWGEN one bank of all panels), with the measured peak widths (NOMAD Δd/d per bank; POWGEN GSAS-II profiles of the 0.8, 1.5 and 2.665 Å frames), or a single panel. ARCS, SEQUOIA, CNCS: the elastic pattern over 2θ at Ei. Any instrument: one panel at its centre angle. " +
    "Lists the banks with their 2θ, L2, DIFC and d range, and for each line its FWHM, whether the nearest line is resolved (≥ 1 FWHM apart) and the sharpest bank or frame that records it. Says when d_min cuts the bank's range. Masks and shadows set with configure_instrument apply.",
  input: z.strictObject({
    structure_id: structureId,
    d_min: dMinField,
    ...instrumentFields,
    view: z.enum(["bank", "panel"]).optional().describe("bank: a focused bank (default where the instrument has them); panel: one detector panel as its own bank."),
    bank: z.number().int().min(0).optional().describe("Focused bank index (NOMAD 0–5); default the bank nearest 2θ = 90°."),
    panel: z.union([z.number().int().min(0), z.string()]).optional().describe("For view panel: panel index or name (e.g. bank17); default the panel nearest 2θ = 90°."),
    peak_width: z.enum(["instrument", "fixed"]).optional().describe("instrument: the published widths where there are some (default); fixed: d_over_d."),
    d_over_d: z.number().positive().max(0.5).optional().describe("Fixed Gaussian width Δd/d (FWHM) where the instrument has none or peak_width is fixed; default 0.005."),
    axis: z.enum(["tof", "d", "q"]).optional().describe("Profile axis for TOF instruments; default tof (chopper spectrometers always 2θ)."),
    limit: limitField(60, 2000),
    output_path: outputPath.describe("Write the profile as CSV to this file; overwritten if it exists."),
    profile_points: profilePoints,
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  async run(args, { workspace }) {
    const ins = await resolveInstrument(args, workspace);
    const { exp, preset, panels, info, l1 } = ins;
    const r = await workspace.calculate(args.structure_id, { radiation: "neutron", wavelength: DEFAULT_WAVELENGTH, dMin: args.d_min ?? DEFAULT_D_MIN });
    const maxF2 = Math.max(0, ...r.groups.map((g) => g.sumF2));
    const groups = r.groups.filter((g) => g.sumF2 > 1e-9 * maxF2);
    const blocked = blockedAt(ins.shadows, exp.angles);
    const covered = coveredTwoTheta(info.filter((_, i) => !panels[i]!.off));
    const mono = preset.incident;
    const lambda0 = (exp.lambdaMin + exp.lambdaMax) / 2;
    const dOverD = args.d_over_d ?? 0.005;

    // The single panel (view panel, or an instrument without focused banks).
    const nearest90 = info.reduce((best, a, i) => (!panels[i]!.off && (best < 0 || Math.abs(a.twoThetaCenter - 90) < Math.abs(info[best]!.twoThetaCenter - 90)) ? i : best), -1);
    let panel = nearest90;
    if (args.panel !== undefined) {
      panel = typeof args.panel === "number" ? args.panel : panels.findIndex((p) => p.name === args.panel);
      if (panel < 0 || panel >= panels.length) throw new ToolError(`${preset.label} has no panel ${JSON.stringify(args.panel)} (${panels.length} panels: ${panels[0]!.name} … ${panels.at(-1)!.name}).`);
    }
    if (panel < 0) throw new ToolError("Every panel is masked: nothing is recorded.");
    const pa = info[panel]!;
    const bank: TofBank = { twoThetaDeg: pa.twoThetaCenter, difc: panelDifc(panels[panel]!, l1), difa: 0, zero: 0, lambdaMin: exp.lambdaMin, lambdaMax: exp.lambdaMax };

    // Focused banks, as the Powder page builds them.
    const specs = mono ? [] : (preset.banks?.list ?? []);
    const focused = focusedBanksOf(ins, blocked);
    if (args.view === "bank" && !focused.length) throw new ToolError(`${preset.label} has no focused banks${mono ? " (chopper spectrometers record the elastic 2θ pattern)" : ""}; use view panel.`);
    const byBank = focused.length > 0 && args.view !== "panel";
    let fb: (typeof focused)[number] | undefined;
    if (byBank) {
      if (args.bank !== undefined) {
        fb = focused.find((f) => f.index === args.bank);
        if (!fb) throw new ToolError(args.bank < specs.length ? `${specs[args.bank]!.name} records nothing: every pixel is masked or shadowed.` : `${preset.label} has banks 0–${specs.length - 1}.`);
      } else fb = focused.reduce((best, f) => (Math.abs(f.bank.twoThetaDeg - 90) < Math.abs(best.bank.twoThetaDeg - 90) ? f : best));
    } else if (args.bank !== undefined) throw new ToolError("bank applies to view bank.");

    const longestD = Math.max(0, ...groups.map((g) => g.d));
    const drawBank = fb ? focusedTofBank(fb.bank, longestD > 0 ? { dMax: longestD * 1.15 } : {}) : bank;
    const panelOff = panels[panel]!.off === true;
    const peaks: PowderPeak[] = mono
      ? cwPeaks(groups, { wavelength: lambda0, lorentz: true, polarization: { kind: "none" } }).filter((p) => covered.some(([a, b]) => p.twoTheta! >= a && p.twoTheta! <= b))
      : fb
        ? focusedPeaks(groups, fb.bank, exp.lambdaMin, exp.lambdaMax)
        : panelOff
          ? []
          : tofPeaks(groups, bank);

    // Peak widths: NOMAD's measured Δd/d per bank, or the GSAS-II profile of POWGEN's frame.
    const frame = preset.frames?.list.find((f) => Math.abs(f.lambdaMin - exp.lambdaMin) < 1e-6 && Math.abs(f.lambdaMax - exp.lambdaMax) < 1e-6);
    let width: { shape: TofShape; source: string } | undefined;
    if (fb && fb.spec.dOverD !== undefined) width = { shape: { kind: "gaussian", dOverD: fb.spec.dOverD }, source: `measured Δd/d ${fb.spec.dOverD} (FWHM) of ${fb.spec.name}` };
    else if (fb && frame?.profile) width = { shape: frameShape(frame.profile), source: `GSAS-II TOF profile of the ${frame.centre} Å frame, ${frame.profile.file}` };
    const useInstrument = (args.peak_width ?? "instrument") === "instrument" && width !== undefined;
    const shape: TofShape = useInstrument ? width!.shape : { kind: "gaussian", dOverD };
    const axis = args.axis ?? "tof";
    const profile = mono ? elasticPattern(peaks, Math.hypot(dOverD, exp.eRes / 2), covered) : synthesizeTof(peaks, drawBank, shape, axis);

    // Per line: its FWHM, the nearest line in FWHM units, and the sharpest bank (NOMAD) or frame (POWGEN) recording it.
    const difcHere = fb ? fb.bank.difc : bank.difc;
    const sorted = [...peaks].sort((a, b) => b.d - a.d);
    const extra = (p: PowderPeak, i: number) => {
      if (mono) return {};
      const w = fwhmInD(shape, difcHere, p.d);
      const neighbours = [sorted[i - 1], sorted[i + 1]].filter((q): q is PowderPeak => q !== undefined);
      const sep = Math.min(...neighbours.map((q) => Math.abs(q.d - p.d)));
      let sharpest: string | undefined;
      if (byBank && focused.length > 1) {
        const options = focused.filter((f) => recordsD(f.bank, p.d, exp.lambdaMin, exp.lambdaMax)).map((f) => ({ label: f.spec.name, rel: useInstrument && f.spec.dOverD !== undefined ? f.spec.dOverD : dOverD }));
        const best = options.reduce<(typeof options)[number] | undefined>((b, o) => (!b || o.rel < b.rel ? o : b), undefined);
        if (best) sharpest = `${best.label} (${(100 * best.rel).toFixed(2)} %)`;
      } else if (byBank && useInstrument && preset.frames) {
        const options = preset.frames.list.filter((f) => f.profile && p.d >= f.dMin && p.d <= f.dMax).map((f) => ({ label: `${f.centre} Å frame`, rel: fwhmInD(frameShape(f.profile!), difcHere, p.d) / p.d }));
        const best = options.reduce<(typeof options)[number] | undefined>((b, o) => (!b || o.rel < b.rel ? o : b), undefined);
        if (best) sharpest = `${best.label} (${(100 * best.rel).toFixed(2)} %)`;
      }
      return {
        fwhm_percent: (100 * w) / p.d,
        ...(Number.isFinite(sep) ? { nearest_line_fwhm: sep / w, resolved: sep >= w } : {}),
        ...(sharpest ? { sharpest: sharpest } : {}),
      };
    };

    const calcDMin = r.provenance.dMin;
    const thetaMax = ((covered.at(-1)?.[1] ?? 180) * Math.PI) / 360;
    const reach = mono ? lambda0 / (2 * Math.sin(thetaMax)) : fb ? fb.bank.dMin : dRangeAt(pa.twoThetaCenter, exp.lambdaMin, exp.lambdaMax).dMin;
    const notes = [...ins.notes];
    if (reach < calcDMin - 1e-9) notes.push(`This ${mono ? "instrument" : fb ? "bank" : "panel"} records down to d = ${reach.toFixed(3)} Å, but reflections are calculated to d_min = ${calcDMin} Å only; pass d_min = ${Math.max(0.3, Math.floor(reach * 100) / 100)} to see the rest.`);
    if (!mono && fb && !useInstrument && (args.peak_width ?? "instrument") === "instrument") notes.push(`No published width for this bank and band: Gaussian Δd/d = ${dOverD}.`);
    if (panelOff && !fb && !mono) notes.push(`${panels[panel]!.name} is masked: it records nothing.`);
    notes.push(...workspace.newNotes(args.structure_id, r));

    const model = mono
      ? `${preset.label} elastic powder pattern at λ = ${lambda0.toPrecision(5)} Å over the 2θ the detectors cover (zero in the gaps); intensity per solid angle Σ|F|²/(sin²θ cosθ); width from Δd/d ${dOverD} and ΔE/E ${exp.eRes.toPrecision(3)}`
      : fb
        ? `${preset.label} ${fb.spec.name}, focused and divided by vanadium: I = Σ|F|²·d⁴·sinθ_f at the effective angle, TOF = DIFC·d; lines recorded by some cell of the bank`
        : `${preset.label} panel ${panels[panel]!.name} as one bank at its centre 2θ, DIFC from L1 + L2: I = Σ|F|²·d⁴·sinθ`;
    const written = args.output_path
      ? await writeProfile(args.output_path, [`NEXPLAN: ${r.structure.name || r.blockName}; ${model}`, `band ${exp.lambdaMin}-${exp.lambdaMax} A; d_min ${calcDMin} A; input sha256 ${r.provenance.inputSha256}`], mono ? "two_theta_deg" : AXIS_NAME[axis], profile.x, profile.y)
      : undefined;
    const limit = args.limit ?? 60;
    return {
      structure_id: args.structure_id,
      instrument: preset.label,
      beam: beamSummary(ins),
      d_min: calcDMin,
      model,
      ...(focused.length
        ? {
            banks: focused.map((f) => ({ index: f.index, name: f.spec.name, panels: f.idx.length, two_theta: f.bank.twoThetaDeg, two_theta_span: [f.bank.twoThetaMin, f.bank.twoThetaMax], l2: f.bank.l2, difc: f.bank.difc, d_min: f.bank.dMin, d_max: f.bank.dMax, ...(f.spec.dOverD !== undefined ? { d_over_d: f.spec.dOverD } : {}), ...(f === fb ? { selected: true } : {}) })),
          }
        : {}),
      ...(!fb && !mono ? { panel: { index: panel, name: panels[panel]!.name, two_theta: pa.twoThetaCenter, two_theta_span: [pa.twoThetaMin, pa.twoThetaMax], l2: pa.l2, difc: bank.difc, d_min: dRangeAt(pa.twoThetaCenter, exp.lambdaMin, exp.lambdaMax).dMin, d_max: dRangeAt(pa.twoThetaCenter, exp.lambdaMin, exp.lambdaMax).dMax } } : {}),
      ...(mono ? { two_theta_covered: covered } : {}),
      peak_width: mono ? `Δd/d ${dOverD} with ΔE/E ${exp.eRes.toPrecision(3)}` : useInstrument ? width!.source : `Gaussian Δd/d ${dOverD} (FWHM)`,
      units: { d: "Å", q: "1/Å", ...(mono ? { two_theta: "deg" } : { tof: fb ? "µs, on the focused DIFC" : "µs" }), sum_f2: "fm²" },
      total_peaks: sorted.length,
      peaks: peakRows(sorted.slice(0, limit), extra),
      profile: { axis: mono ? "two_theta_deg" : AXIS_NAME[axis], points: profile.x.length, ...(args.profile_points ? reduce(profile.x, profile.y, args.profile_points) : {}) },
      ...(written ? { written } : {}),
      ...(notes.length ? { notes } : {}),
    };
  },
});
