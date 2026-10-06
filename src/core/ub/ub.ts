/**
 * UB matrix: lattice and orientation.
 *
 * Convention (Busing & Levy 1967, as Mantid): UB maps a column (h, k, l) to
 * the scattering vector in the sample frame in units of 1/Å WITHOUT 2π,
 *   q = UB·h,  |q| = 1/d,  Q = 2π·q.
 * B is upper triangular with the reciprocal basis in a Cartesian frame that has
 * a* along x and b* in the xy plane; U is a proper rotation. The sample frame
 * is Mantid's: beam along +z, +y up, x = y × z.
 */
import type { UnitCell } from "@materia/core/crystal/types";
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { determinant, inverse, mulMat, mulVec, transpose } from "@materia/core/math/mat3";
import { metricTensor } from "@materia/core/crystal/unitCell";

const DEG = Math.PI / 180;

/** Busing–Levy B matrix (no 2π). */
export function bMatrix(cell: UnitCell): Mat3 {
  const G = metricTensor(cell);
  const Gs = inverse(G);
  const as = Math.sqrt(Gs[0][0]);
  const bs = Math.sqrt(Gs[1][1]);
  const cs = Math.sqrt(Gs[2][2]);
  const cosBetaS = Gs[0][2] / (as * cs);
  const cosGammaS = Gs[0][1] / (as * bs);
  const sinBetaS = Math.sqrt(Math.max(0, 1 - cosBetaS * cosBetaS));
  const sinGammaS = Math.sqrt(Math.max(0, 1 - cosGammaS * cosGammaS));
  const cosAlpha = Math.cos(cell.alpha * DEG);
  return [
    [as, bs * cosGammaS, cs * cosBetaS],
    [0, bs * sinGammaS, -cs * sinBetaS * cosAlpha],
    [0, 0, 1 / cell.c],
  ];
}

/** Lattice parameters implied by UB: G* = UBᵀ·UB, G = (G*)⁻¹. */
export function latticeFromUB(UB: Mat3): UnitCell & { volume: number } {
  const Gs = mulMat(transpose(UB), UB);
  const G = inverse(Gs);
  const a = Math.sqrt(G[0][0]);
  const b = Math.sqrt(G[1][1]);
  const c = Math.sqrt(G[2][2]);
  const ang = (x: number) => Math.acos(Math.max(-1, Math.min(1, x))) / DEG;
  return {
    a,
    b,
    c,
    alpha: ang(G[1][2] / (b * c)),
    beta: ang(G[0][2] / (a * c)),
    gamma: ang(G[0][1] / (a * b)),
    volume: Math.sqrt(Math.max(0, determinant(G))),
  };
}

export interface Orientation {
  readonly U: Mat3;
  readonly B: Mat3;
  readonly cell: UnitCell & { volume: number };
  /** det(UB) > 0 for a right-handed reciprocal basis. */
  readonly detUB: number;
  /** max |UᵀU − I|, a measure of how far U is from a rotation. */
  readonly orthogonalityError: number;
  readonly detU: number;
}

/** Split UB into U and B (B from the lattice UB implies). */
export function orientationFromUB(UB: Mat3): Orientation {
  const cell = latticeFromUB(UB);
  const B = bMatrix(cell);
  const U = mulMat(UB, inverse(B));
  const UtU = mulMat(transpose(U), U);
  let err = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) err = Math.max(err, Math.abs(UtU[i]![j]! - (i === j ? 1 : 0)));
  return { U, B, cell, detUB: determinant(UB), orthogonalityError: err, detU: determinant(U) };
}

export function ubFromU(U: Mat3, cell: UnitCell): Mat3 {
  return mulMat(U, bMatrix(cell));
}

/** q = UB·h (1/Å, no 2π). */
export function qSample(UB: Mat3, h: Vec3): Vec3 {
  return mulVec(UB, h);
}

/**
 * Basis change with ITA's convention (a′, b′, c′) = (a, b, c)·P:
 * h′ = Pᵀh and UB′ = UB·P⁻ᵀ, so UB′·h′ = UB·h (the same physical vector).
 */
export function transformUB(UB: Mat3, P: Mat3): Mat3 {
  const det = determinant(P);
  if (!(Math.abs(det) > 1e-8)) throw new Error("The transformation matrix P is singular.");
  return mulMat(UB, transpose(inverse(P)));
}

/** Real-space basis vectors a, b, c (Å) in the sample frame: columns of (UB)⁻ᵀ. */
export function directBasisInSample(UB: Mat3): Mat3 {
  return transpose(inverse(UB));
}

