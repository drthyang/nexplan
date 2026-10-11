/** A material's neutron scattering power against a reference, and unit conversions. */
import { z } from "zod";
import type { CalcSuccess } from "../../app/compute.ts";
import { difcFromGeometry, NEUTRON_MASS_OVER_H } from "../../core/diffraction/tof.ts";
import { neutronEnergyMeV, neutronWavelengthA, xrayEnergyKeV, xrayWavelengthA } from "../../core/physics/energy.ts";
import { braggStrengths, braggSummary, LAMBDA_2200, scatteringPower, type BraggWeight } from "../../core/scattering/power.ts";
import { REFERENCES } from "../../ui/standards.ts";
import { dMinField, structureId } from "../shared.ts";
import { defineTool, ToolError } from "../tool.ts";
import { DEFAULT_D_MIN, DEFAULT_WAVELENGTH, type Workspace } from "../workspace.ts";

/** Cross-sections and Bragg lines of a calculation (as the Scattering power card). */
function materialOf(r: CalcSuccess, lambda: number) {
  const s = r.structure;
  return {
    name: s.name || r.blockName,
    power: scatteringPower(s.sites.map((x) => ({ label: x.label, multiplicity: x.multiplicity, occupancy: x.occupancy, xs: x.neutronXs })), s.volume, lambda),
    lines: braggStrengths(r.groups, s.volume),
  };
}

const neutronCalc = (ws: Workspace, id: string, dMin: number) => ws.calculate(id, { radiation: "neutron", wavelength: DEFAULT_WAVELENGTH, dMin });

