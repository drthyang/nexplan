/**
 * Powder (Debye–Scherrer) rings on the detectors.
 *
 * A detector element at scattering angle 2θ records the spacing
 * d = λ/(2 sinθ), where λ is
 *  - for a time-of-flight slice at time t, λ = t/(K·L) with K = m_n/h
 *    (252.778 µs/(m·Å)) and L = L1 + L2 the element's flight path, or
 *  - for a monochromatic beam (chopper spectrometer, elastic line), the fixed
 *    incident wavelength.
 *
 * Counts per unit solid angle from one d-group (Σ|F|² over its signed hkl),
 * with each line spread as a unit-area Gaussian G in ln d:
 *  - TOF slice (incident spectrum normalised out): Σ|F|²·d⁴·sinθ·G, the GSAS-II
 *    TOF Lorentz factor taken per unit solid angle (docs/CONVENTIONS.md §10).
 *  - Fixed λ: Σ|F|²·G/(4 sin³θ) = Σ|F|²·(2d/λ)³·G/4, the CW powder intensity
 *    per unit solid angle (Lorentz 1/(sinθ·sin2θ) per unit ring length, with
 *    the line profile converted from 2θ to ln d).
 * Values are scaled so that the strongest line peaks at 1.
 *
 * Masked pixels, switched-off panels and directions the sample environment
 * blocks (acceptance.ts) record nothing: their cells are NaN, and ring traces
 * break there.
 */
import type { Vec3 } from "@materia/core/math/types";
import { NEUTRON_MASS_OVER_H } from "../diffraction/tof.ts";
import { panelHit, recordsAt, type Blocked, type DetectorPanel } from "./detectors.ts";
import { panelCylinderPolygons } from "./simulate.ts";

const DEG = Math.PI / 180;
const FWHM_TO_SIGMA = 1 / (2 * Math.sqrt(2 * Math.LN2));

/** Time-of-flight slice (µs) or fixed incident wavelength (Å). */
export type RingSlice = { readonly tof: number } | { readonly lambda: number };

export interface RingProfile {
  readonly kind: "tof" | "fixed";
  /** ln d of the first bin and the bin width in ln d. */
  readonly lnMin: number;
  readonly step: number;
  /** Σ w_g·G(ln d − ln d_g), scaled so the largest value is 1. */
  readonly values: Float64Array;
}

/**
 * Line profile in ln d. `fwhm` is the relative FWHM (Δd/d) of every line;
 * weights are Σ|F|²·d⁴ (TOF) or Σ|F|²·d³ (fixed λ), the d-dependent part of
 * the intensities above.
 */
export function ringProfile(groups: readonly { readonly d: number; readonly sumF2: number }[], kind: "tof" | "fixed", fwhm: number): RingProfile {
  const sigma = Math.max(1e-5, fwhm) * FWHM_TO_SIGMA;
  const step = sigma / 4;
  if (groups.length === 0) return { kind, lnMin: 0, step, values: new Float64Array(1) };
  const lnDs = groups.map((g) => Math.log(g.d));
  const lnMin = Math.min(...lnDs) - 6 * sigma;
  const n = Math.min(2_000_000, Math.ceil((Math.max(...lnDs) + 6 * sigma - lnMin) / step) + 1);
  const values = new Float64Array(n);
  const reach = Math.ceil((5 * sigma) / step);
  const norm = 1 / (sigma * Math.sqrt(2 * Math.PI));
  groups.forEach((g, k) => {
    const w = g.sumF2 * g.d ** (kind === "tof" ? 4 : 3) * norm;
    const c = (lnDs[k]! - lnMin) / step;
    const i0 = Math.max(0, Math.floor(c) - reach);
    const i1 = Math.min(n - 1, Math.ceil(c) + reach);
    for (let i = i0; i <= i1; i++) {
      const z = ((i - c) * step) / sigma;
      values[i]! += w * Math.exp(-0.5 * z * z);
    }
  });
  let max = 0;
  for (const v of values) max = Math.max(max, v);
  if (max > 0) for (let i = 0; i < n; i++) values[i]! /= max;
  return { kind, lnMin, step, values };
}

function profileAt(p: RingProfile, d: number): number {
  const x = (Math.log(d) - p.lnMin) / p.step;
  if (!(x >= 0) || x >= p.values.length - 1) return 0;
  const i = Math.floor(x);
  const f = x - i;
  return p.values[i]! * (1 - f) + p.values[i + 1]! * f;
}

/** Wavelength an element with flight path L (m) records in the slice. */
export function sliceLambda(slice: RingSlice, flightPathM: number): number {
  return "tof" in slice ? slice.tof / (NEUTRON_MASS_OVER_H * flightPathM) : slice.lambda;
}

