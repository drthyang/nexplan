/**
 * Choosing an orientation list (TOPAZ: about ten settings, wanted peaks first).
 *
 *  1. Candidates: a grid over the free goniometer axes within their ranges
 *     (at most one turn each; the user can narrow the ranges), with the step
 *     the smallest of 1°, 2°, 3°, … that keeps the grid under a size limit.
 *     Fixed axes stay at their values.
 *  2. For each candidate, the symmetry families it records: λ = −2q_z/|q|² in
 *     the band and k_f on a panel (the same test as observeAt, with each panel's
 *     angular extent checked first), and how it records each wanted reflection:
 *     well placed (λ near mid band, away from the panel edges), recorded, or not.
 *  3. Greedy maximum coverage: add the candidate that places the most wanted
 *     reflections well that were not yet, then records the most wanted ones not
 *     yet recorded, then the most new families; once every reachable family is
 *     recorded, the most second and then third recordings (redundancy). Greedy
 *     is within (1 − 1/e) of the best coverage for the same number of settings
 *     (Nemhauser, Wolsey & Fisher, Math. Program. 14, 265 (1978)). Settings
 *     already in the list count as measured, so suggestions extend it.
 *
 * A wanted reflection is a set of equivalent hkl (its symmetry family in the
 * reflection list), or a single hkl when it is not in the list (absent, weak or
 * beyond the strongest kept); any member recorded counts.
 */
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { mulVec } from "@materia/core/math/mat3";
import { goniometerMatrix, type GoniometerModel } from "../ub/goniometer.ts";
import type { DetectorPanel } from "./detectors.ts";

const NICE_STEPS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 45, 60, 90];

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const n = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / n, a[1] / n, a[2] / n];
};

/** Grid of goniometer settings over the free axes (≤ maxCandidates), and its step (deg). */
export function candidateGrid(model: GoniometerModel, base: readonly number[], maxCandidates = 6000): { settings: number[][]; step: number } {
  const free = model.axes.flatMap((ax, i) => (ax.fixed === undefined ? [i] : []));
  const fixedAt = (i: number) => model.axes[i]!.fixed ?? base[i] ?? 0;
  if (!free.length) return { settings: [model.axes.map((_, i) => fixedAt(i))], step: 0 };
  const counts = (step: number) =>
    free.map((i) => {
      const ax = model.axes[i]!;
      const span = Math.min(ax.max - ax.min, 360);
      return span >= 360 ? Math.round(360 / step) : Math.floor(span / step + 1e-9) + 1;
    });
  const step = NICE_STEPS.find((s) => counts(s).reduce((a, b) => a * b, 1) <= maxCandidates) ?? 90;
  const n = counts(step);
  const settings: number[][] = [];
  const idx = free.map(() => 0);
  for (;;) {
    settings.push(
      model.axes.map((ax, i) => {
        const k = free.indexOf(i);
        return k < 0 ? fixedAt(i) : ax.min + idx[k]! * step;
      }),
    );
    let k = 0;
    while (k < free.length && ++idx[k]! >= n[k]!) idx[k++] = 0;
    if (k === free.length) break;
  }
  return { settings, step };
}

interface PreparedPanel {
  readonly n: Vec3;
  readonly cn: number;
  readonly c: Vec3;
  readonly base: Vec3;
  readonly up: Vec3;
  readonly hw: number;
  readonly hh: number;
  /** Unit vector to the centre, and the cosine of the largest angle from it to a corner. */
  readonly dir: Vec3;
  readonly cosR: number;
}

/**
 * A panel seen from the sample spans a spherical polygon whose farthest point
 * from the centre direction is a corner (distance along each great-circle edge
 * is unimodal), so the corner angle bounds the panel exactly.
 */
function preparePanel(p: DetectorPanel): PreparedPanel {
  const n = cross(p.base, p.up);
  const dir = unit(p.center);
  let cosR = 1;
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    const corner = [0, 1, 2].map((k) => p.center[k]! + (sx * p.width * p.base[k]!) / 2 + (sy * p.height * p.up[k]!) / 2) as unknown as Vec3;
    cosR = Math.min(cosR, dot(dir, unit(corner)));
  }
  return { n, cn: dot(p.center, n), c: p.center, base: p.base, up: p.up, hw: p.width / 2, hh: p.height / 2, dir, cosR: cosR - 1e-9 };
}

