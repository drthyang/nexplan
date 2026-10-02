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
    // 180°: axis from the diagonal of (R + I)/2.
    const xx = Math.sqrt(Math.max(0, (R[0][0] + 1) / 2));
    const yy = Math.sqrt(Math.max(0, (R[1][1] + 1) / 2));
    const zz = Math.sqrt(Math.max(0, (R[2][2] + 1) / 2));
    const axis: [number, number, number] = [xx, Math.sign(R[0][1] || 1) * yy, Math.sign(R[0][2] || 1) * zz];
    const n = Math.hypot(...axis);
    return { axis: [axis[0] / n, axis[1] / n, axis[2] / n], angleDeg: 180 };
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
}

/**
 * Find a right-handed integer basis change (entries −1, 0, 1; det = +1) that
 * maps the CIF cell onto the cell implied by UB: Pᵀ·G_CIF·P ≈ G_UB within
 * `tolerance` (relative, on the metric tensor). The identity is tried first
 * and wins ties; returns undefined when nothing fits.
 */
export function findBasisMatch(cif: UnitCell, UB: Mat3, tolerance = 0.02): BasisMatch | undefined {
  const Gc = metricTensor(cif);
  const Gu = inverse(mulMat(transpose(UB), UB));
  const scale = Math.max(Gu[0][0], Gu[1][1], Gu[2][2]);
  const misfitOf = (P: Mat3) => {
    const G = mulMat(transpose(P), mulMat(Gc, P));
    let m = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m = Math.max(m, Math.abs(G[i]![j]! - Gu[i]![j]!) / scale);
    return m;
  };
  const I: Mat3 = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  let best: { P: Mat3; misfit: number } = { P: I, misfit: misfitOf(I) };
  if (best.misfit <= tolerance / 10) return { P: I, ubForCif: UB, misfit: best.misfit };
  const v = [-1, 0, 1];
  for (const a of v) for (const b of v) for (const c of v)
    for (const d of v) for (const e of v) for (const f of v)
      for (const g of v) for (const h of v) for (const i of v) {
        const P: Mat3 = [
          [a, b, c],
          [d, e, f],
          [g, h, i],
        ];
        if (determinant(P) !== 1) continue;
        const m = misfitOf(P);
        if (m < best.misfit - 1e-12) best = { P, misfit: m };
      }
  if (best.misfit > tolerance) return undefined;
  return { P: best.P, ubForCif: mulMat(UB, transpose(best.P)), misfit: best.misfit };
}
