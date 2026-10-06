/**
 * Exact crystallographic symmetry operations x' = R·x + t.
 *
 * R is an integer matrix and t is stored as integer numerators over 24 (the
 * denominator gemmi uses), reduced mod 24. Every operation from a CIF is parsed
 * by a strict grammar; text is never evaluated as code. A translation must be a
 * multiple of 1/24: a fraction that is not is rejected, and a decimal is snapped
 * to the nearest k/24 only when it lies within 1e-4 of it (0.3333 → 1/3).
 */

export const TDEN = 24;

export type IntMat3 = readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];
export type IntVec3 = readonly [number, number, number];

export interface SymOp {
  /** Rotation part, rows act on column vector x. */
  readonly R: IntMat3;
  /** Translation numerators over TDEN, each in [0, TDEN). */
  readonly t: IntVec3;
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;

export function makeOp(R: IntMat3, t: IntVec3): SymOp {
  return { R, t: [mod(t[0], TDEN), mod(t[1], TDEN), mod(t[2], TDEN)] };
}

export const IDENTITY: SymOp = makeOp(
  [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  [0, 0, 0],
);

export class SymOpParseError extends Error {}

/** Decimals such as 0.3333 or 0.6667 denote k/24 when within this distance; fractions must be exact. */
const DECIMAL_TOL = 1e-4;

/** Parse a translation constant: integer, fraction p/q, or decimal; must be a multiple of 1/24. */
function parseConstant(text: string, source: string): number {
  let value: number;
  let tol = 1e-9;
  const frac = /^(\d+)\/(\d+)$/.exec(text);
  if (frac) {
    const den = Number(frac[2]);
    if (den === 0) throw new SymOpParseError(`Zero denominator in '${source}'`);
    value = Number(frac[1]) / den;
  } else if (/^(\d+\.?\d*|\.\d+)$/.test(text)) {
    value = Number(text);
    tol = DECIMAL_TOL;
  }
  else throw new SymOpParseError(`Unrecognized term '${text}' in '${source}'`);
  const n = value * TDEN;
  const rounded = Math.round(n);
  if (Math.abs(n - rounded) > tol * TDEN) {
    throw new SymOpParseError(`Translation ${text} in '${source}' is not a multiple of 1/${TDEN}`);
  }
  return rounded;
}

/**
 * Parse a Jones-Faithful triplet such as `-x+1/2, y, z+1/4`, `x-y,x,z+1/6`,
 * `1/2+X,1/2-Y,-Z` or `x+0.5,-y,z`. Case and whitespace are ignored; quotes are
 * stripped. Coefficients of x, y, z must be integers.
 */
export function parseSymOp(source: string): SymOp {
  const text = source.trim().replace(/^['"]|['"]$/g, "").replace(/\s+/g, "").toLowerCase();
  const parts = text.split(",");
  if (parts.length !== 3) throw new SymOpParseError(`Expected 3 components in '${source}'`);
  const R: number[][] = [];
  const t: number[] = [];
  for (const part of parts) {
    if (part === "") throw new SymOpParseError(`Empty component in '${source}'`);
    const row = [0, 0, 0];
    let tr = 0;
    // Split into signed terms: "+x", "-1/2", "2y", "+0.5".
    const terms = part.match(/[+-]?[^+-]+/g);
    if (!terms || terms.join("") !== part) throw new SymOpParseError(`Cannot split '${part}' in '${source}'`);
    for (const term of terms) {
      const sign = term.startsWith("-") ? -1 : 1;
      const body = term.replace(/^[+-]/, "");
      const m = /^(\d*)\*?([xyz])$/.exec(body) ?? /^([xyz])$/.exec(body);
      if (m) {
        const axisChar = m.length === 3 ? m[2]! : m[1]!;
        const coef = m.length === 3 && m[1] !== "" ? Number(m[1]) : 1;
        row["xyz".indexOf(axisChar)]! += sign * coef;
      } else tr += sign * parseConstant(body, source);
    }
    R.push(row);
    t.push(tr);
  }
  const op = makeOp(R as unknown as IntMat3, t as unknown as IntVec3);
  const det = determinant(op.R);
  if (det !== 1 && det !== -1) throw new SymOpParseError(`Operation '${source}' has det(R) = ${det}, not ±1`);
  return op;
}

export function determinant(R: IntMat3): number {
  return (
    R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) -
    R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) +
    R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0])
  );
}

/** a ∘ b: apply b first, then a. */
export function compose(a: SymOp, b: SymOp): SymOp {
  const R: number[][] = [0, 1, 2].map((i) => [0, 1, 2].map((j) => a.R[i]![0] * b.R[0]![j]! + a.R[i]![1] * b.R[1]![j]! + a.R[i]![2] * b.R[2]![j]!));
  const t = [0, 1, 2].map((i) => a.R[i]![0] * b.t[0] + a.R[i]![1] * b.t[1] + a.R[i]![2] * b.t[2] + a.t[i]!);
  return makeOp(R as unknown as IntMat3, t as unknown as IntVec3);
}