/**
 * The panel hit along unit u, as the larger of |x|/(w/2) and |y|/(h/2) of the hit
 * from the panel centre (0 at the centre, 1 at an edge); −1 when nothing is hit.
 */
function hitOffset(panels: readonly PreparedPanel[], ux: number, uy: number, uz: number): number {
  for (const p of panels) {
    if (ux * p.dir[0] + uy * p.dir[1] + uz * p.dir[2] < p.cosR) continue;
    const denom = ux * p.n[0] + uy * p.n[1] + uz * p.n[2];
    if (Math.abs(denom) < 1e-12) continue;
    const t = p.cn / denom;
    if (!(t > 0)) continue;
    const dx = ux * t - p.c[0];
    const dy = uy * t - p.c[1];
    const dz = uz * t - p.c[2];
    const fx = Math.abs(dx * p.base[0] + dy * p.base[1] + dz * p.base[2]) / p.hw;
    const fy = Math.abs(dx * p.up[0] + dy * p.up[1] + dz * p.up[2]) / p.hh;
    if (fx <= 1 && fy <= 1) return Math.max(fx, fy);
  }
  return -1;
}

export interface PlanTarget {
  readonly h: Vec3;
  readonly family: number;
}

/** Targets with q = UB·h precomputed and families renumbered 0…F−1 (ids[dense] is the original id). */
interface Compiled {
  readonly q: Float64Array;
  readonly q2: Float64Array;
  readonly fam: Int32Array;
  readonly ids: readonly number[];
}

function compile(UB: Mat3, targets: readonly PlanTarget[]): Compiled {
  const dense = new Map<number, number>();
  const q = new Float64Array(3 * targets.length);
  const q2 = new Float64Array(targets.length);
  const fam = new Int32Array(targets.length);
  targets.forEach((t, i) => {
    const v = mulVec(UB, t.h);
    q.set(v, 3 * i);
    q2[i] = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    if (!dense.has(t.family)) dense.set(t.family, dense.size);
    fam[i] = dense.get(t.family)!;
  });
  return { q, q2, fam, ids: [...dense.keys()] };
}

/**
 * Where reflection i of `c` lands at setting R: its λ and the hit offset from
 * the panel centre (hitOffset), or undefined when it is not recorded.
 */
function landing(R: Mat3, c: Compiled, i: number, panels: readonly PreparedPanel[], lambdaMin: number, lambdaMax: number): { lambda: number; offset: number } | undefined {
  const a = c.q[3 * i]!;
  const b = c.q[3 * i + 1]!;
  const d = c.q[3 * i + 2]!;
  const z = R[2][0] * a + R[2][1] * b + R[2][2] * d;
  const q2 = c.q2[i]!;
  if (!(z < 0) || q2 === 0) return undefined;
  const lambda = (-2 * z) / q2;
  if (!(lambda >= lambdaMin && lambda <= lambdaMax)) return undefined;
  const x = R[0][0] * a + R[0][1] * b + R[0][2] * d;
  const y = R[1][0] * a + R[1][1] * b + R[1][2] * d;
  const kz = 1 / lambda + z;
  const n = Math.hypot(x, y, kz);
  const offset = hitOffset(panels, x / n, y / n, kz / n);
  return offset < 0 ? undefined : { lambda, offset };
}

