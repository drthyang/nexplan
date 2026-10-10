/**
 * The Laue group acting on Miller indices, for symmetrising reciprocal-space volumes.
 *
 * A space-group operation (R, t) takes reflection h (a row vector) to hᵀR (CONVENTIONS §3), so on column vectors
 * h′ = Rᵀ·h. Friedel's law adds the inversion, so the Laue group on indices is {±Rᵀ}. Each matrix M is written as a
 * triplet giving (h′, k′, l′) = M·(h, k, l), e.g. "h+k,-h,l", as the NeXus Viewer (js/symmetry.js parseOp,
 * formatOp) and NEBULA3D (symmetry.py parse_symmetry_ops) read them.
 *
 * Laue classes are named from the group's order and its highest rotation order (orders 8, 12 and 24 each hold two
 * classes, told apart by a 4- or 6-fold axis); the axis-specific names (2/m with b or c unique, −3m1 or −31m) come
 * from matching the NeXus Viewer's presets, which are in their standard settings.
 */
import { centringVectors, TDEN, type IntMat3, type SymOp } from "./ops.ts";

const key = (m: IntMat3) => m.flat().join(",");

const mul = (a: IntMat3, b: IntMat3): IntMat3 => [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[i]![0] * b[0]![j]! + a[i]![1] * b[1]![j]! + a[i]![2] * b[2]![j]!)) as unknown as IntMat3;

const det = (m: IntMat3) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);

/** The Laue group on Miller indices: ±Rᵀ for every rotation part R of the space group, each once. */
export function laueGroupHkl(ops: readonly SymOp[]): IntMat3[] {
  const out = new Map<string, IntMat3>();
  for (const op of ops)
    for (const s of [1, -1]) {
      const M = [0, 1, 2].map((i) => [0, 1, 2].map((j) => s * op.R[j]![i]! + 0)) as unknown as IntMat3;
      out.set(key(M), M);
    }
  return [...out.values()];
}

/** "h+k,-h,l": (h′, k′, l′) = M·(h, k, l), formatted as the NeXus Viewer's formatOp. */
export function formatHklOp(M: IntMat3): string {
  return M.map((row) => {
    let s = "";
    row.forEach((c, j) => {
      if (!c) return;
      const mag = Math.abs(c) === 1 ? "" : String(Math.abs(c));
      s += (c < 0 ? "-" : s ? "+" : "") + mag + "hkl"[j];
    });
    return s || "0";
  }).join(",");
}

/** The matrix of an hkl triplet ("h+k,-h,l"). */
export function parseHklOp(text: string): IntMat3 {
  const parts = text.replace(/\s+/g, "").toLowerCase().split(",");
  if (parts.length !== 3) throw new Error(`"${text}" needs three comma-separated components.`);
  return parts.map((p) => {
    const row = [0, 0, 0];
    const terms = p.match(/[+-]?\d*[hkl]/g) ?? [];
    if (terms.join("") !== p) throw new Error(`Cannot read "${p}" in "${text}".`);
    for (const t of terms) {
      const m = /^([+-]?)(\d*)([hkl])$/.exec(t)!;
      row["hkl".indexOf(m[3]!)]! += (m[1] === "-" ? -1 : 1) * Number(m[2] || 1);
    }
    return row;
  }) as unknown as IntMat3;
}

/** The smallest group holding the matrices. */
export function closeHklGroup(gens: readonly IntMat3[]): IntMat3[] {
  const I: IntMat3 = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const out = new Map<string, IntMat3>([[key(I), I]]);
  for (const g of gens) out.set(key(g), g);
  for (let grew = true; grew; ) {
    grew = false;
    for (const a of [...out.values()])
      for (const b of [...out.values()]) {
        const c = mul(a, b);
        if (!out.has(key(c))) {
          if (out.size >= 48) throw new Error("These matrices generate more than 48 operations: not a crystallographic point group.");
          out.set(key(c), c);
          grew = true;
        }
      }
  }
  return [...out.values()];
}

