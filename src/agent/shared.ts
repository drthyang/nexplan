/** Input schemas the tools share, and the files they read and write. */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { SNS_CATALOG } from "../core/ub/instrumentCatalog.ts";
import { ToolError } from "./tool.ts";
import { DEFAULT_D_MIN } from "./workspace.ts";

// ---------------------------------------------------------------- values

export const structureId = z.string().min(1).describe("Id of a structure from load_structure.");

export const dMinField = z
  .number()
  .positive()
  .max(100)
  .optional()
  .describe(`Shortest d-spacing calculated (Å); default ${DEFAULT_D_MIN}. The number of reflections grows as 1/d_min³.`);

export const hklField = z.array(z.number().int()).length(3).describe("Miller indices [h, k, l] in the CIF cell.");

export const vec3 = z.array(z.number()).length(3);

export const mat3 = z.array(z.array(z.number()).length(3)).length(3).describe("3 × 3 matrix, as rows.");

export const outputPath = z
  .string()
  .min(1)
  .optional()
  .describe("Also write the full data to this file (absolute, or relative to the directory the server was started in; ~ is the home directory). An existing file is overwritten.");

export const limitField = (def: number, max: number) => z.number().int().min(1).max(max).optional().describe(`Rows returned (default ${def}, at most ${max}); the total is always reported.`);

// ---------------------------------------------------------------- orientation

export const orientationField = z
  .strictObject({
    ub: mat3.optional().describe("UB rows, q = UB·h (1/Å, no 2π), as in an ISAW file."),
    ub_path: z.string().optional().describe("ISAW UB file (.mat)."),
    ub_text: z.string().optional().describe("ISAW UB file contents."),
    u: vec3.optional().describe("Mount without a UB: along the beam at zero angles (r.l.u., Mantid SetUB u)."),
    v: vec3.optional().describe("Mount: horizontal, ⟂ beam (r.l.u., SetUB v)."),
    cell_match: z.number().int().min(0).optional().describe("Which cell match of the UB (analyze_ub); default the best."),
  })
  .optional()
  .describe("Crystal orientation: a UB (read in the CIF cell when it fits a setting, supercell or smaller cell of it), a mount u, v, or nothing (U = I).");

// ---------------------------------------------------------------- instruments

const INSTRUMENT_IDS = SNS_CATALOG.map((i) => i.id) as [string, ...string[]];

export const instrumentField = z.enum(INSTRUMENT_IDS).describe("SNS instrument; list_instruments describes each.");

export const axisRef = z.union([z.number().int().min(0), z.string()]).describe("Goniometer axis: its index (0 = outermost) or name (omega, chi, phi, psi, or ω, χ, φ, ψ).");

export const anglesField = z
  .union([z.array(z.number()), z.record(z.string(), z.number())])
  .optional()
  .describe('Goniometer angles (deg): one per axis in order, or by axis name ({"omega": 30}). Fixed axes keep their value; omitted axes are 0.');

const maskField = z
  .strictObject({
    edge_rows: z.number().int().min(0).optional().describe("Pixels masked at each end of every tube (or top and bottom rows of rectangular panels)."),
    edge_cols: z.number().int().min(0).optional().describe("Tubes (or pixel columns) masked at each side of every panel."),
    panels_off: z.array(z.string()).optional().describe("Panels switched off, by instrument-definition name (e.g. bank17)."),
    detector_ids: z.string().optional().describe("Masked Mantid detector IDs as ranges, e.g. '0-15,4096'."),
    mask_file: z.string().optional().describe("Path to a Mantid mask file (SaveMask XML with <detids>)."),
  })
  .optional()
  .describe("Detector masks: masked pixels record nothing in every hit test.");

const turnsWith = z.number().int().min(0).optional().describe("Mounted on this goniometer axis, so it turns with axes 0 … turns_with; absent: fixed in the lab.");

const shadowField = z
  .array(
    z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("opening"), half_angle: z.number().min(0).max(90).describe("Window |ν| ≤ half_angle (deg); everything above and below is blocked."), turns_with: turnsWith }),
      z.strictObject({ kind: z.literal("sector"), gamma: z.number().describe("Centre γ (deg) of a leg or post blocking every ν."), half_width: z.number().min(0).max(180), turns_with: turnsWith }),
      z.strictObject({ kind: z.literal("box"), gamma_min: z.number(), gamma_max: z.number(), nu_min: z.number().min(-90).max(90), nu_max: z.number().min(-90).max(90), turns_with: turnsWith }),
    ]),
  )
  .optional()
  .describe("Sample-environment shadows: blocked directions, with γ the horizontal angle from the beam (positive towards +x) and ν the elevation (deg). None by default.");

