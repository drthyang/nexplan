/**
 * How a crystal is mounted: the scattering plane spanned by two reciprocal-lattice vectors u and v (r.l.u.), and
 * where it lies relative to the beam and the rotation axis.
 *
 * Mount convention (Mantid SetUB with u and v, as MSlice and Horace use them; OrientedLattice::setUFromVectors @
 * 67c2f43): with every goniometer angle at zero, UB·u lies along the beam (+z), the part of UB·v perpendicular to it
 * along +x, and UB·u × UB·v along +y, up. U is the rotation that does this, and UB = U·B (Busing & Levy 1967). On a
 * goniometer whose only free axis is vertical (TOPAZ cryogenic, CORELLI, the ψ stage of a chopper spectrometer), the
 * plane then stays horizontal as the crystal turns, and the rotation axis is the plane's zone axis.
 *
 * Zone axis: the direct-lattice direction [uvw] perpendicular to the reciprocal plane of u and v is u × v (the Weiss
 * zone law: h·[uvw] = 0 for every h in the plane).
 *
 * Where reflections of the plane land: with k_i = ẑ/λ and |k_f| = |k_i| (elastic), q = (û_f − ẑ)/λ, so q lies in the
 * plane of lab normal n exactly when n·û_f = n·ẑ. These directions form a circle on the unit sphere through the
 * forward direction ẑ: centre (n·ẑ)·n, radius √(1 − (n·ẑ)²). For a horizontal plane (n = ŷ) it is the horizontal
 * plane itself, ν = 0 on the detector map. It holds for any wavelength in elastic scattering, white beam or
 * monochromatic (with an energy transfer the locus would be n·û_f = (k_i/k_f)·n·ẑ).
 */
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { inverse, mulMat, mulVec } from "@materia/core/math/mat3";
import type { UnitCell } from "@materia/core/crystal/types";
import { bMatrix } from "./ub.ts";

/** A scattering plane: two reciprocal-lattice vectors (r.l.u.); u along the beam and v horizontal when mounted. */
export interface ScatteringPlane {
  readonly u: Vec3;
  readonly v: Vec3;
}

/** Common mounts. Each name lists the indices that vary in the plane, as in (H K 0). */
export const PLANE_PRESETS: readonly { readonly id: string; readonly label: string; readonly plane: ScatteringPlane }[] = [
  { id: "hk0", label: "(H K 0)", plane: { u: [1, 0, 0], v: [0, 1, 0] } },
  { id: "h0l", label: "(H 0 L)", plane: { u: [1, 0, 0], v: [0, 0, 1] } },
  { id: "0kl", label: "(0 K L)", plane: { u: [0, 1, 0], v: [0, 0, 1] } },
  { id: "hhl", label: "(H H L)", plane: { u: [1, 1, 0], v: [0, 0, 1] } },
  { id: "h-hl", label: "(H −H L)", plane: { u: [1, -1, 0], v: [0, 0, 1] } },
];

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const n = norm(a);
  return [a[0] / n, a[1] / n, a[2] / n];
};

export class MountError extends Error {}

/**
 * U for a mount, as Mantid's OrientedLattice::setUFromVectors: U·B·u ∥ +z (the beam), U·(B·v)⊥ ∥ +x, U·(B·u × B·v)
 * ∥ +y. Throws when B·u or B·v vanishes, or u and v are parallel.
 */
export function uFromVectors(B: Mat3, u: Vec3, v: Vec3): Mat3 {
  const bu0 = mulVec(B, u);
  const bv0 = mulVec(B, v);
  if (dot(bu0, bu0) < 1e-10) throw new MountError("u is zero");
  if (dot(bv0, bv0) < 1e-10) throw new MountError("v is zero");
  const bu = unit(bu0);
  const w = cross(bu, bv0);
  if (norm(w) < 1e-5) throw new MountError("u and v are parallel");
  const bw = unit(w);
  const bv = cross(bw, bu);
  // lab = U·tau, with tau's columns bu, bv, bw and lab's columns ẑ, x̂, ŷ.
  const tau: Mat3 = [
    [bu[0], bv[0], bw[0]],
    [bu[1], bv[1], bw[1]],
    [bu[2], bv[2], bw[2]],
  ];
  const lab: Mat3 = [
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 0],
  ];
  return mulMat(lab, inverse(tau));
}

