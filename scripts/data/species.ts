/**
 * Canonical X-ray species labels. Sources spell ions differently (`Fe2+`, `Fe+2`,
 * `Ru+4`, `O2-.`) and add non-atomic pseudo-species (`Cval`, `Sival`, `Hiso`, `H.`).
 * Canonical form: element symbol, then `<n>+` / `<n>-` for ions, e.g. `Fe2+`, `O1-`.
 */
import { ELEMENT_SYMBOLS, atomicNumber } from "./elements.ts";

export interface SpeciesLabel {
  readonly element: string;
  readonly z: number;
  readonly charge: number;
  /** Trailing qualifier such as "val", "iso", "." (non-standard pseudo-species), else "". */
  readonly qualifier: string;
}

const ELEMENTS = new Set(ELEMENT_SYMBOLS.filter((s) => s !== ""));

export function parseSpeciesLabel(label: string): SpeciesLabel {
  let element: string;
  if (label.length >= 2 && ELEMENTS.has(label.slice(0, 2))) element = label.slice(0, 2);
  else if (ELEMENTS.has(label.slice(0, 1))) element = label.slice(0, 1);
  else throw new Error(`No element symbol at start of '${label}'`);
  let rest = label.slice(element.length);
  let charge = 0;
  const m = /^(?:(\d+)([+-])|([+-])(\d+)|([+-]))/.exec(rest);
  if (m) {
    if (m[1] !== undefined) charge = Number(m[1]) * (m[2] === "-" ? -1 : 1);
    else if (m[3] !== undefined) charge = Number(m[4]) * (m[3] === "-" ? -1 : 1);
    else charge = m[5] === "-" ? -1 : 1;
    rest = rest.slice(m[0].length);
  }
  return { element, z: atomicNumber(element), charge, qualifier: rest };
}

export function canonicalSpecies(s: { element: string; charge: number }): string {
  if (s.charge === 0) return s.element;
  return `${s.element}${Math.abs(s.charge)}${s.charge > 0 ? "+" : "-"}`;
}
