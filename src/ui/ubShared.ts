/** Orientation shared by the UB and Instrument pages: the loaded UB mapped to the CIF setting. */
import { useMemo } from "react";
import type { Mat3 } from "@materia/core/math/types";
import type { CalcSuccess } from "../app/compute.ts";
import { findBasisMatch, ubFromU, type BasisMatch } from "../core/ub/ub.ts";

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

/** Present reflections (strongest first, capped) with their symmetry families. */
export function presentReflections(result: CalcSuccess, max = 6000) {
  const r = result.reflections;
  const idx: number[] = [];
  for (let i = 0; i < r.h.length; i++) if (r.cls[i] === 0) idx.push(i);
  idx.sort((a, b) => r.f2[b]! - r.f2[a]!);
  return idx.slice(0, max).map((i) => ({ h: [r.h[i]!, r.k[i]!, r.l[i]!] as [number, number, number], f2: r.f2[i]!, d: r.d[i]!, family: r.family[i]! }));
}
