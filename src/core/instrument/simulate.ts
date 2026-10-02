/**
 * Experiment simulation on top of the detector geometry.
 *
 *  - Angles: a lab direction u has 2θ = angle from the beam (+z) and azimuth φ
 *    = atan2(u_y, u_x) about the beam, the convention of the peaks files.
 *  - Single crystal: for each goniometer setting, a reflection is observed when
 *    its Laue wavelength is in the band and its scattered ray hits a panel.
 *    Completeness counts symmetry families (point-group orbits) with at least
 *    one observed member, over all families present in the reflection list.
 *  - Powder (sample fixed): a reflection of spacing d reaches a pixel at angle
 *    2θ when λ = 2d·sinθ lies in the band; each panel calibrates as
 *    DIFC = (m_n/h)·(L1 + L2)·2 sinθ at its centre.
 *  - Detector map: the "unrolled cylinder" of the Mantid instrument view with
 *    the axis vertical: γ = atan2(u_x, u_z) in the horizontal plane (0 along
 *    the beam, +90° towards +x) and elevation ν = asin(u_y).
 */
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { mulMat, mulVec } from "@materia/core/math/mat3";
import { difcFromGeometry } from "../diffraction/tof.ts";
import { goniometerMatrix, laueCondition, type GoniometerModel } from "../ub/goniometer.ts";
import { rayHit, type DetectorHit, type DetectorPanel } from "./detectors.ts";

const DEG = 180 / Math.PI;

export function directionAngles(u: Vec3): { twoTheta: number; azimuth: number } {
  const n = Math.hypot(...u);
  return { twoTheta: Math.acos(Math.max(-1, Math.min(1, u[2] / n))) * DEG, azimuth: Math.atan2(u[1], u[0]) * DEG };
}

/** Unrolled-cylinder angles (deg) of a lab direction: γ about the vertical from the beam, ν above the horizontal plane. */
export function cylinderAngles(u: Vec3): { gamma: number; nu: number } {
  return { gamma: Math.atan2(u[0], u[2]) * DEG, nu: Math.atan2(u[1], Math.hypot(u[0], u[2])) * DEG };
}

/**
 * A panel outline in unrolled-cylinder angles (γ, ν), unwrapped about its
 * centre, plus copies shifted by ±360° when it crosses the γ = ±180° seam.
 */
export function panelCylinderPolygons(p: DetectorPanel, perEdge = 8): [number, number][][] {
  const g0 = cylinderAngles(p.center).gamma;
  const poly = panelOutline(p, perEdge).map((u): [number, number] => {
    const { gamma, nu } = cylinderAngles(u);
    return [gamma + 360 * Math.round((g0 - gamma) / 360), nu];
  });
  const gs = poly.map((q) => q[0]);
  const out = [poly];
  if (Math.min(...gs) < -180) out.push(poly.map(([g, n]): [number, number] => [g + 360, n]));
  if (Math.max(...gs) > 180) out.push(poly.map(([g, n]): [number, number] => [g - 360, n]));
  return out;
}

/** Directions on the cone at scattering angle 2θ about the beam (a Debye–Scherrer ring), lab frame. */
export function coneDirections(twoThetaDeg: number, n = 180): Vec3[] {
  const t = twoThetaDeg / DEG;
  return Array.from({ length: n + 1 }, (_, k) => {
    const phi = (2 * Math.PI * k) / n;
    return [Math.sin(t) * Math.cos(phi), Math.sin(t) * Math.sin(phi), Math.cos(t)] as Vec3;
  });
}

/** 2θ range (deg) over which spacing d diffracts for the band: sinθ = λ/(2d); undefined when λmin > 2d. */
export function twoThetaRangeForD(d: number, lambdaMin: number, lambdaMax: number): { min: number; max: number } | undefined {
  const lo = lambdaMin / (2 * d);
  if (lo > 1) return undefined;
  return { min: 2 * Math.asin(lo) * DEG, max: 2 * Math.asin(Math.min(1, lambdaMax / (2 * d))) * DEG };
}

