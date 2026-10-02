/**
 * ISAW UB-matrix files, read and written exactly as Mantid's LoadIsawUB /
 * SaveIsawUB do (mantid @ 67c2f43, Framework/Crystal/src/{Load,Save}IsawUB.cpp):
 *
 *   lines 1–3  the TRANSPOSE of UB, one reciprocal basis vector per line, with
 *              the components in the IPNS frame (x = beam, y = back, z = up):
 *              line i = ( UB_M[z][i], UB_M[x][i], UB_M[y][i] )
 *              where UB_M is UB in Mantid's frame (z = beam, y = up, x = y × z).
 *   [ModUB:]   optional modulation block (3 lines) — read and reported, not used.
 *   next line  a b c α β γ V (informational; the lattice is derived from UB)
 *   next line  their uncertainties
 *   then       comment text.
 *
 * |q| = 1/d (no 2π). The frame map is a cyclic permutation, so handedness is kept.
 */
import type { Mat3 } from "@materia/core/math/types";
import { latticeFromUB } from "../core/ub/ub.ts";

/** IPNS file column j holds Mantid component PERM[j]: (beam=z, back=x, up=y). */
const PERM = [2, 0, 1] as const;

export interface IsawUBFile {
  /** UB in Mantid's sample frame (q = UB·h, 1/Å, no 2π). */
  readonly UB: Mat3;
  /** Lattice line as written in the file: a b c α β γ V. */
  readonly latticeLine?: readonly number[];
  /** Uncertainty line as written in the file. */
  readonly errorLine?: readonly number[];
  readonly modulated: boolean;
  readonly warnings: readonly string[];
}

export class IsawParseError extends Error {}

function numbersOf(line: string): number[] | undefined {
  const parts = line.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  const nums = parts.map(Number);
  return nums.every((n) => Number.isFinite(n)) ? nums : undefined;
}

export function parseIsawUB(text: string): IsawUBFile {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const warnings: string[] = [];
  let i = 0;
  const F: number[][] = [];
  while (F.length < 3) {
    if (i >= lines.length) throw new IsawParseError(`Expected 3 lines of UB numbers, found ${F.length}.`);
    const line = lines[i++]!;
    if (line.trim() === "") continue;
    const nums = numbersOf(line);
    if (!nums || nums.length < 3) throw new IsawParseError(`Line ${i}: expected three numbers for a UB row, got '${line.trim()}'.`);
    F.push(nums.slice(0, 3));
  }
  let modulated = false;
  // Optional "ModUB:" block.
  while (i < lines.length && lines[i]!.trim() === "") i++;
  if (i < lines.length && /^\s*ModUB/i.test(lines[i]!)) {
    modulated = true;
    i += 4;
    warnings.push("The file has a ModUB block (modulated structure); modulation vectors are not used.");
  }
  while (i < lines.length && lines[i]!.trim() === "") i++;
  const latticeLine = i < lines.length ? numbersOf(lines[i]!) : undefined;
  if (latticeLine) i++;
  const errorLine = i < lines.length ? numbersOf(lines[i]!) : undefined;
  const UB: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let basis = 0; basis < 3; basis++) for (let j = 0; j < 3; j++) UB[PERM[j]!]![basis] = F[basis]![j]!;
  const ub = UB as unknown as Mat3;
  if (latticeLine && latticeLine.length >= 6) {
    const lat = latticeFromUB(ub);
    const got = [lat.a, lat.b, lat.c, lat.alpha, lat.beta, lat.gamma];
    const worst = Math.max(...got.map((v, k) => Math.abs(v - latticeLine[k]!)));
    // The lattice line is printed with 4 decimals; UB rows with 8.
    if (worst > 2e-3) warnings.push(`The lattice line in the file differs from the lattice implied by UB by up to ${worst.toFixed(4)}; the UB values are used.`);
  } else warnings.push("The file has no lattice line; the lattice is derived from UB alone.");
  return { UB: ub, ...(latticeLine ? { latticeLine } : {}), ...(errorLine ? { errorLine } : {}), modulated, warnings };
}

const f8 = (x: number, w: number) => x.toFixed(8).padStart(w);
const f4 = (x: number, w: number) => x.toFixed(4).padStart(w);

/** Write UB (Mantid sample frame) in the SaveIsawUB layout. */
export function formatIsawUB(UB: Mat3, errors: readonly number[] = [0, 0, 0, 0, 0, 0, 0]): string {
  const out: string[] = [];
  for (let basis = 0; basis < 3; basis++) {
    out.push(`${f8(UB[2][basis]!, 11)}${f8(UB[0][basis]!, 12)}${f8(UB[1][basis]!, 12)} `);
  }
  const lat = latticeFromUB(UB);
  const vals = [lat.a, lat.b, lat.c, lat.alpha, lat.beta, lat.gamma, lat.volume];
  out.push(vals.map((v, k) => f4(v, k === 0 ? 11 : 12)).join("") + " ");
  out.push(errors.map((v, k) => f4(v, k === 0 ? 11 : 12)).join("") + " ");
  out.push("");
  out.push("The above matrix is the Transpose of the UB Matrix. The UB matrix maps the column");
  out.push("vector (h,k,l ) to the column vector (q'x,q'y,q'z).");
  out.push("|Q'|=1/dspacing and its coordinates are a right-hand coordinate system where");
  out.push(" x is the beam direction and z is vertically upward.(IPNS convention)");
  return out.join("\n") + "\n";
}
