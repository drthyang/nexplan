/** Orientation shared by the UB and Instrument pages: the loaded UB mapped to the CIF setting. */
import { useMemo } from "react";
import { dSpacing } from "@materia/core/crystal/unitCell";
import type { Mat3 } from "@materia/core/math/types";
import type { CalcSuccess } from "../app/compute.ts";
import { isPlane, mountable, mountUB, type ScatteringPlane } from "../core/ub/mount.ts";
import { findCellMatches, ubFromU, type BasisMatch } from "../core/ub/ub.ts";
import { fmt, hklText } from "./format.ts";

export interface UbState {
  /** UB as loaded or built (Mantid sample frame, q = UB·h, 1/Å, no 2π). */
  readonly UB?: Mat3;
  readonly fileName?: string;
  readonly warnings: readonly string[];
  /** The chosen cell match's P when several fit; the best match is used when it is unset or no longer fits (another CIF). */
  readonly choice?: Mat3;
  /**
   * The scattering plane (u, v in r.l.u.). Without a UB file it sets the mount: U from u and v as Mantid's SetUB
   * (mount.ts). With a file it is only shown, where the file's UB puts it.
   */
  readonly plane?: ScatteringPlane;
}

/** The scattering plane, if the state holds a valid one (it may come from browser storage). */
export const planeOf = (ub: UbState): ScatteringPlane | undefined => (isPlane(ub.plane) ? ub.plane : undefined);

const IDENTITY: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/**
 * UB for CIF indices: the file UB in the CIF cell when the cells match (the same cell in another setting, a
 * supercell or a smaller cell; the chosen match when several fit), else the file UB as loaded. Without a file: the
 * CIF cell mounted in the chosen scattering plane (Mantid SetUB), or U = I when none is chosen.
 */
export function useViewUB(result: CalcSuccess, ub: UbState): { viewUB: Mat3; match?: BasisMatch; matches: readonly BasisMatch[]; fileUB?: Mat3 } {
  const cifCell = result.structure.cell;
  const rotations = result.structure.rotations;
  const fileUB = ub.UB;
  const matches = useMemo(() => (fileUB ? findCellMatches(cifCell, fileUB, { rotations }) : []), [fileUB, cifCell, rotations]);
  // A saved session's value is checked: anything but a 3 × 3 array of numbers means the best match.
  const chosen = ub.choice;
  const valid = Array.isArray(chosen) && chosen.length === 3 && chosen.every((r) => Array.isArray(r) && r.length === 3 && r.every((v) => typeof v === "number"));
  const match = (valid && matches.find((m) => m.P.every((r, i) => r.every((v, j) => Math.abs(v - chosen[i]![j]!) < 1e-9)))) || matches[0];
  // A plane the cell cannot mount (u and v parallel there) falls back to U = I rather than throwing.
  const planeIn = planeOf(ub);
  const plane = planeIn && mountable(cifCell, planeIn) ? planeIn : undefined;
  const planeKey = plane ? `${plane.u.join(",")};${plane.v.join(",")}` : "";
  const viewUB = useMemo(
    () => (fileUB ? (match ? match.ubForCif : fileUB) : plane ? mountUB(cifCell, plane) : ubFromU(IDENTITY, cifCell)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- planeKey is the plane's value
    [fileUB, match, cifCell, planeKey],
  );
  return { viewUB, matches, ...(match ? { match } : {}), ...(fileUB ? { fileUB } : {}) };
}

/** How the orientation in use was set, for notes and exported files: a UB file, a mount, or U = I. */
export function orientationText(ub: UbState, fromFile: boolean): string {
  if (fromFile) return `from ${ub.fileName ?? "the loaded UB"}`;
  const plane = planeOf(ub);
  return plane ? `no UB loaded: the CIF cell mounted with u (${hklText(plane.u)}) along the beam and v (${hklText(plane.v)}) horizontal at zero angles (Mantid SetUB)` : "no UB loaded: U = I with the CIF cell";
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

/**
 * A typed hkl the page could not select from its list, by kind, with what a notice needs to say it. Unless
 * the text is malformed or (0 0 0), its position can still be simulated on request (simulatable), as a
 * forbidden peak is sometimes measured on purpose: it can reveal an unreported phase.
 */
export interface HklMiss {
  readonly kind: "input" | "origin" | "systematic" | "accidental" | "cap" | "weak" | "dmin" | "missing";
  readonly message: string;
  /** The indices, once the text parses. */
  readonly hkl?: readonly [number, number, number];
  /** Its spacing from the cell, for any hkl but (0 0 0). */
  readonly d?: number;
  /** |F|² and symmetry family when the calculation has the hkl (absent ones included). */
  readonly f2?: number;
  readonly family?: number;
}

/** Whether the miss names a reflection whose position can be simulated (its geometry needs no |F|). */
export const simulatable = (m: HklMiss): boolean => m.kind !== "input" && m.kind !== "origin";

/**
 * Explains a typed hkl that a page could not select: not three integers, (000), forbidden (systematic
 * absence) or accidentally absent, past the listed cap, or beyond d_min. `cap` is the number of present
 * reflections the page lists, when it caps them.
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
  let at = -1;
  for (let i = 0; i < r.h.length; i++) {
    if (r.cls[i] === 0) present++;
    if (r.h[i] === h && r.k[i] === k && r.l[i] === l) at = i;
  }
  const s = result.structure;
  const d = dSpacing(s.cell, h, k, l);
  const found = at >= 0 ? { f2: r.f2[at]!, family: r.family[at]! } : {};
  const cls = at >= 0 ? r.cls[at]! : -1;
  if (cls === 1) return { kind: "systematic", hkl, d, ...found, message: `${name} is forbidden: systematically absent${s.setting ? ` in ${s.setting}` : ""} (|F| = 0 by symmetry).` };
  if (cls === 2) return { kind: "accidental", hkl, d, ...found, message: `${name} is allowed by the space group but |F| ≈ 0 for this structure (an accidental absence).` };
  if (cls === 0)
    return cap !== undefined && present > cap
      ? { kind: "cap", hkl, d, ...found, message: `${name} is present but weaker than the ${cap.toLocaleString("en-US")} strongest reflections listed here.` }
      : { kind: "weak", hkl, d, ...found, message: `${name} is present but its |F|² is negligible.` };
  const dMin = result.provenance.dMin;
  if (d < dMin) return { kind: "dmin", hkl, d, message: `${name} has d = ${fmt(d, 4)} Å, below d_min = ${dMin} Å, so its |F| is not calculated.` };
  return { kind: "missing", hkl, d, message: `${name} is not among the calculated reflections.` };
}

/** All hkl of one symmetry family in the calculation, absent ones included (the equivalents of a forbidden peak). */
export function familyMembers(result: CalcSuccess, family: number): [number, number, number][] {
  const r = result.reflections;
  const out: [number, number, number][] = [];
  for (let i = 0; i < r.h.length; i++) if (r.family[i] === family) out.push([r.h[i]!, r.k[i]!, r.l[i]!]);
  return out;
}