/** Relative intensity per unit solid angle at an element (2θ in degrees, flight path L1 + L2 in m). */
export function ringIntensity(p: RingProfile, slice: RingSlice, twoThetaDeg: number, flightPathM: number): number {
  const s = Math.sin((twoThetaDeg * DEG) / 2);
  if (!(s > 0)) return 0;
  const d = sliceLambda(slice, flightPathM) / (2 * s);
  // The fixed-λ factor 1/sin³θ is folded into the d³ weights (sinθ = λ/2d at the line).
  return p.kind === "tof" ? profileAt(p, d) * s : profileAt(p, d);
}

export interface ElementCells {
  /** Scattering angle 2θ (deg) and sample–element distance L2 (m) per cell; NaN off the detectors. */
  readonly twoTheta: Float32Array;
  readonly l2: Float32Array;
}

const twoThetaOf = (v: Vec3) => Math.acos(Math.max(-1, Math.min(1, v[2] / Math.hypot(...v)))) / DEG;

/** Cell centres of a panel on an nx × ny grid, row-major from the (−w/2, −h/2) corner with rows along `up`; NaN where nothing records. */
export function panelCells(p: DetectorPanel, nx: number, ny: number, blocked?: Blocked): ElementCells {
  const twoTheta = new Float32Array(nx * ny);
  const l2 = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const x = ((i + 0.5) / nx - 0.5) * p.width;
      const y = ((j + 0.5) / ny - 0.5) * p.height;
      const v: Vec3 = [p.center[0] + x * p.base[0] + y * p.up[0], p.center[1] + x * p.base[1] + y * p.up[1], p.center[2] + x * p.base[2] + y * p.up[2]];
      const r = Math.hypot(...v);
      const records = recordsAt(p, x, y) && !blocked?.(v[0] / r, v[1] / r, v[2] / r);
      twoTheta[j * nx + i] = records ? twoThetaOf(v) : NaN;
      l2[j * nx + i] = records ? r : NaN;
    }
  return { twoTheta, l2 };
}

/**
 * The unrolled detector map (simulate.ts) as a width × height raster over
 * γ ∈ [−180°, 180°], ν ∈ [ν_max, −ν_max] (top row first): each cell holds the
 * nearest panel its direction hits, or NaN.
 */
export function mapCells(panels: readonly DetectorPanel[], width: number, height: number, nuMax: number, blocked?: Blocked): ElementCells & { readonly panel: Int16Array } {
  const n = width * height;
  const twoTheta = new Float32Array(n).fill(NaN);
  const l2 = new Float32Array(n).fill(Infinity);
  const panel = new Int16Array(n).fill(-1);
  const col = (g: number) => ((g + 180) / 360) * width - 0.5;
  const row = (nu: number) => ((nuMax - nu) / (2 * nuMax)) * height - 0.5;
  panels.forEach((p, k) => {
    for (const poly of panelCylinderPolygons(p)) {
      const gs = poly.map((q) => q[0]);
      const ns = poly.map((q) => q[1]);
      const i0 = Math.max(0, Math.floor(col(Math.min(...gs))) - 1);
      const i1 = Math.min(width - 1, Math.ceil(col(Math.max(...gs))) + 1);
      const j0 = Math.max(0, Math.floor(row(Math.max(...ns))) - 1);
      const j1 = Math.min(height - 1, Math.ceil(row(Math.min(...ns))) + 1);
      for (let j = j0; j <= j1; j++) {
        const nu = (nuMax - ((j + 0.5) / height) * 2 * nuMax) * DEG;
        for (let i = i0; i <= i1; i++) {
          const g = (-180 + ((i + 0.5) / width) * 360) * DEG;
          const u: Vec3 = [Math.cos(nu) * Math.sin(g), Math.sin(nu), Math.cos(nu) * Math.cos(g)];
          const h = panelHit(p, u);
          const c = j * width + i;
          if (!h || h.t >= l2[c]!) continue;
          l2[c] = h.t;
          twoTheta[c] = Math.acos(Math.max(-1, Math.min(1, u[2]))) / DEG;
          panel[c] = k;
        }
      }
    }
  });
  for (let c = 0; c < n; c++) {
    if (panel[c]! < 0) {
      l2[c] = NaN;
      continue;
    }
    // The nearest panel stops the ray: nothing is recorded when it is masked there or the direction is blocked.
    const p = panels[panel[c]!]!;
    if (!p.off && !p.mask && !blocked) continue;
    const nu = (nuMax - ((Math.floor(c / width) + 0.5) / height) * 2 * nuMax) * DEG;
    const g = (-180 + (((c % width) + 0.5) / width) * 360) * DEG;
    const u: Vec3 = [Math.cos(nu) * Math.sin(g), Math.sin(nu), Math.cos(nu) * Math.cos(g)];
    const h = panelHit(p, u);
    if (h && recordsAt(p, h.x, h.y) && !blocked?.(u[0], u[1], u[2])) continue;
    panel[c] = -1;
    twoTheta[c] = NaN;
    l2[c] = NaN;
  }
  return { twoTheta, l2, panel };
}

