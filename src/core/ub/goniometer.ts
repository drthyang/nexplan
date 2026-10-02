/**
 * Goniometers and the Laue condition in the laboratory frame.
 *
 * Lab frame (Mantid, SNS instruments): beam along +z, +y up, x = y × z.
 * A goniometer axis is (name, direction, sense): sense +1 rotates
 * counter-clockwise about the direction (right-hand rule), −1 clockwise.
 * The axes compose as R = R₀·R₁·R₂… (axis 0 outermost), and
 *   q_lab = R · UB · h        (1/Å, no 2π).
 *
 * Q sign: the crystallographic convention is Q = k_f − k_i. A UB determined
 * with the opposite ("inelastic", Q = k_i − k_f) convention maps h to −q_cryst;
 * `qSign` converts it: q_cryst = qSign · q_lab.
 */
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { mulMat, mulVec } from "@materia/core/math/mat3";

export interface GoniometerAxis {
  readonly name: string;
  readonly direction: Vec3;
  readonly sense: 1 | -1;
  readonly min: number;
  readonly max: number;
  /** Fixed angle (deg) for an axis the instrument does not drive, e.g. TOPAZ ambient χ = 135°. */
  readonly fixed?: number;
  /** Instrument log name, for reference. */
  readonly log?: string;
}

export interface GoniometerModel {
  readonly id: string;
  readonly label: string;
  readonly axes: readonly GoniometerAxis[];
  readonly note: string;
}

/** Rotation by `deg` about a unit `axis`, counter-clockwise (right-hand rule). */
export function axisRotation(axis: Vec3, deg: number): Mat3 {
  const n = Math.hypot(...axis);
  const [x, y, z] = [axis[0] / n, axis[1] / n, axis[2] / n];
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const C = 1 - c;
  return [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ];
}

/** R = R₀·R₁·…, each axis turned by sense × angle. */
export function goniometerMatrix(model: GoniometerModel, anglesDeg: readonly number[]): Mat3 {
  let R: Mat3 = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  model.axes.forEach((ax, i) => {
    R = mulMat(R, axisRotation(ax.direction, ax.sense * (ax.fixed ?? anglesDeg[i] ?? 0)));
  });
  return R;
}

export interface LaueSpot {
  /** Wavelength (Å) at which h satisfies the Bragg condition; NaN if it cannot (q_z ≥ 0). */
  readonly lambda: number;
  /** Scattering angle 2θ (deg). */
  readonly twoTheta: number;
  /** Azimuth of k_f about the beam (deg), measured from +x toward +y. */
  readonly azimuth: number;
  /** Unit vector of the scattered beam in the lab frame. */
  readonly kf: Vec3;
}

/**
 * Laue (white-beam / TOF) condition for one reflection. With k_i = (1/λ)·ẑ and
 * k_f = k_i + q (crystallographic q), |k_f| = |k_i| gives λ = −2 q_z / |q|²,
 * which needs q_z < 0.
 */
export function laueCondition(qCryst: Vec3): LaueSpot {
  const q2 = qCryst[0] ** 2 + qCryst[1] ** 2 + qCryst[2] ** 2;
  if (!(qCryst[2] < 0) || q2 === 0) return { lambda: NaN, twoTheta: NaN, azimuth: NaN, kf: [NaN, NaN, NaN] };
  const lambda = (-2 * qCryst[2]) / q2;
  const kf: Vec3 = [qCryst[0], qCryst[1], 1 / lambda + qCryst[2]];
  const n = Math.hypot(...kf);
  const u: Vec3 = [kf[0] / n, kf[1] / n, kf[2] / n];
  return {
    lambda,
    twoTheta: (Math.acos(Math.max(-1, Math.min(1, u[2]))) * 180) / Math.PI,
    azimuth: (Math.atan2(u[1], u[0]) * 180) / Math.PI,
    kf: u,
  };
}

/** q_cryst in the lab frame for reflection h at goniometer R. */
export function qLab(R: Mat3, UB: Mat3, h: Vec3, qSign: 1 | -1): Vec3 {
  const q = mulVec(R, mulVec(UB, h));
  return [qSign * q[0], qSign * q[1], qSign * q[2]];
}
