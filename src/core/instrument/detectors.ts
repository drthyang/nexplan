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

/**
 * Where a ray from the origin along unit vector `u` crosses one panel: the
 * distance t and the offsets x, y from the centre along `base` and `up`, or
 * undefined when it misses.
 */
export function panelHit(p: DetectorPanel, u: Vec3): { t: number; x: number; y: number } | undefined {
  const n = cross(p.base, p.up);
  const denom = dot(u, n);
  if (Math.abs(denom) < 1e-12) return undefined;
  const t = dot(p.center, n) / denom;
  if (!(t > 0)) return undefined;
  const d: Vec3 = [u[0] * t - p.center[0], u[1] * t - p.center[1], u[2] * t - p.center[2]];
  const x = dot(d, p.base);
  const y = dot(d, p.up);
  if (Math.abs(x) > p.width / 2 || Math.abs(y) > p.height / 2) return undefined;
  return { t, x, y };
}

/** First panel hit by a ray from the origin along unit vector `u`, or undefined. */
export function rayHit(panels: readonly DetectorPanel[], u: Vec3): DetectorHit | undefined {
  let best: DetectorHit | undefined;
  panels.forEach((p, i) => {
    const h = panelHit(p, u);
    if (!h || (best && h.t >= best.l2)) return;
    best = { panel: i, name: p.name, col: (h.x / p.width + 0.5) * p.nCols + 0.5, row: (h.y / p.height + 0.5) * p.nRows + 0.5, l2: h.t, position: [u[0] * h.t, u[1] * h.t, u[2] * h.t] };
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