/** UB of a crystal mounted in this plane: U(u, v)·B (Mantid SetUB with u and v). */
export function mountUB(cell: UnitCell, plane: ScatteringPlane): Mat3 {
  const B = bMatrix(cell);
  return mulMat(uFromVectors(B, plane.u, plane.v), B);
}

const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b));

/** The zone axis [uvw] = u × v of the plane, reduced to coprime integers when u and v are integer. */
export function zoneAxis(plane: ScatteringPlane): Vec3 {
  const z = cross(plane.u, plane.v);
  if (!z.every((x) => Number.isInteger(x))) return z;
  const g = z.reduce((acc, x) => gcd(acc, x), 0) || 1;
  return [z[0] / g, z[1] / g, z[2] / g];
}

/** A plane given as numbers, checked for shape: two finite 3-vectors (mountable checks them against a cell). */
export function isPlane(p: unknown): p is ScatteringPlane {
  const vec = (x: unknown) => Array.isArray(x) && x.length === 3 && x.every((v) => typeof v === "number" && Number.isFinite(v));
  if (!p || typeof p !== "object") return false;
  const { u, v } = p as { u?: unknown; v?: unknown };
  return vec(u) && vec(v);
}

/** Whether u and v define a plane in this cell, by Mantid's own test (uFromVectors does not throw). */
export function mountable(cell: UnitCell, plane: ScatteringPlane): boolean {
  try {
    uFromVectors(bMatrix(cell), plane.u, plane.v);
    return true;
  } catch (e) {
    if (e instanceof MountError) return false;
    throw e;
  }
}

export interface PlaneGeometry {
  /** Unit normal of the plane in the lab (beam +z, up +y), along R·(UB·u × UB·v). */
  readonly normal: Vec3;
  /** Lab unit vectors along R·UB·u and, in the plane and perpendicular to it, towards R·UB·v. */
  readonly uDir: Vec3;
  readonly vDir: Vec3;
  /** Angle (deg) between the plane and the horizontal (the normal from +y): 0 when the plane is horizontal. */
  readonly tiltDeg: number;
  /** Angle (deg) between the beam and the plane: 0 when the beam lies in it. */
  readonly beamDeg: number;
}

/** Where the plane is in the lab at goniometer rotation R, for orientation UB (q = R·UB·h). */
export function planeGeometry(UB: Mat3, R: Mat3, plane: ScatteringPlane): PlaneGeometry {
  const RUB = mulMat(R, UB);
  const qu = mulVec(RUB, plane.u);
  const qv = mulVec(RUB, plane.v);
  const normal = unit(cross(qu, qv));
  const uDir = unit(qu);
  const vDir = cross(normal, uDir);
  const deg = (r: number) => (r * 180) / Math.PI;
  return {
    normal,
    uDir,
    vDir,
    tiltDeg: deg(Math.acos(Math.min(1, Math.abs(normal[1])))),
    beamDeg: deg(Math.asin(Math.min(1, Math.abs(normal[2])))),
  };
}

/**
 * Directions (lab unit vectors, a closed polyline of n points) along which reflections of a plane with lab normal n
 * can be scattered: n·û = n·ẑ, a circle on the unit sphere through the forward direction.
 */
export function planeTrace(normal: Vec3, n = 720): Vec3[] {
  const c = normal[2];
  const r = Math.sqrt(Math.max(0, 1 - c * c));
  // Two unit vectors perpendicular to the normal.
  const seed: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = unit(cross(normal, seed));
  const e2 = cross(normal, e1);
  const out: Vec3[] = [];
  for (let k = 0; k <= n; k++) {
    const t = (2 * Math.PI * k) / n;
    out.push([c * normal[0] + r * (Math.cos(t) * e1[0] + Math.sin(t) * e2[0]), c * normal[1] + r * (Math.cos(t) * e1[1] + Math.sin(t) * e2[1]), c * normal[2] + r * (Math.cos(t) * e1[2] + Math.sin(t) * e2[2])]);
  }
  return out;
}

const num = (x: number) => Number(x.toPrecision(10));

/** The Mantid call that sets this mount on a workspace (lattice from the cell, u and v as given). */
export function setUBCall(cell: UnitCell, plane: ScatteringPlane, workspace = "ws"): string {
  return `SetUB(Workspace="${workspace}", a=${num(cell.a)}, b=${num(cell.b)}, c=${num(cell.c)}, alpha=${num(cell.alpha)}, beta=${num(cell.beta)}, gamma=${num(cell.gamma)}, u="${plane.u.join(",")}", v="${plane.v.join(",")}")`;
}
