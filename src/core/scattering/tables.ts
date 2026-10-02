/**
 * Scattering amplitudes from the generated, cross-checked tables in src/data.
 *
 * X-ray: Waasmaier & Kirfel (1995) non-resonant f0, valid 0 ≤ s ≤ 6 Å⁻¹.
 * Neutron: Sears (1992) bound coherent b, stored exactly as printed
 * (b = b' − i b''); `amplitude` returns conj(b) for the crystallographic
 * structure factor F = Σ a·exp(+2πi h·x) (docs/CONVENTIONS.md §5).
 *
 * Unknown or unusable species throw; nothing falls back silently.
 */
import neutronTable from "../../data/neutron-sears1992.json";
import xrayTable from "../../data/xray-f0-wk1995.json";
import type { Species } from "./species.ts";
import { speciesKey } from "./species.ts";

export type Tier = "certified" | "crosschecked" | "discrepant" | "unresolved" | "unavailable";

export interface XrayRow {
  readonly id: string;
  readonly element: string;
  readonly z: number;
  readonly charge: number;
  readonly a: readonly number[];
  readonly b: readonly number[];
  readonly c: number;
  readonly status: Tier;
  readonly notes?: readonly string[];
}

export interface NeutronRow {
  readonly id: string;
  readonly element: string;
  readonly z: number;
  readonly mass?: number;
  readonly kind: "natural-element" | "isotope" | "element-row-radioactive";
  readonly abundance?: number;
  readonly bCoh?: { readonly re: number; readonly im: number; readonly reSu?: number; readonly raw: string };
  readonly complex: boolean;
  readonly status: Tier;
  readonly problems?: readonly string[];
  readonly checks: Readonly<Record<string, string>>;
}

export const XRAY_DATASET = { id: xrayTable.dataset, version: xrayTable.version, citation: xrayTable.citation, sMax: xrayTable.domain.sMax };
export const NEUTRON_DATASET = { id: neutronTable.dataset, version: neutronTable.version, citation: neutronTable.citation };

const XRAY_ROWS = new Map((xrayTable.species as XrayRow[]).map((r) => [r.id, r]));
const NEUTRON_ROWS = new Map((neutronTable.entries as NeutronRow[]).map((r) => [r.id, r]));

export class ScatteringLookupError extends Error {}

/** Evaluate f0 for a WK row. Throws outside the fitted domain 0 ≤ s ≤ 6 Å⁻¹. */
export function f0(row: XrayRow, s: number): number {
  if (!(s >= 0 && s <= XRAY_DATASET.sMax + 1e-12)) {
    throw new ScatteringLookupError(`s = ${s} Å⁻¹ is outside the Waasmaier–Kirfel domain 0–${XRAY_DATASET.sMax} Å⁻¹ (d < ${(1 / (2 * XRAY_DATASET.sMax)).toFixed(4)} Å)`);
  }
  const s2 = s * s;
  let f = row.c;
  for (let i = 0; i < row.a.length; i++) f += row.a[i]! * Math.exp(-row.b[i]! * s2);
  return f;
}

export interface XrayChoice {
  readonly row: XrayRow;
  readonly note?: string;
}

/**
 * X-ray row for a species. An ion needs its own row; with `ionFallback:
 * "neutral"` a missing ion uses the neutral atom and says so.
 */
export function xrayRow(sp: Species, opts: { ionFallback?: "error" | "neutral" } = {}): XrayChoice {
  const ion = sp.charge === 0 ? sp.element : `${sp.element}${Math.abs(sp.charge)}${sp.charge > 0 ? "+" : "-"}`;
  const row = XRAY_ROWS.get(ion);
  if (row) return { row };
  if (sp.charge !== 0 && opts.ionFallback === "neutral") {
    const neutral = XRAY_ROWS.get(sp.element);
    if (neutral) return { row: neutral, note: `No Waasmaier–Kirfel row for ${ion}; neutral ${sp.element} used as chosen.` };
  }
  if (sp.charge !== 0) {
    throw new ScatteringLookupError(`No Waasmaier–Kirfel X-ray form factor for ${ion}. Use the neutral atom explicitly or change the type symbol.`);
  }
  throw new ScatteringLookupError(`No Waasmaier–Kirfel X-ray form factor for ${sp.element}.`);
}

