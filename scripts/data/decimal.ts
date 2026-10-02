/**
 * Canonical decimal comparison for transcribed tables: `7.35730`, `7.3573` and
 * `7.3573E+00` are the same printed number; `3.0380001E-03` (a single-precision
 * rendering of 0.003038) is not, but agrees at float32 precision.
 */

export interface CanonicalDecimal {
  readonly sign: 1 | -1;
  /** Significant digits, no leading or trailing zeros ("" for zero). */
  readonly digits: string;
  /** Value = sign * 0.digits * 10^exponent. */
  readonly exponent: number;
}

export function canonicalDecimal(raw: string): CanonicalDecimal {
  const m = /^([-+])?(\d*)(?:\.(\d*))?(?:[eE]([-+]?\d+))?$/.exec(raw.trim());
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new Error(`Not a decimal: '${raw}'`);
  const sign = m[1] === "-" ? -1 : 1;
  const intPart = m[2] ?? "";
  const fracPart = m[3] ?? "";
  const exp = m[4] ? Number(m[4]) : 0;
  const all = intPart + fracPart;
  const lead = all.search(/[1-9]/);
  if (lead < 0) return { sign: 1, digits: "", exponent: 0 };
  const digits = all.slice(lead).replace(/0+$/, "");
  return { sign, digits, exponent: intPart.length - lead + exp };
}

export function sameDecimal(a: string, b: string): boolean {
  const x = canonicalDecimal(a);
  const y = canonicalDecimal(b);
  return x.sign === y.sign && x.digits === y.digits && x.exponent === y.exponent;
}

/** Value of half a unit in the last printed place, e.g. `7.357` → 0.0005. */
export function halfUlpPrinted(raw: string): number {
  const m = /^[-+]?(\d*)(?:\.(\d*))?(?:[eE]([-+]?\d+))?$/.exec(raw.trim());
  if (!m) throw new Error(`Not a decimal: '${raw}'`);
  const decimals = (m[2] ?? "").length;
  const exp = m[3] ? Number(m[3]) : 0;
  return 0.5 * 10 ** (exp - decimals);
}

export type Agreement = "identical" | "float32" | "different";

/** Compare two printed numbers: identical decimals, equal at float32 precision, or different. */
export function compareDecimals(a: string, b: string): Agreement {
  if (sameDecimal(a, b)) return "identical";
  if (Math.fround(Number(a)) === Math.fround(Number(b))) return "float32";
  return "different";
}