/** Rotation axis (unit) and angle (deg) of a proper rotation matrix. */
export function axisAngle(R: Mat3): { axis: Vec3; angleDeg: number } {
  const tr = R[0][0] + R[1][1] + R[2][2];
  const angle = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
  if (angle < 1e-9) return { axis: [0, 0, 1], angleDeg: 0 };
  if (Math.PI - angle < 1e-6) {
    // 180°: R = 2nnᵀ − I, so (R + Rᵀ)/4 + I/2 = nnᵀ; its column with the largest diagonal is n times a nonzero
    // component, which fixes the relative signs (the overall sign of a 180° axis is arbitrary).
    const S = [0, 1, 2].map((i) => [0, 1, 2].map((j) => (R[i]![j]! + R[j]![i]!) / 4 + (i === j ? 0.5 : 0)));
    const k = [0, 1, 2].reduce((best, i) => (S[i]![i]! > S[best]![best]! ? i : best), 0);
    const axis = [S[0]![k]!, S[1]![k]!, S[2]![k]!];
    const n = Math.hypot(...axis);
    return { axis: [axis[0]! / n, axis[1]! / n, axis[2]! / n], angleDeg: 180 };
  }
  const s = 2 * Math.sin(angle);
  return { axis: [(R[2][1] - R[1][2]) / s, (R[0][2] - R[2][0]) / s, (R[1][0] - R[0][1]) / s], angleDeg: angle / DEG };
}

/**
 * Smallest-index direction [uvw] (real space) or (hkl) (reciprocal) closest to a
 * sample-frame unit vector, searched over indices |i| ≤ maxIndex.
 */
export function nearestIndices(basis: Mat3, target: Vec3, maxIndex = 6): { indices: Vec3; angleDeg: number } {
  let best: { indices: Vec3; angleDeg: number } = { indices: [0, 0, 1], angleDeg: 180 };
  const tn = Math.hypot(...target);
  for (let h = -maxIndex; h <= maxIndex; h++)
    for (let k = -maxIndex; k <= maxIndex; k++)
      for (let l = -maxIndex; l <= maxIndex; l++) {
        if (!h && !k && !l) continue;
        const v = mulVec(basis, [h, k, l]);
        const c = (v[0] * target[0] + v[1] * target[1] + v[2] * target[2]) / (Math.hypot(...v) * tn);
        const ang = Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
        // Prefer smaller indices on near-ties (0.05°).
        const sum = Math.abs(h) + Math.abs(k) + Math.abs(l);
        const bestSum = Math.abs(best.indices[0]) + Math.abs(best.indices[1]) + Math.abs(best.indices[2]);
        if (ang < best.angleDeg - 0.05 || (Math.abs(ang - best.angleDeg) <= 0.05 && sum < bestSum)) best = { indices: [h, k, l], angleDeg: ang };
      }
  return best;
}

export interface BasisMatch {
  /** (a, b, c)_UB = (a, b, c)_CIF · P; h_UB = Pᵀ·h_CIF. */
  readonly P: Mat3;
  /** UB that maps CIF indices: UB_UB·Pᵀ. */
  readonly ubForCif: Mat3;
  /** Largest relative mismatch of the metric tensors after the transformation. */
  readonly misfit: number;
  /** det P, the UB cell's volume over the CIF cell's: 8 for a 2 × 2 × 2 supercell, 1/4 for the primitive cell of an F lattice. */
  readonly volumeRatio: number;
}

/**
 * Right-handed bases of whole lattice vectors: integer M with det M = n and Mᵀ·Ga·M ≈ Gb within `tol` of Gb's
 * largest diagonal entry. The columns of M are vectors of Ga's lattice with Gb's lengths. A vector's index along
 * a_i is a*_i·v, so |index| ≤ |v|·|a*_i|, which bounds the search (capped at `cap`).
 */
function integerBases(Ga: Mat3, Gb: Mat3, n: number, tol: number, cap = 12): { M: Mat3; misfit: number }[] {
  const scale = Math.max(Gb[0][0], Gb[1][1], Gb[2][2]);
  const eps = tol * scale;
  const Gs = inverse(Ga);
  const vMax = Math.sqrt(scale + eps);
  const lim = [0, 1, 2].map((i) => Math.min(cap, Math.floor(vMax * Math.sqrt(Gs[i]![i]!) + 1e-9)));
  const dot = (u: Vec3, v: Vec3) => {
    let s = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s += u[i]! * Ga[i]![j]! * v[j]!;
    return s;
  };
  const cols: Vec3[][] = [[], [], []];
  for (let x = -lim[0]!; x <= lim[0]!; x++)
    for (let y = -lim[1]!; y <= lim[1]!; y++)
      for (let z = -lim[2]!; z <= lim[2]!; z++) {
        if (!x && !y && !z) continue;
        const v: Vec3 = [x, y, z];
        const l2 = dot(v, v);
        for (let j = 0; j < 3; j++) if (Math.abs(l2 - Gb[j]![j]!) <= eps) cols[j]!.push(v);
      }
  const out: { M: Mat3; misfit: number }[] = [];
  for (const c0 of cols[0]!)
    for (const c1 of cols[1]!) {
      if (Math.abs(dot(c0, c1) - Gb[0][1]) > eps) continue;
      for (const c2 of cols[2]!) {
        if (Math.abs(dot(c0, c2) - Gb[0][2]) > eps || Math.abs(dot(c1, c2) - Gb[1][2]) > eps) continue;
        const M: Mat3 = [
          [c0[0], c1[0], c2[0]],
          [c0[1], c1[1], c2[1]],
          [c0[2], c1[2], c2[2]],
        ];
        if (Math.round(determinant(M)) !== n) continue;
        const G = mulMat(transpose(M), mulMat(Ga, M));
        let misfit = 0;
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) misfit = Math.max(misfit, Math.abs(G[i]![j]! - Gb[i]![j]!) / scale);
        out.push({ M, misfit });
      }
    }
  return out;
}