export function xrayIonsFor(element: string): string[] {
  return [...XRAY_ROWS.values()].filter((r) => r.element === element).map((r) => r.id);
}

export interface NeutronChoice {
  readonly row: NeutronRow;
  /** b as printed by Sears (b' − i b''), fm. */
  readonly b: { readonly re: number; readonly im: number };
  readonly warnings: readonly string[];
}

/**
 * Neutron coherent b for a species. A named isotope uses that isotope's row;
 * otherwise the natural-element row. Ionic charge does not affect nuclear b.
 */
export function neutronB(sp: Species, opts: { validatedOnly?: boolean } = {}): NeutronChoice {
  const id = sp.isotope !== undefined ? `${sp.isotope}${sp.element}` : sp.element;
  const row = NEUTRON_ROWS.get(id);
  if (!row) {
    throw new ScatteringLookupError(
      sp.isotope !== undefined ? `No Sears (1992) entry for the isotope ${id}.` : `No Sears (1992) natural-element entry for ${sp.element}.`,
    );
  }
  if (row.status === "unavailable" || !row.bCoh) {
    throw new ScatteringLookupError(`Sears (1992) gives no coherent scattering length for ${id}${row.kind === "natural-element" ? "; choose a specific isotope" : ""}.`);
  }
  if (row.status === "unresolved") {
    throw new ScatteringLookupError(`The ${id} row is ambiguous (${row.problems?.join("; ")}); choose a specific isotope.`);
  }
  if (opts.validatedOnly && row.status !== "certified") {
    throw new ScatteringLookupError(`${id} is '${row.status}', not certified; validated mode accepts certified rows only.`);
  }
  const warnings: string[] = [];
  if (row.status === "discrepant") warnings.push(`${id}: table row is discrepant (${row.problems?.join("; ")}).`);
  if (row.complex) warnings.push(`${id}: complex b = ${row.bCoh.raw} fm (absorbing nucleus); valid near 2200 m/s (λ ≈ 1.8 Å) only.`);
  return { row, b: { re: row.bCoh.re, im: row.bCoh.im }, warnings };
}

export function neutronIsotopesFor(element: string): NeutronRow[] {
  return [...NEUTRON_ROWS.values()].filter((r) => r.element === element && r.kind === "isotope");
}

export type Radiation = { readonly kind: "xray"; readonly ionFallback?: "error" | "neutral" } | { readonly kind: "neutron"; readonly validatedOnly?: boolean };

/** A per-site scattering amplitude a(s) in the crystallographic convention. */
export interface Amplitude {
  readonly key: string;
  readonly tier: Tier;
  readonly source: string;
  readonly warnings: readonly string[];
  /** Complex amplitude at s = sinθ/λ (Å⁻¹): electrons (X-ray) or fm (neutron). */
  readonly at: (s: number) => { re: number; im: number };
}

export function amplitudeFor(sp: Species, radiation: Radiation): Amplitude {
  if (radiation.kind === "xray") {
    const choice = xrayRow(sp, { ionFallback: radiation.ionFallback ?? "error" });
    const row = choice.row;
    return {
      key: `x:${row.id}`,
      tier: row.status,
      source: `WK1995 ${row.id}`,
      warnings: choice.note ? [choice.note] : [],
      at: (s) => ({ re: f0(row, s), im: 0 }),
    };
  }
  const choice = neutronB(sp, radiation.validatedOnly ? { validatedOnly: true } : {});
  // Crystallographic convention: conj(b_Sears) = b' + i b''.
  const a = { re: choice.b.re, im: -choice.b.im };
  return {
    key: `n:${choice.row.id}`,
    tier: choice.row.status,
    source: `Sears1992 ${choice.row.id}${sp.charge ? ` (charge ${speciesKey(sp)} ignored for nuclear b)` : ""}`,
    warnings: choice.warnings,
    at: () => a,
  };
}
