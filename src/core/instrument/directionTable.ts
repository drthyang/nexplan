/**
 * Which scattered directions the detectors record, tabulated on the unrolled detector map (γ = atan2(u_x, u_z),
 * ν = asin(u_y), simulate.ts) at a fixed angular step, so that coverage of many reciprocal-space points over many
 * goniometer settings costs a table lookup per test instead of a ray cast.
 *
 * Each cell holds rayHit's answer at its centre (the nearest panel along the ray, its pixel mask, a panel switched
 * off), so the table agrees with the exact test except within half a step of a panel edge or a masked pixel's edge.
 * Only cells inside some panel's angular box are cast. Sample-environment shadows are not in the table: they can
 * turn with the goniometer, so callers test them per setting.
 *
 * recordedCounts gives, for points q in the sample frame (1/Å, no 2π), the number of goniometer settings at which
 * each diffracts in the band (λ = −2q_z/|q|² for q_lab = R·q, goniometer.ts laueCondition) onto a recording
 * direction: pointCoverage (simulate.ts) with the table in place of rayHit.
 */
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { goniometerMatrix, type GoniometerModel } from "../ub/goniometer.ts";
import { blockedAt, type Shadows } from "./acceptance.ts";
import { rayHit, type DetectorPanel } from "./detectors.ts";
import { panelSamples } from "./hklRange.ts";

const DEG = Math.PI / 180;

export interface DirectionTable {
  /** Angular step (deg) of the table. */
  readonly step: number;
  /** Whether the unit direction (x, y, z) lands on a recording pixel. */
  records(x: number, y: number, z: number): boolean;
}

/** The recording directions of panels (masks and switched-off panels included) on a grid of `stepDeg`. */
export function directionTable(panels: readonly DetectorPanel[], stepDeg = 0.1): DirectionTable {
  const nG = Math.round(360 / stepDeg);
  const nN = Math.round(180 / stepDeg);
  const bits = new Uint8Array(nG * nN);
  // Each panel's box in (γ, ν) cells, padded by a cell; a box across γ = ±180° is split in two.
  const boxes: { panel: number; g0: number; g1: number; n0: number; n1: number }[] = [];
  // The panels' outlines, whatever is masked (panelSamples skips masked pixels).
  const samples = panelSamples(
    panels.map(({ mask: _mask, off: _off, ...p }) => p),
    4,
  );
  samples.forEach((dirs, k) => {
    if (panels[k]!.off || !dirs.length) return;
    const g = dirs.map((u) => Math.atan2(u[0], u[2]) / DEG);
    const nu = dirs.map((u) => Math.asin(Math.max(-1, Math.min(1, u[1]))) / DEG);
    const n0 = Math.max(0, Math.floor((Math.min(...nu) + 90) / stepDeg) - 1);
    const n1 = Math.min(nN - 1, Math.floor((Math.max(...nu) + 90) / stepDeg) + 1);
    // A panel's directions span less than 180° in γ, so a wider spread means it straddles ±180°.
    const spans: [number, number][] = Math.max(...g) - Math.min(...g) > 180 ? [[Math.min(...g.filter((x) => x > 0)), 180], [-180, Math.max(...g.filter((x) => x < 0))]] : [[Math.min(...g), Math.max(...g)]];
    for (const [a, b] of spans) boxes.push({ panel: k, g0: Math.max(0, Math.floor((a + 180) / stepDeg) - 1), g1: Math.min(nG - 1, Math.floor((b + 180) / stepDeg) + 1), n0, n1 });
  });
  // Row by row, cast each cell once against the panels whose box holds it.
  const rows: (typeof boxes)[] = Array.from({ length: nN }, () => []);
  for (const b of boxes) for (let j = b.n0; j <= b.n1; j++) rows[j]!.push(b);
  rows.forEach((row, j) => {
    if (!row.length) return;
    const nu = (-90 + (j + 0.5) * stepDeg) * DEG;
    const lo = Math.min(...row.map((b) => b.g0));
    const hi = Math.max(...row.map((b) => b.g1));
    for (let i = lo; i <= hi; i++) {
      const own: DetectorPanel[] = [];
      for (const b of row) if (i >= b.g0 && i <= b.g1 && !own.includes(panels[b.panel]!)) own.push(panels[b.panel]!);
      if (!own.length) continue;
      const gamma = (-180 + (i + 0.5) * stepDeg) * DEG;
      const u: Vec3 = [Math.cos(nu) * Math.sin(gamma), Math.sin(nu), Math.cos(nu) * Math.cos(gamma)];
      if (rayHit(own, u)) bits[j * nG + i] = 1;
    }
  });
  return {
    step: stepDeg,
    records(x, y, z) {
      const i = Math.floor((Math.atan2(x, z) / DEG + 180) / stepDeg);
      const j = Math.floor((Math.asin(y > 1 ? 1 : y < -1 ? -1 : y) / DEG + 90) / stepDeg);
      return bits[Math.min(nN - 1, j) * nG + Math.min(nG - 1, i)] === 1;
    },
  };
}

/**
 * For each point q (sample frame, 1/Å, no 2π), the number of goniometer settings at which it diffracts in the
 * band onto a recording direction of `table`, outside the shadows at that setting.
 */
export function recordedCounts(model: GoniometerModel, settings: readonly (readonly number[])[], qs: readonly Vec3[], table: DirectionTable, lambdaMin: number, lambdaMax: number, shadows?: Shadows): Uint16Array {
  const counts = new Uint16Array(qs.length);
  for (const angles of settings) {
    const R: Mat3 = goniometerMatrix(model, angles);
    const blocked = blockedAt(shadows, angles);
    const [r0, r1, r2] = R;
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i]!;
      const z = r2[0] * q[0] + r2[1] * q[1] + r2[2] * q[2];
      if (!(z < 0)) continue;
      const q2 = q[0] * q[0] + q[1] * q[1] + q[2] * q[2];
      const lambda = (-2 * z) / q2;
      if (lambda < lambdaMin || lambda > lambdaMax) continue;
      const x = r0[0] * q[0] + r0[1] * q[1] + r0[2] * q[2];
      const y = r1[0] * q[0] + r1[1] * q[1] + r1[2] * q[2];
      const kz = 1 / lambda + z;
      const n = Math.hypot(x, y, kz);
      if (!table.records(x / n, y / n, kz / n)) continue;
      if (blocked?.(x / n, y / n, kz / n)) continue;
      counts[i]!++;
    }
  }
  return counts;
}