/** Dense families recorded at goniometer setting R (the landing test, inlined without allocation). */
function familiesAt(R: Mat3, c: Compiled, panels: readonly PreparedPanel[], lambdaMin: number, lambdaMax: number, stamp: Int32Array, gen: number): Int32Array {
  const out: number[] = [];
  const [r0, r1, r2] = R;
  for (let i = 0; i < c.fam.length; i++) {
    const f = c.fam[i]!;
    if (stamp[f] === gen) continue;
    const a = c.q[3 * i]!;
    const b = c.q[3 * i + 1]!;
    const d = c.q[3 * i + 2]!;
    const z = r2[0] * a + r2[1] * b + r2[2] * d;
    const q2 = c.q2[i]!;
    if (!(z < 0) || q2 === 0) continue;
    const lambda = (-2 * z) / q2;
    if (!(lambda >= lambdaMin && lambda <= lambdaMax)) continue;
    const x = r0[0] * a + r0[1] * b + r0[2] * d;
    const y = r1[0] * a + r1[1] * b + r1[2] * d;
    const kz = 1 / lambda + z;
    const n = Math.hypot(x, y, kz);
    if (hitOffset(panels, x / n, y / n, kz / n) >= 0) {
      stamp[f] = gen;
      out.push(f);
    }
  }
  return Int32Array.from(out);
}

/**
 * What makes a recording of a wanted reflection well placed: λ within
 * bandFraction·(λmax − λmin)/2 of mid band, and the hit at least edgeFraction
 * of the panel's width and height from every edge.
 */
export interface Placement {
  readonly bandFraction: number;
  readonly edgeFraction: number;
}

export const DEFAULT_PLACEMENT: Placement = { bandFraction: 0.5, edgeFraction: 0.1 };

/** 0: not recorded; 1: recorded; 2: recorded and well placed (best over the members). */
function placementLevel(R: Mat3, members: Compiled, panels: readonly PreparedPanel[], lambdaMin: number, lambdaMax: number, placement: Placement): 0 | 1 | 2 {
  const mid = (lambdaMin + lambdaMax) / 2;
  const halfWidth = (placement.bandFraction * (lambdaMax - lambdaMin)) / 2;
  const maxOffset = 1 - 2 * placement.edgeFraction;
  let level: 0 | 1 | 2 = 0;
  for (let i = 0; i < members.fam.length; i++) {
    const hit = landing(R, members, i, panels, lambdaMin, lambdaMax);
    if (!hit) continue;
    if (Math.abs(hit.lambda - mid) <= halfWidth + 1e-12 && hit.offset <= maxOffset + 1e-12) return 2;
    level = 1;
  }
  return level;
}

const compileMembers = (UB: Mat3, members: readonly Vec3[]) => compile(UB, members.map((h) => ({ h, family: 0 })));

export interface GreedyPick {
  readonly index: number;
  /** Wanted reflections this pick places well for the first time, and records for the first time. */
  readonly wellPlaced: number;
  readonly wanted: number;
  /** New families, and families recorded for the second and the third time. */
  readonly families: number;
  readonly second: number;
  readonly third: number;
}

/**
 * Greedy coverage: up to n picks from `sets` (family ids per candidate). Each
 * pick maximises, in order, the wanted reflections it newly places well, the
 * wanted reflections it newly records (`wanted[i][w]`: level 0, 1 or 2 of wanted
 * reflection w at candidate i), the new families, the families it records for
 * the second and third time (redundancy, used for scaling and absorption
 * corrections), then the families it records in all. Stops when a pick would
 * add nothing on any of these. `covered` and `wantedBefore` describe settings
 * already measured.
 */
export function greedyCover(
  sets: readonly Int32Array[],
  n: number,
  opts: { readonly covered?: Iterable<number>; readonly wanted?: readonly Uint8Array[]; readonly wantedBefore?: Uint8Array } = {},
): GreedyPick[] {
  const dense = new Map<number, number>();
  const toDense = (id: number) => {
    if (!dense.has(id)) dense.set(id, dense.size);
    return dense.get(id)!;
  };
  const dsets = sets.map((set) => Int32Array.from(set, toDense));
  const covered = [...(opts.covered ?? [])].map(toDense);
  const nWanted = opts.wantedBefore?.length ?? opts.wanted?.[0]?.length ?? 0;
  return greedyDense(dsets, n, dense.size, covered, opts.wanted ?? sets.map(() => new Uint8Array(nWanted)), opts.wantedBefore ?? new Uint8Array(nWanted));
}