export const scatteringPowerTool = defineTool({
  name: "scattering_power",
  title: "Neutron scattering power against a reference",
  description:
    "Compares a material's neutron scattering per unit volume with a reference (V, diamond, Si, CeO₂, corundum, a demo or another loaded structure): macroscopic coherent, incoherent and absorption cross-sections Σ (cm⁻¹, Sears 1992, absorption scaled by 1/v to the wavelength), the 1/e attenuation length, and the Bragg lines in a d window: the strongest and the sum of j|F|²/v_c² (or ×d⁴ for TOF), with sample/reference ratios. " +
    "For judging how strongly a sample scatters and how thick it can be; not a counting time.",
  input: z.strictObject({
    structure_id: structureId,
    reference: z.enum(REFERENCES.map((r) => r.id) as [string, ...string[]]).optional().describe("Bundled reference: vanadium, diamond, si (default), ceo2, al2o3, spinel, quartz, nacl."),
    reference_structure_id: structureId.optional().describe("A loaded structure as the reference instead."),
    wavelength: z.number().positive().max(20).optional().describe(`Wavelength (Å) for absorption; default ${LAMBDA_2200} (2200 m/s).`),
    d_window: z.strictObject({ min: z.number().positive(), max: z.number().positive() }).optional().describe("d range (Å) of the Bragg lines compared; default 1–4."),
    weight: z.enum(["tof", "strength"]).optional().describe("tof: j|F|²d⁴/v_c², as lines rank in a TOF pattern (default); strength: j|F|²/v_c²."),
    d_min: dMinField,
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run(args, { workspace }) {
    if (args.reference !== undefined && args.reference_structure_id !== undefined) throw new ToolError("Give reference or reference_structure_id, not both.");
    const dMin = args.d_min ?? DEFAULT_D_MIN;
    const lambda = args.wavelength ?? LAMBDA_2200;
    const win: [number, number] = [args.d_window?.min ?? 1, args.d_window?.max ?? 4];
    if (!(win[1] > win[0])) throw new ToolError("d_window needs min < max.");
    const weight: BraggWeight = args.weight ?? "tof";
    let refId = args.reference_structure_id;
    if (refId === undefined) {
      const ref = REFERENCES.find((x) => x.id === (args.reference ?? "si"))!;
      refId = workspace.add({ fileName: ref.file, cifText: await ref.load(), source: `bundled: ${ref.label}. ${ref.source}`, choices: {} }, ref.id).id;
    }
    const sample = materialOf(await neutronCalc(workspace, args.structure_id, dMin), lambda);
    const reference = materialOf(await neutronCalc(workspace, refId, dMin), lambda);
    const sSum = braggSummary(sample.lines, win[0], win[1], weight);
    const rSum = braggSummary(reference.lines, win[0], win[1], weight);
    const ratio = (a: number, b: number) => (b > 0 && Number.isFinite(a / b) ? a / b : null);
    const view = (m: typeof sample, sum: typeof sSum) => ({
      name: m.name,
      coherent_cm: m.power.coh,
      incoherent_cm: m.power.inc,
      absorption_cm: m.power.abs,
      total_cm: m.power.total,
      attenuation_length_cm: m.power.attenuationLength,
      atoms_per_A3: m.power.density,
      bragg: { lines: sum.count, sum: sum.sum, ...(sum.strongest ? { strongest: { hkl: sum.strongest.label, d: sum.strongest.d, value: sum.strongest[weight] } } : {}) },
      ...(m.power.missing.length ? { missing_cross_sections: m.power.missing } : {}),
      ...(m.power.resonant.length ? { resonant_absorbers: m.power.resonant } : {}),
    });
    return {
      wavelength_for_absorption: lambda,
      d_window: win,
      weight: weight === "tof" ? "j|F|²d⁴/v_c² (fm²/Å²)" : "j|F|²/v_c² (fm²/Å⁶)",
      sample: view(sample, sSum),
      reference: { structure_id: refId, ...view(reference, rSum) },
      ratios: { coherent: ratio(sample.power.coh, reference.power.coh), incoherent: ratio(sample.power.inc, reference.power.inc), absorption: ratio(sample.power.abs, reference.power.abs), bragg_sum: ratio(sSum.sum, rSum.sum), strongest_line: ratio(sSum.strongest?.[weight] ?? 0, rSum.strongest?.[weight] ?? 0) },
      notes: [
        "Per unit volume of the full crystal: a powder's packing fraction scales all values equally.",
        "Flux, Lorentz and detector factors depend only on d, so at similar d the ratio of line strengths is the ratio of intensities for equal volumes.",
        ...(sample.power.resonant.length ? [`${sample.power.resonant.join(", ")}: resonant absorber; absorption away from 1.798 Å does not follow 1/v.`] : []),
      ],
    };
  },
});

export const convertUnits = defineTool({
  name: "convert_units",
  title: "Convert energy, wavelength, d, Q, 2θ and time of flight",
  description:
    "Unit conversions with CODATA 2018 constants: a neutron energy (meV), velocity (m/s) or wavelength, or an X-ray energy (keV), to wavelength, energy, k and velocity; and a spacing (d, Q = 2π/d, or 2θ at the wavelength, or time of flight at a flight path and 2θ) to the others, with DIFC = (m_n/h)·L·2 sinθ. Give one beam quantity and/or one spacing quantity.",
  input: z.strictObject({
    radiation: z.enum(["neutron", "xray"]).optional().describe("For a bare wavelength: which radiation (default neutron)."),
    wavelength: z.number().positive().optional().describe("Å"),
    energy_mev: z.number().positive().optional().describe("Neutron energy (meV)."),
    velocity: z.number().positive().optional().describe("Neutron velocity (m/s)."),
    energy_kev: z.number().positive().optional().describe("X-ray photon energy (keV)."),
    d: z.number().positive().optional().describe("d-spacing (Å)."),
    q: z.number().positive().optional().describe("Q = 2π/d (1/Å)."),
    two_theta: z.number().gt(0).lt(180).optional().describe("Scattering angle 2θ (deg)."),
    flight_path: z.number().positive().optional().describe("Total flight path L1 + L2 (m), for time of flight."),
    tof: z.number().positive().optional().describe("Time of flight (µs), with flight_path (and two_theta for d)."),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  run(args) {
    const beams = [args.wavelength, args.energy_mev, args.velocity, args.energy_kev].filter((x) => x !== undefined).length;
    if (beams > 1) throw new ToolError("Give one of wavelength, energy_mev, velocity, energy_kev.");
    const spacings = [args.d, args.q].filter((x) => x !== undefined).length;
    if (spacings > 1) throw new ToolError("Give d or q, not both.");
    const xray = args.energy_kev !== undefined || (args.radiation === "xray" && args.wavelength !== undefined);
    if (xray && (args.energy_mev !== undefined || args.velocity !== undefined || args.tof !== undefined)) throw new ToolError("Neutron quantities (meV, velocity, time of flight) do not apply to X-rays.");
    let lambda = args.wavelength ?? (args.energy_mev !== undefined ? neutronWavelengthA(args.energy_mev) : args.velocity !== undefined ? 1e6 / (NEUTRON_MASS_OVER_H * args.velocity) : args.energy_kev !== undefined ? xrayWavelengthA(args.energy_kev) : undefined);
    let d = args.d ?? (args.q !== undefined ? (2 * Math.PI) / args.q : undefined);
    const out: Record<string, unknown> = {};
    // Time of flight: λ = t/(K·L); with 2θ also d = t/DIFC.
    if (args.tof !== undefined) {
      if (args.flight_path === undefined) throw new ToolError("tof needs flight_path.");
      if (lambda !== undefined) throw new ToolError("Give tof or a beam quantity, not both: the time of flight fixes the wavelength.");
      lambda = args.tof / (NEUTRON_MASS_OVER_H * args.flight_path);
      if (args.two_theta !== undefined) {
        const tofD = args.tof / difcFromGeometry(args.flight_path, args.two_theta);
        if (d !== undefined && Math.abs(d - tofD) > 1e-9 * d) throw new ToolError(`tof at this flight path and 2θ gives d = ${tofD}, not the d given.`);
        d = tofD;
      }
    }
    if (d === undefined && args.two_theta !== undefined && lambda !== undefined) d = lambda / (2 * Math.sin((args.two_theta * Math.PI) / 360));
    if (lambda === undefined && d !== undefined && args.two_theta !== undefined) lambda = 2 * d * Math.sin((args.two_theta * Math.PI) / 360);
    if (lambda !== undefined) {
      out.wavelength = lambda;
      out.k = (2 * Math.PI) / lambda;
      if (xray) out.energy_kev = xrayEnergyKeV(lambda);
      else {
        out.energy_mev = neutronEnergyMeV(lambda);
        out.velocity = 1e6 / (NEUTRON_MASS_OVER_H * lambda);
        out.tof_per_metre_us = NEUTRON_MASS_OVER_H * lambda;
      }
    }
    if (d !== undefined) {
      out.d = d;
      out.q = (2 * Math.PI) / d;
      if (lambda !== undefined) {
        const s = lambda / (2 * d);
        out.two_theta = s <= 1 ? (2 * Math.asin(s) * 180) / Math.PI : null;
        if (s > 1) out.note = `λ > 2d: no Bragg reflection at this wavelength.`;
      }
    }
    if (args.two_theta !== undefined) out.two_theta ??= args.two_theta;
    if (args.flight_path !== undefined && args.two_theta !== undefined && !xray) {
      const difc = difcFromGeometry(args.flight_path, args.two_theta);
      out.difc = difc;
      if (d !== undefined) out.tof = difc * d;
    }
    if (!Object.keys(out).length) throw new ToolError("Nothing to convert: give a wavelength or energy, and/or d, q or 2θ with a wavelength.");
    return { ...out, units: { wavelength: "Å", k: "1/Å (2π/λ)", energy_mev: "meV", energy_kev: "keV", velocity: "m/s", d: "Å", q: "1/Å", two_theta: "deg", tof: "µs", difc: "µs/Å" } };
  },
});