/** The NeXus Viewer's Laue presets (neutron-nexus-viewer js/symmetry.js PRESETS): name and generators. */
export const VIEWER_PRESETS: readonly (readonly [string, string])[] = [
  ["-1", "-h,-k,-l"],
  ["2/m (b unique)", "-h,k,-l; -h,-k,-l"],
  ["2/m (c unique)", "-h,-k,l; -h,-k,-l"],
  ["mmm", "-h,-k,l; -h,k,-l; -h,-k,-l"],
  ["4/m", "k,-h,l; -h,-k,-l"],
  ["4/mmm", "k,-h,l; h,-k,-l; -h,-k,-l"],
  ["-3", "k,-h-k,l; -h,-k,-l"],
  ["-3m1", "k,-h-k,l; h,-h-k,-l; -h,-k,-l"],
  ["-31m", "k,-h-k,l; -k,-h,-l; -h,-k,-l"],
  ["6/m", "h+k,-h,l; -h,-k,-l"],
  ["6/mmm", "h+k,-h,l; -k,-h,-l; -h,-k,-l"],
  ["m-3", "k,l,h; -h,-k,l; -h,k,-l; -h,-k,-l"],
  ["m-3m", "k,l,h; k,-h,l; -h,-k,-l"],
];

/** The viewer preset whose group is exactly `group` (same setting), if any. */
export function matchViewerPreset(group: readonly IntMat3[]): string | undefined {
  const keys = new Set(group.map(key));
  for (const [name, gens] of VIEWER_PRESETS) {
    const g = closeHklGroup(gens.split(";").map(parseHklOp));
    if (g.length === keys.size && g.every((m) => keys.has(key(m)))) return name;
  }
  return undefined;
}

/** Rotation order of a proper rotation from its trace (1, 2, 3, 4 or 6). */
const rotationOrder = (m: IntMat3) => ({ 3: 1, [-1]: 2, 0: 3, 1: 4, 2: 6 })[m[0][0] + m[1][1] + m[2][2]] ?? 1;

/** The Laue class of a Laue group, setting-independent: −1, 2/m, mmm, 4/m, 4/mmm, −3, −3m, 6/m, 6/mmm, m−3 or m−3m. */
export function laueClassName(group: readonly IntMat3[]): string {
  const n = Math.max(...group.filter((m) => det(m) > 0).map(rotationOrder));
  switch (group.length) {
    case 2:
      return "-1";
    case 4:
      return "2/m";
    case 8:
      return n === 4 ? "4/m" : "mmm";
    case 16:
      return "4/mmm";
    case 6:
      return "-3";
    case 12:
      return n === 6 ? "6/m" : "-3m";
    case 24:
      return n === 6 ? "6/mmm" : "m-3";
    case 48:
      return "m-3m";
    default:
      return `order ${group.length}`;
  }
}

/**
 * The reflection conditions of the lattice centring: for each centring vector t, h·t must be an integer, written
 * as "h+k+l = 2n" (coefficients reduced to the smallest magnitudes modulo n).
 */
export function centringConditions(ops: readonly SymOp[]): string[] {
  const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b));
  const out = new Set<string>();
  for (const t of centringVectors(ops)) {
    if (t.every((v) => v === 0)) continue;
    const n = TDEN / t.reduce((g, v) => gcd(g, v), TDEN);
    let coeff = t.map((v) => {
      const c = (((v * n) / TDEN) % n + n) % n;
      return c > n / 2 ? c - n : c;
    });
    // c and −c give the same condition (the centring vectors t and 2t of an R lattice): keep the first coefficient positive.
    if ((coeff.find((c) => c !== 0) ?? 0) < 0) coeff = coeff.map((c) => -c + 0);
    const lhs = formatHklOp([coeff as unknown as IntMat3[0], [0, 0, 0], [0, 0, 0]]).split(",")[0]!;
    out.add(`${lhs} = ${n}n`);
  }
  return [...out];
}