/** The instrument and its beam: band, POWGEN frame, or Ei and chopper. */
export const instrumentFields = {
  instrument: instrumentField,
  lambda_min: z.number().positive().optional().describe("White-beam band start (Å); default the instrument's."),
  lambda_max: z.number().positive().optional().describe("White-beam band end (Å)."),
  frame: z.number().positive().optional().describe("POWGEN frame by centre λ (Å): 0.8, 1.5 (default), 2.665, 4.797, 0.533, 1.599, 3.198."),
  ei_mev: z.number().positive().optional().describe("ARCS, SEQUOIA, CNCS: incident energy (meV); default 60, 60, 12."),
  chopper: z.string().optional().describe("ARCS, SEQUOIA: Fermi package; CNCS: High Flux, Intermediate or High Resolution (list_instruments lists them). Sets the elastic width."),
  chopper_frequency: z.number().positive().optional().describe("Final-chopper frequency (Hz); default 300."),
  elastic_fwhm: z.number().positive().max(1).optional().describe("Elastic ΔE/E (FWHM) instead of PyChop's."),
};

/**
 * What limits an instrument's acceptance beyond its geometry: goniometer limits, detector masks and sample-
 * environment shadows. Set once per instrument with configure_instrument (as the web app's Detectors page sets them
 * for every page), so the other tools' schemas stay short.
 */
export const acceptanceFields = {
  goniometer_limits: z
    .array(z.strictObject({ axis: axisRef, min: z.number(), max: z.number() }))
    .optional()
    .describe("Narrower ranges (deg) for free goniometer axes, e.g. for collisions or a sample environment; every search and scan respects them."),
  masks: maskField,
  shadows: shadowField,
};

export type InstrumentArgs = z.infer<z.ZodObject<typeof instrumentFields>> & Partial<z.infer<z.ZodObject<typeof acceptanceFields>>>;
export type AcceptanceArgs = z.infer<z.ZodObject<typeof acceptanceFields>>;

/** A plan: an orientation list, or a rotation scan of one axis; with neither, the instrument's usual scan. */
export const planFields = {
  angles: anglesField,
  settings: z
    .array(z.union([z.array(z.number()), z.record(z.string(), z.number())]))
    .optional()
    .describe("Orientation list: the goniometer angles of each setting (as `angles`). TOPAZ is planned this way (about ten settings; suggest_settings proposes them)."),
  scan: z
    .strictObject({
      axis: axisRef.optional(),
      start: z.number(),
      end: z.number(),
      step: z.number().positive(),
      interleave: z.boolean().optional().describe("Add the half-way steps (a second pass offset by step/2)."),
    })
    .optional()
    .describe("Rotation scan of one free axis (deg), the others at `angles`; default axis the first free one. CORELLI scans 0–357° in 3° steps; chopper spectrometers scan ψ."),
};

// ---------------------------------------------------------------- files

const MAX_INPUT_BYTES = 20 * 1024 * 1024;

/**
 * An absolute path: ~ expanded, relative paths from the directory the server was started in (npm's INIT_CWD when
 * started by `npm --prefix … run mcp`, which moves the working directory to the package).
 */
export const absolutePath = (p: string) => (p === "~" || p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : isAbsolute(p) ? p : resolve(process.env.INIT_CWD ?? process.cwd(), p));

/** A text file's contents, refused beyond 20 MB (as the web app refuses CIFs). */
export async function readText(path: string, what: string): Promise<{ text: string; path: string; name: string }> {
  const abs = absolutePath(path);
  let size: number;
  try {
    size = (await stat(abs)).size;
  } catch {
    throw new ToolError(`Cannot read the ${what} '${abs}': no such file.`);
  }
  if (size > MAX_INPUT_BYTES) throw new ToolError(`The ${what} '${abs}' is ${(size / 1048576).toFixed(1)} MB; files over 20 MB are not read.`);
  return { text: await readFile(abs, "utf8"), path: abs, name: abs.split(/[\\/]/).pop()! };
}

/** Writes a text file (creating its directory) and returns its absolute path. */
export async function writeText(path: string, text: string): Promise<string> {
  const abs = absolutePath(path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, text, "utf8");
  return abs;
}

/** Writes a binary file (creating its directory) and returns its absolute path. */
export async function writeBinary(path: string, bytes: Uint8Array): Promise<string> {
  const abs = absolutePath(path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
  return abs;
}
