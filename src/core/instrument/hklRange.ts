/**
 * The part of reciprocal space a measurement records, as ranges along chosen
 * HKL axes: what to give Mantid's MDNorm or BinMD (or garnet) as binning limits.
 *
 * A detector pixel along unit u records the scattering vector (1/Å, no 2π)
 *  - white beam (TOPAZ, CORELLI): q_lab = (u − ẑ)/λ for λ in the band;
 *  - chopper spectrometer at energy transfer E: q_lab = k_f·u − k_i·ẑ with
 *    k = √(E/81.8042 meV) (λ = 1/k), k_f from E_i − E.
 * Along one pixel q is linear in 1/λ (or in k_f), so any linear coordinate is
 * extreme at the ends of the band (or of the energy range). In the crystal the
 * coordinates along projection axes W (columns, in r.l.u.) are
 * x = (UB·W)⁻¹·Rᵀ·q_lab, with R the goniometer at the setting.
 *
 * The extent is the box over the settings, the pixels that record (masks and
 * the environment's shadows, acceptance.ts, honoured) and both ends of the band,
 * optionally within |q| ≤ q_max: each pixel's segment is clipped to that sphere
 * (|q| is linear in 1/λ for a white beam, quadratic in k_f for a direct one),
 * and the clipped ends are still the extremes.
 * Pixels are sampled on a grid per panel that includes its edges, where a
 * linear coordinate is extreme for a flat panel, so the box is exact to the
 * grid spacing at the corners.
 */
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { inverse, mulMat, mulVec, transpose } from "@materia/core/math/mat3";
import type { Blocked, DetectorPanel } from "./detectors.ts";
import { recordsAt } from "./detectors.ts";

/** k (1/Å, no 2π) of a neutron of energy E (meV): E = 81.8042·k². */
export const kOfEnergy = (meV: number) => Math.sqrt(meV / 81.8042);

export interface HklExtent {
  /** Lower and upper limits along each projection axis (r.l.u.). */
  readonly min: Vec3;
  readonly max: Vec3;
  /** The largest |Q| recorded (1/Å, with 2π: Q = 2π|q|). */
  readonly qMax: number;
}

/** The incident beam: a white band (TOF Laue), or a fixed incident energy with a range of energy transfer. */
export type Beam = { readonly kind: "white"; readonly lambdaMin: number; readonly lambdaMax: number } | { readonly kind: "direct"; readonly eiMeV: number; readonly eMin: number; readonly eMax: number };

/** Unit directions to the recording points of each panel: an n × n grid of cell centres plus the panel's edges. */
export function panelSamples(panels: readonly DetectorPanel[], n = 12): Vec3[][] {
  return panels.map((p) => {
    if (p.off) return [];
    const out: Vec3[] = [];
    // Offsets from −1 to 1 (as fractions of the half-width): the edges, and the cell centres between.
    const ticks = [-1, ...Array.from({ length: n }, (_, i) => (2 * (i + 0.5)) / n - 1), 1];
    for (const sy of ticks)
      for (const sx of ticks) {
        // Just inside the edge, so the edge pixel's mask decides.
        const x = sx * (p.width / 2) * (1 - 1e-9);
        const y = sy * (p.height / 2) * (1 - 1e-9);
        if (!recordsAt(p, x, y)) continue;
        const v: Vec3 = [p.center[0] + x * p.base[0] + y * p.up[0], p.center[1] + x * p.base[1] + y * p.up[1], p.center[2] + x * p.base[2] + y * p.up[2]];
        const l = Math.hypot(...v);
        out.push([v[0] / l, v[1] / l, v[2] / l]);
      }
    return out;
  });
}

/**
 * The ends of the segment a pixel along u records, as (a, b) with q = a·u − b·ẑ (1/Å, no 2π), within |q| ≤ qMax;
 * empty when none of it is.
 */
export function segmentEnds(u: Vec3, beam: Beam, qMax = Infinity): [number, number][] {
  if (beam.kind === "white") {
    // q = t·(u − ẑ), t = 1/λ: |q| = t·|u − ẑ|.
    const s = Math.hypot(u[0], u[1], u[2] - 1);
    const lo = 1 / beam.lambdaMax;
    const hi = Math.min(1 / beam.lambdaMin, s > 0 ? qMax / s : Infinity);
    return hi < lo ? [] : [
      [lo, lo],
      [hi, hi],
    ];
  }
  // q = k_f·u − k_i·ẑ: |q|² = k_f² − 2k_i·u_z·k_f + k_i² ≤ q_max² for k_f within k_i·u_z ± √D.
  const ki = kOfEnergy(beam.eiMeV);
  const eMax = Math.min(beam.eMax, beam.eiMeV);
  if (!(beam.eMin < beam.eiMeV)) return [];
  let lo = kOfEnergy(beam.eiMeV - eMax);
  let hi = kOfEnergy(beam.eiMeV - beam.eMin);
  if (Number.isFinite(qMax)) {
    const D = ki * ki * (u[2] * u[2] - 1) + qMax * qMax;
    if (D < 0) return [];
    lo = Math.max(lo, ki * u[2] - Math.sqrt(D));
    hi = Math.min(hi, ki * u[2] + Math.sqrt(D));
    if (hi < lo) return [];
  }
  return [
    [lo, ki],
    [hi, ki],
  ];
}

/**
 * The HKL box a measurement records: settings R (goniometer matrices) with the shadows at each
 * (`blocked[k]`), sampled pixel directions (panelSamples), the beam, the orientation UB (q = UB·h, no 2π),
 * the projection axes W (columns in r.l.u.; the identity gives h, k, l), and optionally |q| ≤ qMax (1/Å, no 2π:
 * 1/d_min). Undefined when nothing records.
 */
export function hklExtent(settings: readonly Mat3[], blocked: readonly (Blocked | undefined)[], samples: readonly (readonly Vec3[])[], beam: Beam, UB: Mat3, W: Mat3, qMax = Infinity): HklExtent | undefined {
  const toX = inverse(mulMat(UB, W));
  // Each pixel's segment ends depend on the pixel only, not on the setting.
  const ends = samples.map((list) => list.map((u) => segmentEnds(u, beam, qMax)));
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let q2Max = 0;
  settings.forEach((R, k) => {
    // x = (UB·W)⁻¹·Rᵀ·q_lab: one matrix per setting.
    const M = mulMat(toX, transpose(R));
    const block = blocked[k];
    samples.forEach((list, p) =>
      list.forEach((u, s) => {
        if (block?.(u[0], u[1], u[2])) return;
        for (const [a, b] of ends[p]![s]!) {
          const q: Vec3 = [a * u[0], a * u[1], a * u[2] - b];
          q2Max = Math.max(q2Max, q[0] * q[0] + q[1] * q[1] + q[2] * q[2]);
          const x = mulVec(M, q);
          for (let i = 0; i < 3; i++) {
            if (x[i]! < min[i]!) min[i] = x[i]!;
            if (x[i]! > max[i]!) max[i] = x[i]!;
          }
        }
      }),
    );
  });
  return Number.isFinite(min[0]) ? { min: min as unknown as Vec3, max: max as unknown as Vec3, qMax: 2 * Math.PI * Math.sqrt(q2Max) } : undefined;
}
