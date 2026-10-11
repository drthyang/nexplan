/** The orientation a single-crystal tool uses: a UB (matrix or ISAW file) read in the CIF cell, a mount, or U = I. */
import type { Mat3 } from "@materia/core/math/types";
import type { z } from "zod";
import type { CalcSuccess } from "../app/compute.ts";
import { linearText, ratioText } from "../core/ub/basis.ts";
import { mountable } from "../core/ub/mount.ts";
import type { BasisMatch } from "../core/ub/ub.ts";
import { IsawParseError, parseIsawUB } from "../io/isaw.ts";
import { hklText } from "../ui/format.ts";
import { cellMatches, orientationText, viewOrientation, type UbState } from "../ui/ubShared.ts";
import { readText, type orientationField } from "./shared.ts";
import { ToolError } from "./tool.ts";

export type OrientationArgs = z.infer<typeof orientationField>;

export interface LoadedUB {
  readonly UB: Mat3;
  readonly fileName: string;
  readonly warnings: readonly string[];
  readonly latticeLine?: readonly number[];
}

/** The UB given as a matrix, a file path or file text (at most one), or undefined. */
export async function loadUB(args: { readonly ub?: number[][] | undefined; readonly ub_path?: string | undefined; readonly ub_text?: string | undefined } | undefined): Promise<LoadedUB | undefined> {
  if (!args) return undefined;
  const given = [args.ub, args.ub_path, args.ub_text].filter((x) => x !== undefined).length;
  if (given > 1) throw new ToolError("Give the UB once: as ub, ub_path or ub_text.");
  if (args.ub) {
    const UB = args.ub as unknown as Mat3;
    if (!UB.flat().every(Number.isFinite)) throw new ToolError("The UB has non-finite entries.");
    return { UB, fileName: "the UB given", warnings: [] };
  }
  const file = args.ub_path !== undefined ? await readText(args.ub_path, "UB file") : args.ub_text !== undefined ? { text: args.ub_text, name: "the UB text given", path: "" } : undefined;
  if (!file) return undefined;
  try {
    const parsed = parseIsawUB(file.text);
    return { UB: parsed.UB, fileName: file.name, warnings: parsed.warnings, ...(parsed.latticeLine ? { latticeLine: parsed.latticeLine } : {}) };
  } catch (e) {
    if (e instanceof IsawParseError) throw new ToolError(`${file.name}: ${e.message}`);
    throw e;
  }
}

const isIdentity = (P: Mat3) => P.every((r, i) => r.every((v, j) => Math.abs(v - (i === j ? 1 : 0)) < 1e-12));
const multiplesText = (P: Mat3) => (P.every((r, i) => r.every((v, j) => (i === j ? v > 0 : Math.abs(v) < 1e-12))) ? [0, 1, 2].map((i) => ratioText(P[i]![i]!)).join(" × ") : undefined);
const axesText = (P: Mat3) => `(${[0, 1, 2].map((j) => linearText([P[0]![j]!, P[1]![j]!, P[2]![j]!], ["a", "b", "c"])).join(", ")})`;

/** A cell match as the UB page states it. */
export function matchSummary(m: BasisMatch, index: number) {
  const kind = isIdentity(m.P)
    ? "the CIF cell"
    : m.volumeRatio > 1 + 1e-9
      ? multiplesText(m.P)
        ? `a ${multiplesText(m.P)} supercell of the CIF cell`
        : `a supercell of the CIF cell, ${ratioText(m.volumeRatio)} times its volume`
      : m.volumeRatio < 1 - 1e-9
        ? multiplesText(m.P)
          ? `a ${multiplesText(m.P)} cell of the CIF cell`
          : `a smaller cell of the CIF cell, ${ratioText(m.volumeRatio)} of its volume`
        : "the CIF cell in another setting";
  return { cell_match: index, ub_cell: kind, ub_axes_in_cif_axes: axesText(m.P), P: m.P, volume_ratio: m.volumeRatio, metric_misfit_percent: 100 * m.misfit };
}

export interface ResolvedOrientation {
  /** UB for CIF indices (q = UB·h, 1/Å, no 2π). */
  readonly UB: Mat3;
  readonly description: string;
  readonly fileUB?: Mat3;
  readonly match?: BasisMatch;
  readonly matches: readonly BasisMatch[];
  readonly warnings: readonly string[];
}

/** The orientation for a calculation and the caller's orientation arguments (ubShared.ts viewOrientation, as the pages). */
export async function resolveOrientation(result: CalcSuccess, args: OrientationArgs): Promise<ResolvedOrientation> {
  const file = await loadUB(args);
  if ((args?.u === undefined) !== (args?.v === undefined)) throw new ToolError("A mount needs both u and v.");
  const plane = args?.u && args.v ? { u: args.u as unknown as [number, number, number], v: args.v as unknown as [number, number, number] } : undefined;
  const cell = result.structure.cell;
  if (plane && !file && !mountable(cell, plane)) throw new ToolError(`u (${hklText(plane.u)}) and v (${hklText(plane.v)}) are parallel (or zero) in this cell; choose two independent vectors.`);
  const matches = file ? cellMatches(cell, file.UB, result.structure.rotations) : [];
  if (args?.cell_match !== undefined && args.cell_match >= Math.max(1, matches.length))
    throw new ToolError(matches.length ? `cell_match ${args.cell_match}: only ${matches.length} cell matches fit (0–${matches.length - 1}).` : "cell_match applies to a UB whose cell matches the structure's; none does.");
  const ub: UbState = {
    ...(file ? { UB: file.UB, fileName: file.fileName } : {}),
    warnings: file?.warnings ?? [],
    ...(plane ? { plane } : {}),
    ...(args?.cell_match !== undefined ? { choice: matches[args.cell_match]!.P } : {}),
  };
  const view = viewOrientation(result, ub);
  const warnings = [...(file?.warnings ?? [])];
  let description = orientationText(ub, !!file);
  if (file && view.match) description += `; the UB is for ${matchSummary(view.match, matches.indexOf(view.match)).ub_cell} and is used in the CIF cell`;
  if (file && !view.match) warnings.push("The UB cell does not match the CIF cell, a supercell of it or a smaller cell of it (within 2 %): the UB is used as loaded, so CIF indices may not be the UB's. transform_ub can re-index it.");
  if (file && plane) warnings.push("With a UB, u and v do not change the orientation.");
  return { UB: view.viewUB, description, ...(file ? { fileUB: file.UB } : {}), ...(view.match ? { match: view.match } : {}), matches, warnings };
}
