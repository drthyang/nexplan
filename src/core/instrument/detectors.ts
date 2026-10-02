/**
 * Planar detector panels and where a scattered ray lands on them.
 *
 * Panels are in the Mantid lab frame (beam +z, up +y), metres, with the sample
 * at the origin. A ray leaves the sample along the unit vector u (the
 * direction of k_f). Pixel coordinates follow the ISAW / Mantid peaks-file
 * convention, verified on TOPAZ_3007: col = (x/width + ½)·nCols + ½ and
 * row = (y/height + ½)·nRows + ½, where x and y are the hit's offsets from the
 * panel centre along `base` and `up` (so pixel centres sit at 1 … n).
 */
import type { Vec3 } from "@materia/core/math/types";

export interface DetectorPanel {
  readonly name: string;
  readonly kind: "rectangular" | "tube-pack";
  readonly center: Vec3;
  readonly base: Vec3;
  readonly up: Vec3;
  readonly width: number;
  readonly height: number;
  readonly nCols: number;
  readonly nRows: number;
}

export interface DetectorHit {
  readonly panel: number;
  readonly name: string;
  readonly col: number;
  readonly row: number;
  /** Sample-to-hit distance (m). */
  readonly l2: number;
  /** Hit position in the lab frame (m). */
  readonly position: Vec3;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** First panel hit by a ray from the origin along unit vector `u`, or undefined. */
export function rayHit(panels: readonly DetectorPanel[], u: Vec3): DetectorHit | undefined {
  let best: DetectorHit | undefined;
  panels.forEach((p, i) => {
    const n = cross(p.base, p.up);
    const denom = dot(u, n);
    if (Math.abs(denom) < 1e-12) return;
    const t = dot(p.center, n) / denom;
    if (!(t > 0) || (best && t >= best.l2)) return;
    const hit: Vec3 = [u[0] * t, u[1] * t, u[2] * t];
    const d: Vec3 = [hit[0] - p.center[0], hit[1] - p.center[1], hit[2] - p.center[2]];
    const x = dot(d, p.base);
    const y = dot(d, p.up);
    if (Math.abs(x) > p.width / 2 || Math.abs(y) > p.height / 2) return;
    best = { panel: i, name: p.name, col: (x / p.width + 0.5) * p.nCols + 0.5, row: (y / p.height + 0.5) * p.nRows + 0.5, l2: t, position: hit };
  });
  return best;
}

/** The four corners of a panel (for drawing), counter-clockwise from (−w/2, −h/2). */
export function panelCorners(p: DetectorPanel): Vec3[] {
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sx, sy]) => [
    p.center[0] + (sx! * p.width * p.base[0]) / 2 + (sy! * p.height * p.up[0]) / 2,
    p.center[1] + (sx! * p.width * p.base[1]) / 2 + (sy! * p.height * p.up[1]) / 2,
    p.center[2] + (sx! * p.width * p.base[2]) / 2 + (sy! * p.height * p.up[2]) / 2,
  ]) as Vec3[];
}