/** Fewer off-diagonal terms, then fewer negative entries, then smaller entries: (2a, 2b, 2c) before (2b, 2c, 2a). */
function simplicity(P: Mat3): number[] {
  let off = 0;
  let neg = 0;
  let sum = 0;
  P.forEach((row, i) =>
    row.forEach((v, j) => {
      if (i !== j && Math.abs(v) > 1e-9) off++;
      if (v < -1e-9) neg++;
      sum += Math.abs(v);
    }),
  );
  return [off, neg, sum];
}

const matrixKey = (P: Mat3) => P.flat().map((v) => String(Math.round(v * 1e6) / 1e6 + 0)).join(",");

/**
 * Basis changes that map the CIF cell onto the cell implied by UB: (a, b, c)_UB = (a, b, c)_CIF·P with
 * Pᵀ·G_CIF·P ≈ G_UB within `tolerance` (relative, on the metric tensor), right-handed. The volume ratio fixes
 * det P: a whole number n when the UB's cell is the CIF cell (n = 1) or a supercell of it (e.g. 8 for 2 × 2 × 2),
 * 1/n when it is smaller (e.g. the primitive cell of a centred one, whose P is the inverse of a whole matrix).
 *
 * Choices related by a proper rotation W of the CIF's Laue group (P and W·P) index the reflections alike, so only
 * the best of each such set is kept when `rotations` are given; the rest are real alternatives (e.g. which axis of a
 * pseudo-cubic supercell is the CIF's c). Sorted by misfit, then simplest first. Misfits closer than a tenth of the
 * tolerance count as equal (a measured UB's noise), so the identity wins over a rotated copy of itself.
 */
export function findCellMatches(cif: UnitCell, UB: Mat3, options: { tolerance?: number; rotations?: readonly Mat3[] } = {}): BasisMatch[] {
  const tol = options.tolerance ?? 0.02;
  const Gc = metricTensor(cif);
  const Gu = inverse(mulMat(transpose(UB), UB));
  const ratio = Math.sqrt(determinant(Gu) / determinant(Gc));
  const n = Math.round(ratio);
  const m = Math.round(1 / ratio);
  let found: { P: Mat3; misfit: number }[] = [];
  if (n >= 1 && Math.abs(ratio / n - 1) <= 3 * tol) found = integerBases(Gc, Gu, n, tol).map(({ M, misfit }) => ({ P: M, misfit }));
  else if (m >= 2 && Math.abs(1 / ratio / m - 1) <= 3 * tol)
    found = integerBases(Gu, Gc, m, tol).map(({ M, misfit }) => ({
      // The CIF cell in the UB's: (a, b, c)_CIF = (a, b, c)_UB·M, so P = M⁻¹, whose entries are multiples of 1/m.
      P: inverse(M).map((row) => row.map((v) => Math.round(v * m) / m + 0)) as unknown as Mat3,
      misfit,
    }));
  const rotations = options.rotations ?? [];
  const orbitKey = (P: Mat3) =>
    rotations.length === 0
      ? matrixKey(P)
      : rotations.map((W) => matrixKey(mulMat(W, P))).reduce((a, b) => (b < a ? b : a));
  const before = (a: { P: Mat3; misfit: number }, b: { P: Mat3; misfit: number }) => {
    if (Math.abs(a.misfit - b.misfit) > tol / 10) return a.misfit - b.misfit;
    const sa = simplicity(a.P);
    const sb = simplicity(b.P);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i]! - sb[i]!;
    return matrixKey(a.P) < matrixKey(b.P) ? -1 : 1;
  };
  const best = new Map<string, { P: Mat3; misfit: number }>();
  for (const f of found) {
    const key = orbitKey(f.P);
    const held = best.get(key);
    if (!held || before(f, held) < 0) best.set(key, f);
  }
  return [...best.values()].sort(before).map(({ P, misfit }) => ({ P, ubForCif: mulMat(UB, transpose(P)), misfit, volumeRatio: determinant(P) }));
}

/** The best of `findCellMatches`, or undefined when no cell change fits. */
export function findBasisMatch(cif: UnitCell, UB: Mat3, tolerance = 0.02): BasisMatch | undefined {
  return findCellMatches(cif, UB, { tolerance })[0];
}
