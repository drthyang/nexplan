/**
 * Choosing an orientation list (TOPAZ: about ten settings, wanted peaks first).
 *
 *  1. Candidates: a grid over the free goniometer axes within their ranges
 *     (at most one turn each), with the step the smallest of 1°, 2°, 3°, … that
 *     keeps the grid under a size limit. Fixed axes stay at their values.
 *  2. For each candidate, the symmetry families it records: λ = −2q_z/|q|² in
 *     the band and k_f on a panel (the same test as observeAt, with each panel's
 *     angular extent checked first).
 *  3. Greedy maximum coverage: add the candidate that records the most new
 *     wanted targets, then the most new families; once every reachable family
 *     is recorded, the most second and then third recordings (redundancy).
 *     Greedy is within (1 − 1/e) of the best coverage for the same number of
 *     settings (Nemhauser, Wolsey & Fisher, Math. Program. 14, 265 (1978)).
 *     Settings already in the list count as measured, so suggestions extend it.
 *
 * Wanted targets are families of the reflection list, or for an hkl that is not
 * in it (absent, weak, beyond the strongest kept) that exact hkl, with a
 * negative id so it never counts toward completeness.
 */
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { mulMat, mulVec } from "@materia/core/math/mat3";
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
    settings.push(model.axes.map((ax, i) => {
      const k = free.indexOf(i);
      return k < 0 ? fixedAt(i) : ax.min + idx[k]! * step;
    }));
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
    const corner: Vec3 = [0, 1, 2].map((k) => p.center[k]! + (sx * p.width * p.base[k]!) / 2 + (sy * p.height * p.up[k]!) / 2) as unknown as Vec3;
    cosR = Math.min(cosR, dot(dir, unit(corner)));
  }
  return { n, cn: dot(p.center, n), c: p.center, base: p.base, up: p.up, hw: p.width / 2, hh: p.height / 2, dir, cosR: cosR - 1e-9 };
}

function hitsAny(panels: readonly PreparedPanel[], ux: number, uy: number, uz: number): boolean {
  for (const p of panels) {
    if (ux * p.dir[0] + uy * p.dir[1] + uz * p.dir[2] < p.cosR) continue;
    const denom = ux * p.n[0] + uy * p.n[1] + uz * p.n[2];
    if (Math.abs(denom) < 1e-12) continue;
    const t = p.cn / denom;
    if (!(t > 0)) continue;
    const dx = ux * t - p.c[0];
    const dy = uy * t - p.c[1];
    const dz = uz * t - p.c[2];
    if (Math.abs(dx * p.base[0] + dy * p.base[1] + dz * p.base[2]) <= p.hw && Math.abs(dx * p.up[0] + dy * p.up[1] + dz * p.up[2]) <= p.hh) return true;
  }
  return false;
}

export interface PlanTarget {
  readonly h: Vec3;
  /** Symmetry family (≥ 0), or a negative id for a wanted hkl outside the reflection list. */
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
 * Dense families recorded at goniometer setting R: q_lab = R·(UB·h), λ = −2q_z/|q|²
 * in the band (|q| is unchanged by R), k_f = q + ẑ/λ on a panel.
 */
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
    if (hitsAny(panels, x / n, y / n, kz / n)) {
      stamp[f] = gen;
      out.push(f);
    }
  }
  return Int32Array.from(out);
}

export interface GreedyPick {
  readonly index: number;
  /** New wanted targets, new families, and families recorded for the second and third time by this pick. */
  readonly wanted: number;
  readonly families: number;
  readonly second: number;
  readonly third: number;
}

/**
 * Greedy coverage: up to n picks from `sets`. Each pick maximises, in order,
 * the new wanted targets, the new families, then the families it records for
 * the second and the third time (redundancy, used for scaling and absorption
 * corrections), then the families it records in all. Stops when a pick would
 * add nothing on any of these. Ids are arbitrary integers; negative ones are
 * wanted targets that do not count as families.
 */
export function greedyCover(sets: readonly Int32Array[], n: number, opts: { readonly covered?: Iterable<number>; readonly wanted?: ReadonlySet<number> } = {}): GreedyPick[] {
  const dense = new Map<number, number>();
  const toDense = (id: number) => {
    if (!dense.has(id)) dense.set(id, dense.size);
    return dense.get(id)!;
  };
  const dsets = sets.map((set) => Int32Array.from(set, toDense));
  const covered = [...(opts.covered ?? [])].map(toDense);
  const ids = [...dense.keys()];
  return greedyDense(dsets, n, ids.length, covered, Uint8Array.from(ids, (id) => (opts.wanted?.has(id) ? 1 : 0)), Uint8Array.from(ids, (id) => (id >= 0 ? 1 : 0)));
}

