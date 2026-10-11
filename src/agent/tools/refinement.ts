/**
 * Instrument parameters for refining SNS powder data (MATERIA, GSAS-II): a NOMAD bank's or a POWGEN frame's TOF
 * calibration and peak profile, from the instrument data NEXPLAN carries, with the d range that bank or frame
 * records. MATERIA's parse_instrument reads the .instprm file; the JSON is its InstrumentParameters (TOF branch).
 */
import { z } from "zod";
import { formatTofInstprm, type TofInstprm } from "../../io/instprm.ts";
import { beamSummary, focusedBanksOf, frameShape, fwhmInD, resolveInstrument } from "../instrument.ts";
import { outputPath, writeText } from "../shared.ts";
import { defineTool, ToolError } from "../tool.ts";

const FWHM_PER_SIGMA = 2 * Math.sqrt(2 * Math.LN2);

export const instrumentParameters = defineTool({
  name: "instrument_parameters",
  title: "TOF instrument parameters for refinement",
  description:
    "GSAS-II instrument parameters (.instprm text, and the JSON of MATERIA's InstrumentParameters) for a NOMAD focused bank or a POWGEN chopper frame, with the bank's 2θ and flight path and the d and TOF range it records (for a refinement's fit range and d_min). " +
    "POWGEN: the GSAS-II back-to-back-exponential profile ORNL published for the 0.8, 1.5 and 2.665 Å frames (2026B, high resolution, 60 Hz), DIFC from the bank's effective geometry. NOMAD: the calibrated DIFC of banks 0–4 (ORNL 2023A) and a Gaussian width from the bank's measured Δd/d; the exponential terms are not known, so that file has none: MATERIA's powder page starts them from its own defaults, and GSAS-II needs them added (or ORNL's file). " +
    "Starting values, not a calibration for your cycle: replace difC, difA, difB and Zero with your run's.",
  input: z.strictObject({
    instrument: z.enum(["nomad", "powgen"]),
    bank: z.number().int().min(0).max(5).optional().describe("NOMAD bank 0–5 (as Mantid and the TOPAS files number them; GSAS bank = this + 1). Required for NOMAD: a missing bank lists them with their d ranges and widths."),
    frame: z.number().positive().optional().describe("POWGEN frame by centre wavelength (Å): 0.8, 1.5 (default), 2.665 (measured profiles), 4.797, 0.533, 1.599, 3.198."),
    output_path: outputPath.describe("Write the .instprm file; overwritten if it exists."),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  async run(args, { workspace }) {
    if (args.instrument === "nomad" && args.frame !== undefined) throw new ToolError("frame is for POWGEN; NOMAD takes a bank.");
    if (args.instrument === "powgen" && args.bank !== undefined && args.bank !== 0) throw new ToolError("POWGEN has one focused bank (all panels); choose a frame.");
    const ins = await resolveInstrument({ instrument: args.instrument, ...(args.instrument === "powgen" ? { frame: args.frame ?? 1.5 } : {}) }, workspace);
    const banks = focusedBanksOf(ins);
    if (args.instrument === "nomad" && args.bank === undefined)
      throw new ToolError("Choose a NOMAD bank (0–5): banks at higher 2θ are sharper but reach shorter d only.", {
        banks: banks.map((f) => ({ bank: f.index, two_theta: Number(f.bank.twoThetaDeg.toFixed(1)), d_range: [Number(f.bank.dMin.toFixed(3)), Number(f.bank.dMax.toFixed(2))], d_over_d: f.spec.dOverD })),
      });
    const index = args.instrument === "nomad" ? args.bank! : 0;
    const fb = banks.find((f) => f.index === index);
    if (!fb) throw new ToolError(`${ins.preset.label} bank ${index} is not available.`);
    const comments: string[] = [];
    let p: TofInstprm;
    let dRange: [number, number];
    let width: string;
    let complete: boolean;
    const geometry = { fltPath: ins.l1 + fb.bank.l2, twoTheta: fb.bank.twoThetaDeg, difC: fb.bank.difc, difA: 0, difB: 0, zero: 0 };
    if (args.instrument === "nomad") {
      const dOverD = fb.spec.dOverD!;
      // A Gaussian of FWHM Δd/d·d in d is σ = DIFC·Δd/d·d/(2√(2 ln 2)) in TOF: σ² = sig-1·d².
      const sig1 = ((fb.bank.difc * dOverD) / FWHM_PER_SIGMA) ** 2;
      p = { bank: index + 1, ...geometry, sig0: 0, sig1, sig2: 0, sigQ: 0, X: 0, Y: 0, Z: 0 };
      dRange = [fb.bank.dMin, fb.bank.dMax];
      width = `Gaussian from the measured Δd/d = ${dOverD} (FWHM, ORNL NOMAD overview, 2014): sig-1 = (DIFC·Δd/d/2.3548)²`;
      complete = false;
      comments.push(
        `NEXPLAN: NOMAD ${fb.spec.name} (GSAS bank ${index + 1}); ${fb.spec.difc !== undefined ? "calibrated DIFC from ORNL's 2023A GSAS-II file" : "geometric DIFC (bank 5 is not in ORNL's calibration file)"}`,
        "NEXPLAN: alpha, beta-0, beta-1 and beta-q are not known here: add them (or ORNL's .instprm) before loading in GSAS-II",
      );
    } else {
      const frame = ins.preset.frames!.list.find((f) => Math.abs(f.lambdaMin - ins.exp.lambdaMin) < 1e-6 && Math.abs(f.lambdaMax - ins.exp.lambdaMax) < 1e-6)!;
      const pr = frame.profile;
      p = { bank: 1, ...geometry, ...(pr ? { alpha: pr.alpha, beta0: pr.beta0, beta1: pr.beta1, betaQ: pr.betaq, sig0: pr.sig0, sig1: pr.sig1, sig2: pr.sig2, sigQ: pr.sigq } : {}), X: 0, Y: 0, Z: 0 };
      dRange = [frame.dMin, frame.dMax];
      complete = pr !== undefined;
      width = pr ? `GSAS-II profile of the ${frame.centre} Å frame, ${pr.file} (no Lorentzian: X = Y = 0)` : `none: no measured profile for the ${frame.centre} Å frame`;
      comments.push(`NEXPLAN: POWGEN ${frame.centre} A frame at ${frame.hz} Hz, all panels focused; DIFC from L1 60 m, L2 3.18 m, 2theta 90 deg (characterisation file)`);
      if (pr) {
        const shape = frameShape(pr);
        if (shape.validFrom !== undefined) comments.push(`NEXPLAN: below d = ${shape.validFrom.toFixed(3)} A these fitted parameters give a negative width (GSAS-II's formula has no value there)`);
      } else comments.push("NEXPLAN: no profile terms for this frame: add them before loading in GSAS-II");
    }
    comments.push("NEXPLAN: starting values; replace difC, difA, difB and Zero with your cycle's calibration");
    const text = formatTofInstprm(p, comments);
    const written = args.output_path ? await writeText(args.output_path, text) : undefined;
    const materia = {
      kind: "tof",
      name: args.instrument === "nomad" ? `NOMAD ${fb.spec.name}` : `POWGEN ${(beamSummary(ins) as { frame?: string }).frame ?? "frame"}`,
      facility: "SNS",
      difC: p.difC,
      difA: p.difA,
      difB: p.difB,
      zero: p.zero,
      ...(p.alpha !== undefined ? { alpha: p.alpha, beta0: p.beta0, beta1: p.beta1, betaQ: p.betaQ } : {}),
      ...(p.sig1 !== undefined ? { sig0: p.sig0, sig1: p.sig1, sig2: p.sig2, sigQ: p.sigQ } : {}),
    };
    const shape = args.instrument === "powgen" && p.alpha !== undefined ? frameShape(ins.preset.frames!.list.find((f) => f.profile?.alpha === p.alpha)!.profile!) : ({ kind: "gaussian", dOverD: fb.spec.dOverD ?? 0 } as const);
    const widthAt = [0.5, 1, 2, 4].filter((d) => d >= dRange[0] && d <= dRange[1]).map((d) => ({ d, fwhm_percent: (100 * fwhmInD(shape, p.difC, d)) / d }));
    return {
      instrument: ins.preset.label,
      bank: { name: fb.spec.name, gsas_bank: p.bank, two_theta: p.twoTheta, flight_path_m: p.fltPath, l1_m: ins.l1, l2_m: fb.bank.l2, difc: p.difC },
      beam: beamSummary(ins),
      d_range: dRange,
      tof_range_us: [p.difC * dRange[0], p.difC * dRange[1]],
      peak_width: width,
      ...(p.sig1 !== undefined || p.alpha !== undefined ? { fwhm_at_d: widthAt } : {}),
      complete_gsas2_file: complete,
      instprm: text,
      materia_instrument: materia,
      ...(written ? { written } : {}),
      use: "MATERIA: parse_instrument {path} reads the .instprm; its fit range can be the d_range (or tof_range_us). GSAS-II: Import Instrument Parameters.",
    };
  },
});