/**
 * Where one d-spacing's ring meets the detectors in a slice, by ray tracing:
 * for each azimuth φ about the beam, solve λ(L1 + L2) = 2d·sinθ for 2θ
 * (iterating L2 from the panel hit; exact in one step for a fixed λ). Returns
 * polylines of hit positions (lab frame, m), split where the ring leaves a
 * panel. Independent of the element grids, so it checks the ring images.
 */
export function ringTrace(panels: readonly DetectorPanel[], l1: number, slice: RingSlice, d: number, nPhi = 720, blocked?: Blocked): { panel: number; points: Vec3[] }[] {
  const out: { panel: number; points: Vec3[] }[] = [];
  let cur: { panel: number; points: Vec3[] } | undefined;
  for (let k = 0; k <= nPhi; k++) {
    const phi = (2 * Math.PI * k) / nPhi;
    let lambda = sliceLambda(slice, l1);
    let hit: { panel: number; position: Vec3 } | undefined;
    for (let iter = 0; iter < 8; iter++) {
      const s = lambda / (2 * d);
      if (!(s > 0 && s <= 1)) {
        hit = undefined;
        break;
      }
      const tt = 2 * Math.asin(s);
      const u: Vec3 = [Math.sin(tt) * Math.cos(phi), Math.sin(tt) * Math.sin(phi), Math.cos(tt)];
      let best: { panel: number; t: number; records: boolean } | undefined;
      panels.forEach((p, i) => {
        const h = panelHit(p, u);
        if (h && (!best || h.t < best.t)) best = { panel: i, t: h.t, records: recordsAt(p, h.x, h.y) };
      });
      const b = best as { panel: number; t: number; records: boolean } | undefined;
      if (!b || !b.records || blocked?.(u[0], u[1], u[2])) {
        hit = undefined;
        break;
      }
      hit = { panel: b.panel, position: [u[0] * b.t, u[1] * b.t, u[2] * b.t] };
      const next = sliceLambda(slice, l1 + b.t);
      if (Math.abs(next - lambda) <= 1e-12 * lambda) break;
      lambda = next;
    }
    if (!hit) {
      cur = undefined;
      continue;
    }
    if (!cur || cur.panel !== hit.panel) {
      cur = { panel: hit.panel, points: [] };
      out.push(cur);
    }
    cur.points.push(hit.position);
  }
  return out;
}

/**
 * Elastic (fixed-λ) powder pattern over 2θ (deg), as a chopper spectrometer
 * records it: each peak a unit-area Gaussian of FWHM 2·tanθ·(Δd/d) (Bragg's
 * law at fixed λ, in degrees) times its integrated intensity, and zero outside
 * the `covered` 2θ intervals (gaps between detectors).
 */
export function elasticPattern(peaks: readonly { readonly twoTheta?: number | undefined; readonly intensity: number }[], relFwhm: number, covered: readonly (readonly [number, number])[]): { x: Float64Array; y: Float64Array } {
  const lo = Math.min(...covered.map((c) => c[0]));
  const hi = Math.max(...covered.map((c) => c[1]));
  const width = (tt: number) => 2 * Math.tan((tt * DEG) / 2) * relFwhm / DEG;
  const shown = peaks.filter((p) => p.twoTheta !== undefined && p.twoTheta > 0 && p.twoTheta < 180);
  if (!shown.length || !(hi > lo)) return { x: new Float64Array(), y: new Float64Array() };
  const step = Math.max((hi - lo) / 200_000, Math.min(...shown.map((p) => width(p.twoTheta!))) / 8);
  const n = Math.floor((hi - lo) / step) + 1;
  const x = Float64Array.from({ length: n }, (_, i) => lo + i * step);
  const y = new Float64Array(n);
  for (const p of shown) {
    const sigma = width(p.twoTheta!) * FWHM_TO_SIGMA;
    const i0 = Math.max(0, Math.floor((p.twoTheta! - 6 * sigma - lo) / step));
    const i1 = Math.min(n - 1, Math.ceil((p.twoTheta! + 6 * sigma - lo) / step));
    const norm = p.intensity / (sigma * Math.sqrt(2 * Math.PI));
    for (let i = i0; i <= i1; i++) y[i]! += norm * Math.exp(-0.5 * ((x[i]! - p.twoTheta!) / sigma) ** 2);
  }
  for (let i = 0; i < n; i++) if (!covered.some(([a, b]) => x[i]! >= a && x[i]! <= b)) y[i] = 0;
  return { x, y };
}
