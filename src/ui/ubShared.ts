/** Orientation shared by the UB and Instrument pages: the loaded UB mapped to the CIF setting. */
import { useMemo } from "react";
import { dSpacing } from "@materia/core/crystal/unitCell";
import type { Mat3 } from "@materia/core/math/types";
import type { CalcSuccess } from "../app/compute.ts";
import { findBasisMatch, ubFromU, type BasisMatch } from "../core/ub/ub.ts";
import { fmt, hklText } from "./format.ts";

export interface UbState {
  /** UB as loaded or built (Mantid sample frame, q = UB·h, 1/Å, no 2π). */
  readonly UB?: Mat3;
  readonly fileName?: string;
  readonly warnings: readonly string[];
}

const IDENTITY: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** UB for CIF indices: the file UB in the CIF setting when it matches, else U = I with the CIF cell. */
export function useViewUB(result: CalcSuccess, ub: UbState): { viewUB: Mat3; match?: BasisMatch; fileUB?: Mat3 } {
  const cifCell = result.structure.cell;
  const fileUB = ub.UB;
  const match = useMemo(() => (fileUB ? findBasisMatch(cifCell, fileUB) : undefined), [fileUB, cifCell]);
  const viewUB = useMemo(() => (fileUB ? (match ? match.ubForCif : fileUB) : ubFromU(IDENTITY, cifCell)), [fileUB, match, cifCell]);
  return { viewUB, ...(match ? { match } : {}), ...(fileUB ? { fileUB } : {}) };
}

/** How many present reflections the single-crystal pages simulate (strongest first). */
export const PRESENT_CAP = 6000;

/** Present reflections (strongest first, capped) with their symmetry families. */
export function presentReflections(result: CalcSuccess, max = PRESENT_CAP) {
  const r = result.reflections;
  const idx: number[] = [];
  for (let i = 0; i < r.h.length; i++) if (r.cls[i] === 0) idx.push(i);
  idx.sort((a, b) => r.f2[b]! - r.f2[a]!);
  return idx.slice(0, max).map((i) => ({ h: [r.h[i]!, r.k[i]!, r.l[i]!] as [number, number, number], f2: r.f2[i]!, d: r.d[i]!, family: r.family[i]! }));
}

/** Why a typed hkl is not among the simulated reflections, by kind, with what a notice needs to say it. */
export interface HklMiss {
  readonly kind: "input" | "origin" | "systematic" | "accidental" | "cap" | "weak" | "dmin" | "missing";
  readonly message: string;
  /** The indices, once the text parses. */
  readonly hkl?: readonly [number, number, number];
  /** "dmin": the reflection's spacing, the d_min it was calculated to, and the present count and cap then. */
  readonly d?: number;
  readonly dMin?: number;
  readonly present?: number;
  readonly cap?: number;
}

/**
 * Explains a typed hkl that a page could not select: not three integers, (000), absent
 * (systematic or accidental), past the simulated cap, or beyond d_min. `cap` is the
 * number of present reflections the page simulates, when it caps them.
 */
export function hklMiss(result: CalcSuccess, text: string, cap?: number): HklMiss {
  const v = text.trim().split(/[\s,]+/).map(Number);
  if (v.length !== 3 || v.some((x) => !Number.isInteger(x))) return { kind: "input", message: "Type h k l as three integers, e.g. 4 0 0." };
  const hkl = v as unknown as readonly [number, number, number];
  const [h, k, l] = hkl;
  const name = `(${hklText(v)})`;
  if (h === 0 && k === 0 && l === 0) return { kind: "origin", hkl, message: "(0 0 0) is the direct beam, not a reflection." };
  const r = result.reflections;
  let present = 0;
  let cls = -1;
  for (let i = 0; i < r.h.length; i++) {
    if (r.cls[i] === 0) present++;
    if (r.h[i] === h && r.k[i] === k && r.l[i] === l) cls = r.cls[i]!;
  }
  const s = result.structure;
  if (cls === 1) return { kind: "systematic", hkl, message: `${name} is systematically absent${s.setting ? ` in ${s.setting}` : ""}: |F| = 0 by symmetry.` };
  if (cls === 2) return { kind: "accidental", hkl, message: `${name} is allowed by the space group but |F| ≈ 0 for this structure (an accidental absence).` };
  if (cls === 0)
    return cap !== undefined && present > cap
      ? { kind: "cap", hkl, message: `${name} is present but weaker than the ${cap.toLocaleString("en-US")} strongest reflections simulated here.` }
      : { kind: "weak", hkl, message: `${name} is present but too weak to draw.` };
  const d = dSpacing(s.cell, h, k, l);
  const dMin = result.provenance.dMin;
  if (d < dMin) return { kind: "dmin", hkl, d, dMin, present, ...(cap !== undefined ? { cap } : {}), message: `${name} has d = ${fmt(d, 4)} Å, below d_min = ${dMin} Å, so it is not calculated.` };
  return { kind: "missing", hkl, message: `${name} is not among the calculated reflections.` };
}

/**
 * Present reflections expected if a "dmin" miss is calculated down to `dMin`, as the list grows as 1/d³.
 * Rough and low: a first list of a few hundred has not reached the asymptotic count (spinel from 0.8 Å:
 * 5–8 % low at 0.6–0.3 Å; 8,883 for 9,570 at 0.38 Å), so callers leave a margin below any limit.
 */
export function presentAfter(miss: HklMiss, dMin: number): number | undefined {
  return miss.present !== undefined && miss.dMin !== undefined ? miss.present * (miss.dMin / dMin) ** 3 : undefined;
}