/** Panels (indices) whose 2θ span overlaps the range where spacing d diffracts. */
export function panelsSeeing(d: number, angles: readonly PanelAngles[], lambdaMin: number, lambdaMax: number): number[] {
  const r = twoThetaRangeForD(d, lambdaMin, lambdaMax);
  if (!r) return [];
  const out: number[] = [];
  angles.forEach((a, i) => {
    if (a.twoThetaMax >= r.min && a.twoThetaMin <= r.max) out.push(i);
  });
  return out;
}

/** Union of the panels' 2θ spans, as sorted disjoint intervals (deg). */
export function coveredTwoTheta(angles: readonly PanelAngles[]): [number, number][] {
  const iv = angles.map((a) => [a.twoThetaMin, a.twoThetaMax] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of iv) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Panel outline sampled along its edges (for drawing in angle space), lab frame. */
export function panelOutline(p: DetectorPanel, perEdge = 12): Vec3[] {
  const pts: Vec3[] = [];
  const corner = (sx: number, sy: number): Vec3 => [
    p.center[0] + (sx * p.width * p.base[0]) / 2 + (sy * p.height * p.up[0]) / 2,
    p.center[1] + (sx * p.width * p.base[1]) / 2 + (sy * p.height * p.up[1]) / 2,
    p.center[2] + (sx * p.width * p.base[2]) / 2 + (sy * p.height * p.up[2]) / 2,
  ];
  const cs: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  for (let e = 0; e < 4; e++) {
    const [ax, ay] = cs[e]!;
    const [bx, by] = cs[(e + 1) % 4]!;
    for (let k = 0; k < perEdge; k++) {
      const t = k / perEdge;
      pts.push(corner(ax + (bx - ax) * t, ay + (by - ay) * t));
    }
  }
  return pts;
}

export interface PanelAngles {
  readonly twoThetaMin: number;
  readonly twoThetaMax: number;
  readonly twoThetaCenter: number;
  readonly azimuthCenter: number;
  /** Sample-to-centre distance (m). */
  readonly l2: number;
}

/** 2θ range of a panel (from a 9×9 grid over its face), its centre angles and distance. */
export function panelAngles(p: DetectorPanel): PanelAngles {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i <= 8; i++)
    for (let j = 0; j <= 8; j++) {
      const sx = i / 4 - 1;
      const sy = j / 4 - 1;
      const v: Vec3 = [
        p.center[0] + (sx * p.width * p.base[0]) / 2 + (sy * p.height * p.up[0]) / 2,
        p.center[1] + (sx * p.width * p.base[1]) / 2 + (sy * p.height * p.up[1]) / 2,
        p.center[2] + (sx * p.width * p.base[2]) / 2 + (sy * p.height * p.up[2]) / 2,
      ];
      const t = directionAngles(v).twoTheta;
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
  const c = directionAngles(p.center);
  return { twoThetaMin: lo, twoThetaMax: hi, twoThetaCenter: c.twoTheta, azimuthCenter: c.azimuth, l2: Math.hypot(...p.center) };
}

/** d-spacings a pixel at 2θ sees for the wavelength band: λ = 2d·sinθ. */
export function dRangeAt(twoThetaDeg: number, lambdaMin: number, lambdaMax: number): { dMin: number; dMax: number } {
  const s = Math.sin((twoThetaDeg * Math.PI) / 360);
  return { dMin: lambdaMin / (2 * s), dMax: lambdaMax / (2 * s) };
}

/** TOF calibration of a panel at its centre. */
export function panelDifc(p: DetectorPanel, l1: number): number {
  const a = panelAngles(p);
  return difcFromGeometry(l1 + a.l2, a.twoThetaCenter);
}

export interface ScanReflection {
  readonly h: Vec3;
  readonly family: number;
}

export interface ScanStep {
  readonly angles: readonly number[];
  readonly observed: number;
  /** Families observed so far (cumulative) / all families. */
  readonly completeness: number;
}

export interface ObservedReflection {
  readonly index: number;
  readonly lambda: number;
  readonly twoTheta: number;
  readonly azimuth: number;
  readonly hit: DetectorHit;
}

/** Reflections observed at one goniometer setting R. */
export function observeAt(R: Mat3, UB: Mat3, refl: readonly ScanReflection[], panels: readonly DetectorPanel[], lambdaMin: number, lambdaMax: number): ObservedReflection[] {
  const RUB = mulMat(R, UB);
  const out: ObservedReflection[] = [];
  refl.forEach((r, index) => {
    const s = laueCondition(mulVec(RUB, r.h));
    if (!(s.lambda >= lambdaMin && s.lambda <= lambdaMax)) return;
    const hit = rayHit(panels, s.kf);
    if (hit) out.push({ index, lambda: s.lambda, twoTheta: s.twoTheta, azimuth: s.azimuth, hit });
  });
  return out;
}

/**
 * Rotation scan: the scanned axis steps from `start` to `end` (inclusive) by
 * `step`; the other axes stay at `baseAngles`. Returns per-step counts and the
 * cumulative family completeness.
 */
export function simulateScan(
  model: GoniometerModel,
  axisIndex: number,
  baseAngles: readonly number[],
  range: { start: number; end: number; step: number },
  UB: Mat3,
  refl: readonly ScanReflection[],
  panels: readonly DetectorPanel[],
  lambdaMin: number,
  lambdaMax: number,
): { steps: ScanStep[]; families: number; observedFamilies: number } {
  const families = new Set(refl.map((r) => r.family)).size;
  const seen = new Set<number>();
  const steps: ScanStep[] = [];
  const n = Math.max(1, Math.floor((range.end - range.start) / range.step + 1e-9) + 1);
  if (n > 3600) throw new Error("A scan is limited to 3600 orientations; use a larger step.");
  for (let k = 0; k < n; k++) {
    const angles = baseAngles.map((v, i) => (i === axisIndex ? range.start + k * range.step : v));
    const obs = observeAt(goniometerMatrix(model, angles), UB, refl, panels, lambdaMin, lambdaMax);
    for (const o of obs) seen.add(refl[o.index]!.family);
    steps.push({ angles, observed: obs.length, completeness: families ? seen.size / families : 0 });
  }
  return { steps, families, observedFamilies: seen.size };
}

export interface BraggCrossing {
  /** Index into the reflection list. */
  readonly index: number;
  /** Scanned-axis angle (deg) at which the reflection meets the Bragg condition. */
  readonly angle: number;
  readonly hit: DetectorHit | undefined;
}

/**
 * Monochromatic rotation (chopper spectrometer, elastic line): the angles of
 * the scanned axis at which each reflection meets λ = −2q_z/|q|² exactly.
 * Rotating about one axis leaves |q| fixed and makes q_z = C + P cosψ + Q sinψ
 * (C, P, Q from ψ = 0°, 90°, 180°, so any axis direction and sense works), so
 * q_z = −λ|q|²/2 has at most two solutions per turn. Returns every crossing in
 * [start, end] with the detector it hits (undefined when it misses).
 */
export function braggCrossings(
  model: GoniometerModel,
  axisIndex: number,
  baseAngles: readonly number[],
  range: { start: number; end: number },
  UB: Mat3,
  refl: readonly ScanReflection[],
  panels: readonly DetectorPanel[],
  lambda: number,
): BraggCrossing[] {
  const at = (deg: number) => mulMat(goniometerMatrix(model, baseAngles.map((v, i) => (i === axisIndex ? deg : v))), UB);
  const [R0, R90, R180] = [at(0), at(90), at(180)];
  const out: BraggCrossing[] = [];
  refl.forEach((r, index) => {
    const z0 = mulVec(R0, r.h)[2];
    const z90 = mulVec(R90, r.h)[2];
    const z180 = mulVec(R180, r.h)[2];
    const q = mulVec(R0, r.h);
    const q2 = q[0] * q[0] + q[1] * q[1] + q[2] * q[2];
    if (q2 === 0) return;
    const C = (z0 + z180) / 2;
    const P = (z0 - z180) / 2;
    const Q = z90 - C;
    const amp = Math.hypot(P, Q);
    const c = (-lambda * q2) / 2 - C;
    if (!(amp > 0) || Math.abs(c) > amp) return;
    const phase = Math.atan2(Q, P) * DEG;
    const half = Math.acos(c / amp) * DEG;
    for (const base of half === 0 ? [phase] : [phase + half, phase - half]) {
      // Every copy of this solution inside the range.
      let a = base + 360 * Math.ceil((range.start - base) / 360 - 1e-12);
      for (; a <= range.end + 1e-9; a += 360) {
        const s = laueCondition(mulVec(at(a), r.h));
        out.push({ index, angle: a, hit: Number.isFinite(s.lambda) ? rayHit(panels, s.kf) : undefined });
      }
    }
  });
  return out.sort((x, y) => x.angle - y.angle);
}

/** Bin Bragg crossings into scan steps: reflections on the detectors per step and cumulative family completeness. */
export function crossingsToScan(
  crossings: readonly BraggCrossing[],
  refl: readonly ScanReflection[],
  axisIndex: number,
  baseAngles: readonly number[],
  range: { start: number; end: number; step: number },
): { steps: ScanStep[]; families: number; observedFamilies: number } {
  const families = new Set(refl.map((r) => r.family)).size;
  const n = Math.max(1, Math.floor((range.end - range.start) / range.step + 1e-9) + 1);
  if (n > 3600) throw new Error("A scan is limited to 3600 steps; use a larger step.");
  const seen = new Set<number>();
  const steps: ScanStep[] = [];
  let k = 0;
  const hits = crossings.filter((c) => c.hit);
  for (let s = 0; s < n; s++) {
    const centre = range.start + s * range.step;
    const upper = s === n - 1 ? Infinity : centre + range.step / 2;
    let observed = 0;
    while (k < hits.length && hits[k]!.angle < upper) {
      seen.add(refl[hits[k]!.index]!.family);
      observed++;
      k++;
    }
    steps.push({ angles: baseAngles.map((v, i) => (i === axisIndex ? centre : v)), observed, completeness: families ? seen.size / families : 0 });
  }
  return { steps, families, observedFamilies: seen.size };
}

export interface CoveragePoint {
  /** Index into the reflection list. */
  readonly index: number;
  /** Goniometer angles (deg) of this setting. */
  readonly angles: readonly number[];
  readonly lambda: number;
  readonly hit: DetectorHit;
}

/**
 * Where reflections can be recorded as the free goniometer axes sweep their
 * ranges: the "individual peak" coverage of NeuXtalViz's experiment planner
 * (neutrons/NeuXtalViz-tools models/experiment_planner.py, calculate_individual_peak
 * @ 655afa3). Settings form a grid with `step` degrees, doubled for each extra
 * free axis; each axis spans at most one turn. A setting counts when
 * λ = −2q_z/|q|² is in the band and k_f hits a panel.
 */
export function reflectionCoverage(
  model: GoniometerModel,
  baseAngles: readonly number[],
  UB: Mat3,
  refl: readonly { readonly h: Vec3 }[],
  panels: readonly DetectorPanel[],
  lambdaMin: number,
  lambdaMax: number,
  step = 1,
  maxSettings = 200_000,
): { points: CoveragePoint[]; settings: number; step: number } {
  const free = model.axes.map((ax, i) => ({ ax, i })).filter(({ ax }) => ax.fixed === undefined);
  const st = step * 2 ** Math.max(0, free.length - 1);
  const values = free.map(({ ax }) => {
    const span = Math.min(ax.max - ax.min, 360);
    const n = Math.max(1, Math.floor(span / st + 1e-9) + (span >= 360 - 1e-9 ? 0 : 1));
    return Array.from({ length: n }, (_, k) => ax.min + k * st);
  });
  const settings = values.reduce((n, v) => n * v.length, 1);
  if (settings > maxSettings) throw new Error(`Coverage needs ${settings.toLocaleString()} goniometer settings; use a larger step.`);
  const points: CoveragePoint[] = [];
  const idx = new Array<number>(free.length).fill(0);
  for (let s = 0; s < settings; s++) {
    const angles = baseAngles.slice();
    free.forEach(({ i }, k) => (angles[i] = values[k]![idx[k]!]!));
    const RUB = mulMat(goniometerMatrix(model, angles), UB);
    refl.forEach((r, index) => {
      const l = laueCondition(mulVec(RUB, r.h));
      if (!(l.lambda >= lambdaMin && l.lambda <= lambdaMax)) return;
      const hit = rayHit(panels, l.kf);
      if (hit) points.push({ index, angles, lambda: l.lambda, hit });
    });
    for (let k = free.length - 1; k >= 0; k--) {
      if (++idx[k]! < values[k]!.length) break;
      idx[k] = 0;
    }
  }
  return { points, settings, step: st };
}
