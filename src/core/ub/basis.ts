/**
 * Change-of-basis helpers for (a′, b′, c′) = (a, b, c)·P (ITA convention; the
 * columns of P are the new axes in the old basis): standard transformations,
 * supercells, and P entries written as fractions.
 *
 * Standard P from International Tables for Crystallography Vol. A (2016),
 * Table 5.1.3.1 (centred cell → primitive; hexagonal R obverse → rhombohedral).
 */
import type { Mat3 } from "@materia/core/math/types";

export interface BasisPreset {
  readonly id: string;
  readonly label: string;
  readonly P: Mat3;
}

const h = 1 / 2;
const t = 1 / 3;

export const BASIS_PRESETS: readonly BasisPreset[] = [
  { id: "cycle", label: "Cycle axes: (c, a, b)", P: [[0, 1, 0], [0, 0, 1], [1, 0, 0]] },
  { id: "F-P", label: "F-centred → primitive: ((b+c)/2, (a+c)/2, (a+b)/2)", P: [[0, h, h], [h, 0, h], [h, h, 0]] },
  { id: "I-P", label: "I-centred → primitive: ((−a+b+c)/2, (a−b+c)/2, (a+b−c)/2)", P: [[-h, h, h], [h, -h, h], [h, h, -h]] },
  { id: "C-P", label: "C-centred → primitive: ((a−b)/2, (a+b)/2, c)", P: [[h, h, 0], [-h, h, 0], [0, 0, 1]] },
  { id: "R-hex-rh", label: "Hexagonal R (obverse) → rhombohedral", P: [[2 * t, -t, -t], [t, t, -2 * t], [t, t, t]] },
  { id: "sqrt2", label: "√2 × √2 × 1: (a+b, −a+b, c)", P: [[1, -1, 0], [1, 1, 0], [0, 0, 1]] },
];

/** P = diag(na, nb, nc): an na × nb × nc supercell. */
export function supercell(na: number, nb: number, nc: number): Mat3 {
  return [
    [na, 0, 0],
    [0, nb, 0],
    [0, 0, nc],
  ];
}

/** A number written as an integer, decimal or fraction ("1/2", "-1/3", "0.5"); undefined if it is not one. */
export function parseRatio(text: string): number | undefined {
  const s = text.trim().replace(/−/g, "-");
  const frac = /^([+-]?\d+(?:\.\d*)?)\s*\/\s*(\d+(?:\.\d*)?)$/.exec(s);
  if (frac) {
    const den = Number(frac[2]);
    return den === 0 ? undefined : Number(frac[1]) / den;
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return undefined;
  const v = Number(s);
  return Number.isFinite(v) ? v : undefined;
}

/** Display: simple fractions (denominator ≤ 12) as "n/d", other values to 6 significant figures. */
export function ratioText(v: number): string {
  for (let den = 1; den <= 12; den++) {
    const num = Math.round(v * den);
    if (Math.abs(v * den - num) < 1e-9) return den === 1 ? String(num) : `${num}/${den}`;
  }
  return String(Number(v.toPrecision(6)));
}