export function opKey(op: SymOp): string {
  return `${op.R.flat().join(",")};${op.t.join(",")}`;
}

/** Canonical triplet, e.g. `-x+1/2,y,z+1/4` (translations reduced to [0,1)). */
export function formatSymOp(op: SymOp): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  return [0, 1, 2]
    .map((i) => {
      let s = "";
      op.R[i]!.forEach((c, j) => {
        if (c === 0) return;
        const v = "xyz"[j]!;
        s += c === 1 ? `+${v}` : c === -1 ? `-${v}` : `${c > 0 ? "+" : ""}${c}${v}`;
      });
      const n = op.t[i]!;
      if (n !== 0) {
        const g = gcd(n, TDEN);
        s += `+${n / g}/${TDEN / g}`;
      }
      return s.replace(/^\+/, "") || "0";
    })
    .join(",");
}

/** Apply to fractional coordinates (no wrapping). */
export function applyOp(op: SymOp, x: readonly [number, number, number]): [number, number, number] {
  return [0, 1, 2].map((i) => op.R[i]![0] * x[0] + op.R[i]![1] * x[1] + op.R[i]![2] * x[2] + op.t[i]! / TDEN) as [number, number, number];
}

/**
 * Group closure modulo lattice translations. Throws if the closure exceeds
 * `maxOrder` (192 is the largest crystallographic space-group order per
 * conventional cell; 384 leaves headroom for non-standard centred settings).
 */
export function closeGroup(ops: readonly SymOp[], maxOrder = 384): SymOp[] {
  const seen = new Map<string, SymOp>();
  const queue: SymOp[] = [IDENTITY, ...ops];
  for (const op of queue) {
    const k = opKey(op);
    if (!seen.has(k)) seen.set(k, op);
  }
  let frontier = [...seen.values()];
  while (frontier.length) {
    const next: SymOp[] = [];
    const current = [...seen.values()];
    for (const a of frontier) {
      for (const b of current) {
        for (const c of [compose(a, b), compose(b, a)]) {
          const k = opKey(c);
          if (!seen.has(k)) {
            seen.set(k, c);
            next.push(c);
            if (seen.size > maxOrder) throw new Error(`Symmetry closure exceeds ${maxOrder} operations; the operation list is not a space group`);
          }
        }
      }
    }
    frontier = next;
  }
  return [...seen.values()];
}

export function sameOpSet(a: readonly SymOp[], b: readonly SymOp[]): boolean {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map(opKey));
  return b.every((op) => keys.has(opKey(op)));
}

/**
 * Systematic absence, exactly: h is absent iff some operation has hᵀR = hᵀ and
 * h·t ∉ ℤ. With t in 24ths this is integer arithmetic. The list must be the
 * full group including centring translations.
 */
export function isSystematicallyAbsent(ops: readonly SymOp[], h: IntVec3): boolean {
  for (const op of ops) {
    const R = op.R;
    if (
      h[0] * R[0][0] + h[1] * R[1][0] + h[2] * R[2][0] === h[0] &&
      h[0] * R[0][1] + h[1] * R[1][1] + h[2] * R[2][1] === h[1] &&
      h[0] * R[0][2] + h[1] * R[1][2] + h[2] * R[2][2] === h[2] &&
      mod(h[0] * op.t[0] + h[1] * op.t[1] + h[2] * op.t[2], TDEN) !== 0
    ) {
      return true;
    }
  }
  return false;
}

/** Pure translations (R = I) in the group: lattice centring vectors, including 0. */
export function centringVectors(ops: readonly SymOp[]): IntVec3[] {
  return ops.filter((op) => op.R.every((row, i) => row.every((v, j) => v === (i === j ? 1 : 0)))).map((op) => op.t);
}

export function hasInversion(ops: readonly SymOp[]): boolean {
  return ops.some((op) => op.R.every((row, i) => row.every((v, j) => v === (i === j ? -1 : 0))));
}

/**
 * The proper rotations of the Laue group: each rotation part R, or −R when R is improper, once each.
 * Two cell choices P and W·P (W among these) index the reflections alike, up to symmetry and Friedel's law.
 */
export function laueRotations(ops: readonly SymOp[]): IntMat3[] {
  const out = new Map<string, IntMat3>();
  for (const op of ops) {
    const s = determinant(op.R) > 0 ? 1 : -1;
    const W = op.R.map((row) => row.map((v) => s * v + 0)) as unknown as IntMat3;
    out.set(W.flat().join(","), W);
  }
  return [...out.values()];
}