function greedyDense(sets: readonly Int32Array[], n: number, nIds: number, covered: readonly number[], wanted: readonly Uint8Array[], wantedBefore: Uint8Array): GreedyPick[] {
  const count = new Int32Array(nIds);
  for (const id of covered) count[id]!++;
  const best = Uint8Array.from(wantedBefore);
  const used = new Uint8Array(sets.length);
  const picks: GreedyPick[] = [];
  const g = new Float64Array(6);
  const b = new Float64Array(6);
  for (let step = 0; step < n; step++) {
    let pick = -1;
    for (let i = 0; i < sets.length; i++) {
      if (used[i]) continue;
      g.fill(0);
      const levels = wanted[i]!;
      for (let w = 0; w < levels.length; w++) {
        if (levels[w] === 2 && best[w]! < 2) g[0]!++;
        if (levels[w]! >= 1 && best[w] === 0) g[1]!++;
      }
      const set = sets[i]!;
      for (let k = 0; k < set.length; k++) {
        const c = count[set[k]!]!;
        if (c < 3) g[2 + c]!++;
      }
      g[5] = set.length;
      let better = pick < 0;
      for (let k = 0; !better && k < 6; k++) {
        if (g[k]! > b[k]!) better = true;
        else if (g[k]! < b[k]!) break;
      }
      if (better) {
        pick = i;
        b.set(g);
      }
    }
    if (pick < 0 || (b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0 && b[4] === 0)) break;
    used[pick] = 1;
    for (const id of sets[pick]!) count[id]!++;
    const levels = wanted[pick]!;
    for (let w = 0; w < levels.length; w++) best[w] = Math.max(best[w]!, levels[w]!);
    picks.push({ index: pick, wellPlaced: b[0]!, wanted: b[1]!, families: b[2]!, second: b[3]!, third: b[4]! });
  }
  return picks;
}

/** For each family, the number of the settings that record it. */
export function familyCounts(model: GoniometerModel, settings: readonly (readonly number[])[], UB: Mat3, targets: readonly PlanTarget[], panels: readonly DetectorPanel[], lambdaMin: number, lambdaMax: number): Map<number, number> {
  const prepared = panels.map(preparePanel);
  const c = compile(UB, targets);
  const stamp = new Int32Array(c.ids.length).fill(-1);
  const counts = new Map<number, number>();
  settings.forEach((s, k) => {
    for (const f of familiesAt(goniometerMatrix(model, s), c, prepared, lambdaMin, lambdaMax, stamp, k)) counts.set(c.ids[f]!, (counts.get(c.ids[f]!) ?? 0) + 1);
  });
  return counts;
}

/** For each wanted reflection (a set of equivalent hkl), the settings that record it, and those that place it well. */
export function wantedStatus(
  model: GoniometerModel,
  settings: readonly (readonly number[])[],
  UB: Mat3,
  wanted: readonly (readonly Vec3[])[],
  panels: readonly DetectorPanel[],
  lambdaMin: number,
  lambdaMax: number,
  placement: Placement = DEFAULT_PLACEMENT,
): { recorded: number; well: number }[] {
  const prepared = panels.map(preparePanel);
  const W = wanted.map((m) => compileMembers(UB, m));
  const out = W.map(() => ({ recorded: 0, well: 0 }));
  for (const s of settings) {
    const R = goniometerMatrix(model, s);
    W.forEach((m, w) => {
      const level = placementLevel(R, m, prepared, lambdaMin, lambdaMax, placement);
      if (level >= 1) out[w]!.recorded++;
      if (level === 2) out[w]!.well++;
    });
  }
  return out;
}

export interface SuggestInput {
  readonly model: GoniometerModel;
  /** Current angles: fixed axes are taken from the model, so only their count matters. */
  readonly base: readonly number[];
  readonly UB: Mat3;
  /** Reflections with their symmetry families (for completeness and redundancy). */
  readonly reflections: readonly PlanTarget[];
  /** Wanted reflections, each as its equivalent hkl. */
  readonly wanted: readonly (readonly Vec3[])[];
  readonly placement?: Placement;
  /** Settings already in the list (count as measured). */
  readonly existing: readonly (readonly number[])[];
  readonly panels: readonly DetectorPanel[];
  readonly lambdaMin: number;
  readonly lambdaMax: number;
  readonly n: number;
  readonly maxCandidates?: number;
}