function greedyDense(sets: readonly Int32Array[], n: number, nIds: number, covered: readonly number[], wanted: Uint8Array, isFamily: Uint8Array): GreedyPick[] {
  const count = new Int32Array(nIds);
  for (const id of covered) count[id]!++;
  const used = new Uint8Array(sets.length);
  const picks: GreedyPick[] = [];
  for (let step = 0; step < n; step++) {
    let best = -1;
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    for (let i = 0; i < sets.length; i++) {
      if (used[i]) continue;
      const set = sets[i]!;
      let g0 = 0;
      let g1 = 0;
      let g2 = 0;
      let g3 = 0;
      for (let k = 0; k < set.length; k++) {
        const id = set[k]!;
        const c = count[id]!;
        if (c === 0 && wanted[id]) g0++;
        if (isFamily[id]) {
          if (c === 0) g1++;
          else if (c === 1) g2++;
          else if (c === 2) g3++;
        }
      }
      const g4 = set.length;
      if (best < 0 || g0 > b0 || (g0 === b0 && (g1 > b1 || (g1 === b1 && (g2 > b2 || (g2 === b2 && (g3 > b3 || (g3 === b3 && g4 > b4)))))))) {
        best = i;
        b0 = g0;
        b1 = g1;
        b2 = g2;
        b3 = g3;
        b4 = g4;
      }
    }
    if (best < 0 || (b0 === 0 && b1 === 0 && b2 === 0 && b3 === 0)) break;
    used[best] = 1;
    for (const id of sets[best]!) count[id]!++;
    picks.push({ index: best, wanted: b0, families: b1, second: b2, third: b3 });
  }
  return picks;
}

/** For each family (or wanted id), the number of the settings that record it. */
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

export interface SuggestInput {
  readonly model: GoniometerModel;
  /** Current angles: fixed axes are taken from the model, so only their count matters. */
  readonly base: readonly number[];
  readonly UB: Mat3;
  readonly reflections: readonly PlanTarget[];
  /** Wanted targets: family ids of `reflections`, or extra exact hkl (with negative ids). */
  readonly wantedFamilies: readonly number[];
  readonly extra: readonly PlanTarget[];
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
  /** Wanted targets recorded by the existing list, and by the list with the suggestions. */
  readonly wantedBefore: number;
  readonly wantedAfter: number;
  readonly wantedTotal: number;
}

export function suggestSettings(input: SuggestInput, onProgress?: (done: number, total: number) => void): SuggestResult {
  const panels = input.panels.map(preparePanel);
  const c = compile(input.UB, [...input.reflections, ...input.extra]);
  const stamp = new Int32Array(c.ids.length).fill(-1);
  let gen = 0;
  const at = (angles: readonly number[]) => familiesAt(goniometerMatrix(input.model, angles), c, panels, input.lambdaMin, input.lambdaMax, stamp, gen++);
  const covered: number[] = [];
  for (const s of input.existing) covered.push(...at(s));
  const wantedIds = new Set(input.wantedFamilies);
  const wanted = Uint8Array.from(c.ids, (id) => (wantedIds.has(id) ? 1 : 0));
  const seen = new Uint8Array(c.ids.length);
  for (const f of covered) seen[f] = 1;
  const wantedSeen = () => c.ids.filter((_, f) => wanted[f] && seen[f]).length;
  const wantedBefore = wantedSeen();
  const grid = candidateGrid(input.model, input.base, input.maxCandidates);
  const sets: Int32Array[] = [];
  const every = Math.max(1, Math.floor(grid.settings.length / 50));
  grid.settings.forEach((s, i) => {
    sets.push(at(s));
    if (onProgress && (i + 1) % every === 0) onProgress(i + 1, grid.settings.length);
  });
  const picks = greedyDense(sets, input.n, c.ids.length, covered, wanted, Uint8Array.from(c.ids, (id) => (id >= 0 ? 1 : 0)));
  for (const p of picks) for (const f of sets[p.index]!) seen[f] = 1;
  return {
    settings: picks.map((p) => grid.settings[p.index]!),
    picks,
    step: grid.step,
    candidates: grid.settings.length,
    wantedBefore,
    wantedAfter: wantedSeen(),
    // Wanted ids that are not targets at all (none expected) still count as wanted and unrecorded.
    wantedTotal: wantedIds.size,
  };
}

/** For each target, the number of settings that record it (same test as the search). */
export function targetCoverage(model: GoniometerModel, settings: readonly (readonly number[])[], UB: Mat3, targets: readonly PlanTarget[], panels: readonly DetectorPanel[], lambdaMin: number, lambdaMax: number): Uint16Array {
  const prepared = panels.map(preparePanel);
  const counts = new Uint16Array(targets.length);
  for (const s of settings) {
    const RUB = mulMat(goniometerMatrix(model, s), UB);
    targets.forEach((t, i) => {
      const q = mulVec(RUB, t.h);
      const q2 = q[0] * q[0] + q[1] * q[1] + q[2] * q[2];
      if (!(q[2] < 0) || q2 === 0) return;
      const lambda = (-2 * q[2]) / q2;
      if (!(lambda >= lambdaMin && lambda <= lambdaMax)) return;
      const u = unit([q[0], q[1], 1 / lambda + q[2]]);
      if (hitsAny(prepared, u[0], u[1], u[2])) counts[i]!++;
    });
  }
  return counts;
}