export interface SuggestResult {
  readonly settings: number[][];
  readonly picks: GreedyPick[];
  readonly step: number;
  readonly candidates: number;
  /** Wanted reflections recorded, and placed well, by the existing list and by the list with the suggestions. */
  readonly wantedTotal: number;
  readonly recordedBefore: number;
  readonly recordedAfter: number;
  readonly wellBefore: number;
  readonly wellAfter: number;
}

export function suggestSettings(input: SuggestInput, onProgress?: (done: number, total: number) => void): SuggestResult {
  const panels = input.panels.map(preparePanel);
  const placement = input.placement ?? DEFAULT_PLACEMENT;
  const c = compile(input.UB, input.reflections);
  const W = input.wanted.map((m) => compileMembers(input.UB, m));
  const stamp = new Int32Array(c.ids.length).fill(-1);
  let gen = 0;
  const evaluate = (angles: readonly number[]) => {
    const R = goniometerMatrix(input.model, angles);
    return { families: familiesAt(R, c, panels, input.lambdaMin, input.lambdaMax, stamp, gen++), levels: Uint8Array.from(W, (m) => placementLevel(R, m, panels, input.lambdaMin, input.lambdaMax, placement)) };
  };
  const covered: number[] = [];
  const before = new Uint8Array(W.length);
  for (const s of input.existing) {
    const e = evaluate(s);
    covered.push(...e.families);
    e.levels.forEach((l, w) => (before[w] = Math.max(before[w]!, l)));
  }
  const grid = candidateGrid(input.model, input.base, input.maxCandidates);
  const sets: Int32Array[] = [];
  const levels: Uint8Array[] = [];
  const every = Math.max(1, Math.floor(grid.settings.length / 50));
  grid.settings.forEach((s, i) => {
    const e = evaluate(s);
    sets.push(e.families);
    levels.push(e.levels);
    if (onProgress && (i + 1) % every === 0) onProgress(i + 1, grid.settings.length);
  });
  const picks = greedyDense(sets, input.n, c.ids.length, covered, levels, before);
  const after = Uint8Array.from(before);
  for (const p of picks) levels[p.index]!.forEach((l, w) => (after[w] = Math.max(after[w]!, l)));
  const tally = (a: Uint8Array, min: number) => a.reduce((n, l) => n + (l >= min ? 1 : 0), 0);
  return {
    settings: picks.map((p) => grid.settings[p.index]!),
    picks,
    step: grid.step,
    candidates: grid.settings.length,
    wantedTotal: W.length,
    recordedBefore: tally(before, 1),
    recordedAfter: tally(after, 1),
    wellBefore: tally(before, 2),
    wellAfter: tally(after, 2),
  };
}

/** For each target, the number of settings that record it (same test as the search). */
export function targetCoverage(model: GoniometerModel, settings: readonly (readonly number[])[], UB: Mat3, targets: readonly PlanTarget[], panels: readonly DetectorPanel[], lambdaMin: number, lambdaMax: number): Uint16Array {
  const prepared = panels.map(preparePanel);
  const c = compile(UB, targets);
  const counts = new Uint16Array(targets.length);
  for (const s of settings) {
    const R = goniometerMatrix(model, s);
    targets.forEach((_, i) => {
      if (landing(R, c, i, prepared, lambdaMin, lambdaMax)) counts[i]!++;
    });
  }
  return counts;
}

/** For tests: the hit offset and λ of one hkl at one setting, through the same path as the search. */
export function landingOf(model: GoniometerModel, angles: readonly number[], UB: Mat3, h: Vec3, panels: readonly DetectorPanel[], lambdaMin: number, lambdaMax: number): { lambda: number; offset: number } | undefined {
  return landing(goniometerMatrix(model, angles), compileMembers(UB, [h]), 0, panels.map(preparePanel), lambdaMin, lambdaMax);
}
