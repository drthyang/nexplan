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
 *     Masked pixels, switched-off panels and the sample environment's shadows
 *     (acceptance.ts) are not recorded.
 *  3. Greedy maximum coverage: add the candidate that places the most wanted
 *     reflections well that were not yet, then records the most wanted ones not
 *     yet recorded, then the most new families; once every reachable family is
 *     recorded, the most second and then third recordings (redundancy). Settings
 *     already in the list count as measured, so suggestions extend it.
 *     Guarantee: the first goal is a coverage function, monotone and
 *     submodular, and each pick maximises it first, so k picks place at least
 *     1 − (1 − 1/k)^k ≥ 1 − 1/e of the most wanted reflections that any k grid
 *     settings (added to those listed) place well; with none wanted, the same
 *     holds for families recorded (Nemhauser, Wolsey & Fisher, Math. Program.
 *     14, 265 (1978)). The later goals only break ties and carry no guarantee.
 *
 * A wanted reflection is a set of equivalent hkl (its symmetry family in the
 * reflection list), or a single hkl when it is not in the list (absent, weak or
 * beyond the strongest kept); any member recorded counts.
 */
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { mulVec } from "@materia/core/math/mat3";
import { goniometerMatrix, type GoniometerModel } from "../ub/goniometer.ts";
import { blockedAt, type ShadowShape, type Shadows } from "./acceptance.ts";
import { recordsAt, type Blocked, type DetectorPanel } from "./detectors.ts";

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
  readonly src: DetectorPanel;
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
  return { src: p, n, cn: dot(p.center, n), c: p.center, base: p.base, up: p.up, hw: p.width / 2, hh: p.height / 2, dir, cosR: cosR - 1e-9 };
}

/**
 * The panel hit along unit u, as the larger of |x|/(w/2) and |y|/(h/2) of the hit
 * from the panel centre (0 at the centre, 1 at an edge); −1 when nothing records
 * it (no panel, a masked pixel or switched-off panel, or a shadow).
 */
function hitOffset(panels: readonly PreparedPanel[], ux: number, uy: number, uz: number, blocked: Blocked | undefined): number {
  if (blocked?.(ux, uy, uz)) return -1;
  // The ray stops at the nearest panel it crosses (as rayHit), recorded there or not; panels can overlap along a
  // ray (NOMAD, SEQUOIA, CNCS), so every candidate is checked.
  let bestT = Infinity;
  let result = -1;
  for (const p of panels) {
    if (ux * p.dir[0] + uy * p.dir[1] + uz * p.dir[2] < p.cosR) continue;
    const denom = ux * p.n[0] + uy * p.n[1] + uz * p.n[2];
    if (Math.abs(denom) < 1e-12) continue;
    const t = p.cn / denom;
    if (!(t > 0) || t >= bestT) continue;
    const dx = ux * t - p.c[0];
    const dy = uy * t - p.c[1];
    const dz = uz * t - p.c[2];
    const x = dx * p.base[0] + dy * p.base[1] + dz * p.base[2];
    const y = dx * p.up[0] + dy * p.up[1] + dz * p.up[2];
    const fx = Math.abs(x) / p.hw;
    const fy = Math.abs(y) / p.hh;
    if (fx > 1 || fy > 1) continue;
    bestT = t;
    result = recordsAt(p.src, x, y) ? Math.max(fx, fy) : -1;
  }
  return result;
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
function landing(R: Mat3, c: Compiled, i: number, panels: readonly PreparedPanel[], lambdaMin: number, lambdaMax: number, blocked?: Blocked): { lambda: number; offset: number } | undefined {
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
  const offset = hitOffset(panels, x / n, y / n, kz / n, blocked);
  return offset < 0 ? undefined : { lambda, offset };
}

/** Dense families recorded at goniometer setting R (the landing test, inlined without allocation). */
function familiesAt(R: Mat3, c: Compiled, panels: readonly PreparedPanel[], lambdaMin: number, lambdaMax: number, stamp: Int32Array, gen: number, blocked?: Blocked): Int32Array {
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
    if (hitOffset(panels, x / n, y / n, kz / n, blocked) >= 0) {
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

/**
 * How setting R records a wanted reflection, best over its members. level: 0 not recorded, 1 recorded,
 * 2 well placed. cost of that best recording: the larger of |λ − mid|/(half the band) and the hit's
 * offset from the panel centre, so 0 is mid band on a panel centre and 1 a band end or a panel edge
 * (Infinity when not recorded). The "fewest" goal prefers settings that centre the wanted reflections.
 */
function placementOf(R: Mat3, members: Compiled, panels: readonly PreparedPanel[], lambdaMin: number, lambdaMax: number, placement: Placement, blocked?: Blocked): { level: 0 | 1 | 2; cost: number } {
  const mid = (lambdaMin + lambdaMax) / 2;
  const half = (lambdaMax - lambdaMin) / 2 || 1;
  const halfWidth = placement.bandFraction * half;
  const maxOffset = 1 - 2 * placement.edgeFraction;
  let level: 0 | 1 | 2 = 0;
  let cost = Infinity;
  for (let i = 0; i < members.fam.length; i++) {
    const hit = landing(R, members, i, panels, lambdaMin, lambdaMax, blocked);
    if (!hit) continue;
    const c = Math.max(Math.abs(hit.lambda - mid) / half, hit.offset);
    if (Math.abs(hit.lambda - mid) <= halfWidth + 1e-12 && hit.offset <= maxOffset + 1e-12) {
      if (level < 2) cost = Infinity;
      level = 2;
      cost = Math.min(cost, c);
    } else if (level < 2) {
      level = 1;
      cost = Math.min(cost, c);
    }
  }
  return { level, cost };
}

const placementLevel = (R: Mat3, members: Compiled, panels: readonly PreparedPanel[], lambdaMin: number, lambdaMax: number, placement: Placement, blocked?: Blocked) =>
  placementOf(R, members, panels, lambdaMin, lambdaMax, placement, blocked).level;

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
 * What suggestions aim for. "coverage": the most from n settings (wanted reflections, then completeness,
 * then redundancy). "fewest": as few settings as place every wanted reflection well (at most n), preferring
 * the one that centres them best among equals; with none wanted, as few as record every reachable family.
 */
export type PlanGoal = "coverage" | "fewest";

/**
 * Greedy picks, up to n, from `sets` (family ids per candidate). For "coverage" each pick maximises, in
 * order, the wanted reflections it newly places well, the wanted reflections it newly records (`wanted[i][w]`:
 * level 0, 1 or 2 of wanted reflection w at candidate i), the new families, the families it records for the
 * second and third time (redundancy, used for scaling and absorption corrections), then the families it
 * records in all; it stops when a pick would add nothing on any of these. "fewest" is greedy set cover: until
 * every wanted reflection that some grid setting places well is placed well, it uses at most H(n) ≤ ln n + 1
 * times the fewest grid settings that do so (Johnson, J. Comput. Syst. Sci. 9, 256 (1974); Lovász, Discrete
 * Math. 13, 383 (1975); Chvátal, Math. Oper. Res. 4, 233 (1979)); settings added afterwards only to record the
 * rest are outside that bound. Each pick takes the same first two, then the lowest summed `costs` of those wanted reflections
 * (placementOf: nearest mid band and panel centre), then new families; it stops once no wanted reflection
 * gains (with none wanted, once no family is new). `covered` and `wantedBefore` describe settings measured.
 */
export function greedyCover(
  sets: readonly Int32Array[],
  n: number,
  opts: { readonly covered?: Iterable<number>; readonly wanted?: readonly Uint8Array[]; readonly wantedBefore?: Uint8Array; readonly costs?: readonly Float64Array[]; readonly goal?: PlanGoal } = {},
): GreedyPick[] {
  const dense = new Map<number, number>();
  const toDense = (id: number) => {
    if (!dense.has(id)) dense.set(id, dense.size);
    return dense.get(id)!;
  };
  const dsets = sets.map((set) => Int32Array.from(set, toDense));
  const covered = [...(opts.covered ?? [])].map(toDense);
  const nWanted = opts.wantedBefore?.length ?? opts.wanted?.[0]?.length ?? 0;
  const wanted = opts.wanted ?? sets.map(() => new Uint8Array(nWanted));
  return greedyDense(dsets, n, dense.size, covered, wanted, opts.wantedBefore ?? new Uint8Array(nWanted), opts.costs ?? wanted.map((l) => new Float64Array(l.length)), opts.goal ?? "coverage");
}

function greedyDense(sets: readonly Int32Array[], n: number, nIds: number, covered: readonly number[], wanted: readonly Uint8Array[], wantedBefore: Uint8Array, costs: readonly Float64Array[], goal: PlanGoal): GreedyPick[] {
  const count = new Int32Array(nIds);
  for (const id of covered) count[id]!++;
  const best = Uint8Array.from(wantedBefore);
  const used = new Uint8Array(sets.length);
  const picks: GreedyPick[] = [];
  const fewest = goal === "fewest";
  // Gains, compared in order: well placed, recorded, −cost ("fewest" only), new, second, third, all families.
  const g = new Float64Array(7);
  const b = new Float64Array(7);
  for (let step = 0; step < n; step++) {
    let pick = -1;
    for (let i = 0; i < sets.length; i++) {
      if (used[i]) continue;
      g.fill(0);
      const levels = wanted[i]!;
      for (let w = 0; w < levels.length; w++) {
        const raises = (levels[w] === 2 && best[w]! < 2) || (levels[w]! >= 1 && best[w] === 0);
        if (levels[w] === 2 && best[w]! < 2) g[0]!++;
        if (levels[w]! >= 1 && best[w] === 0) g[1]!++;
        if (fewest && raises) g[2]! -= costs[i]![w]!;
      }
      const set = sets[i]!;
      for (let k = 0; k < set.length; k++) {
        const c = count[set[k]!]!;
        if (c < 3) g[3 + c]!++;
      }
      g[6] = set.length;
      let better = pick < 0;
      for (let k = 0; !better && k < 7; k++) {
        if (g[k]! > b[k]!) better = true;
        else if (g[k]! < b[k]!) break;
      }
      if (better) {
        pick = i;
        b.set(g);
      }
    }
    if (pick < 0) break;
    const wantedGain = b[0] !== 0 || b[1] !== 0;
    if (fewest ? (wanted[pick]!.length ? !wantedGain : b[3] === 0) : !wantedGain && b[3] === 0 && b[4] === 0 && b[5] === 0) break;
    used[pick] = 1;
    for (const id of sets[pick]!) count[id]!++;
    const levels = wanted[pick]!;
    for (let w = 0; w < levels.length; w++) best[w] = Math.max(best[w]!, levels[w]!);
    picks.push({ index: pick, wellPlaced: b[0]!, wanted: b[1]!, families: b[3]!, second: b[4]!, third: b[5]! });
  }
  return picks;
}

/** For each family, the number of the settings that record it. */
export function familyCounts(
  model: GoniometerModel,
  settings: readonly (readonly number[])[],
  UB: Mat3,
  targets: readonly PlanTarget[],
  panels: readonly DetectorPanel[],
  lambdaMin: number,
  lambdaMax: number,
  shadows?: Shadows,
): Map<number, number> {
  const prepared = panels.map(preparePanel);
  const c = compile(UB, targets);
  const stamp = new Int32Array(c.ids.length).fill(-1);
  const counts = new Map<number, number>();
  settings.forEach((s, k) => {
    for (const f of familiesAt(goniometerMatrix(model, s), c, prepared, lambdaMin, lambdaMax, stamp, k, blockedAt(shadows, s))) counts.set(c.ids[f]!, (counts.get(c.ids[f]!) ?? 0) + 1);
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
  shadows?: Shadows,
): { recorded: number; well: number }[] {
  const prepared = panels.map(preparePanel);
  const W = wanted.map((m) => compileMembers(UB, m));
  const out = W.map(() => ({ recorded: 0, well: 0 }));
  for (const s of settings) {
    const R = goniometerMatrix(model, s);
    const blocked = blockedAt(shadows, s);
    W.forEach((m, w) => {
      const level = placementLevel(R, m, prepared, lambdaMin, lambdaMax, placement, blocked);
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
  /** The sample environment's shadows (turning with `model`'s axes where mounted on one). */
  readonly shadows?: readonly ShadowShape[];
  readonly lambdaMin: number;
  readonly lambdaMax: number;
  /** "coverage": n settings; "fewest": at most n (PlanGoal). */
  readonly n: number;
  readonly goal?: PlanGoal;
  readonly maxCandidates?: number;
}

export interface SuggestResult {
  readonly goal: PlanGoal;
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
  /** Wanted reflections that some candidate (or the existing list) places well: what any number of settings could reach. */
  readonly wellPossible: number;
  /** Families recorded by the existing list with the suggestions, and by any candidate or the existing list. */
  readonly familiesAfter: number;
  readonly familiesReachable: number;
  /** "fewest": the settings were fine-tuned off the grid to centre their wanted reflections. */
  readonly refined: boolean;
}

export function suggestSettings(input: SuggestInput, onProgress?: (done: number, total: number) => void): SuggestResult {
  const panels = input.panels.map(preparePanel);
  const placement = input.placement ?? DEFAULT_PLACEMENT;
  const goal = input.goal ?? "coverage";
  const c = compile(input.UB, input.reflections);
  const W = input.wanted.map((m) => compileMembers(input.UB, m));
  const stamp = new Int32Array(c.ids.length).fill(-1);
  let gen = 0;
  const shadows: Shadows | undefined = input.shadows?.length ? { shapes: input.shadows, model: input.model } : undefined;
  const evaluate = (angles: readonly number[]) => {
    const R = goniometerMatrix(input.model, angles);
    const blocked = blockedAt(shadows, angles);
    const placed = W.map((m) => placementOf(R, m, panels, input.lambdaMin, input.lambdaMax, placement, blocked));
    return { families: familiesAt(R, c, panels, input.lambdaMin, input.lambdaMax, stamp, gen++, blocked), levels: Uint8Array.from(placed, (p) => p.level), costs: Float64Array.from(placed, (p) => p.cost) };
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
  const costs: Float64Array[] = [];
  const every = Math.max(1, Math.floor(grid.settings.length / 50));
  grid.settings.forEach((s, i) => {
    const e = evaluate(s);
    sets.push(e.families);
    levels.push(e.levels);
    costs.push(e.costs);
    if (onProgress && (i + 1) % every === 0) onProgress(i + 1, grid.settings.length);
  });
  const picks = greedyDense(sets, input.n, c.ids.length, covered, levels, before, costs, goal);

  // "fewest": centre each pick's wanted reflections off the grid (quarter steps within ±1 step), keeping
  // every wanted reflection it newly places or records at least as well.
  const refined = goal === "fewest" && W.length > 0 && grid.step > 0;
  const best = Uint8Array.from(before);
  const settings = picks.map((p) => {
    const start = grid.settings[p.index]!;
    const owned = [...levels[p.index]!.keys()].filter((w) => levels[p.index]![w]! > best[w]!);
    const need = owned.map((w) => levels[p.index]![w]!);
    owned.forEach((w, k) => (best[w] = need[k]!));
    return refined ? refine(input.model, start, grid.step, (a) => {
      const e = evaluate(a);
      return owned.every((w, k) => e.levels[w]! >= need[k]!) ? owned.reduce((s, w) => s + e.costs[w]!, 0) : Infinity;
    }) : start;
  });

  const after = Uint8Array.from(before);
  const familiesAfter = new Set(covered);
  for (const s of settings) {
    const e = evaluate(s);
    e.levels.forEach((l, w) => (after[w] = Math.max(after[w]!, l)));
    for (const f of e.families) familiesAfter.add(f);
  }
  const possible = Uint8Array.from(before);
  const reachable = new Set(covered);
  levels.forEach((l, i) => {
    l.forEach((v, w) => (possible[w] = Math.max(possible[w]!, v)));
    for (const f of sets[i]!) reachable.add(f);
  });
  const tally = (a: Uint8Array, min: number) => a.reduce((n, l) => n + (l >= min ? 1 : 0), 0);
  return {
    goal,
    settings,
    picks,
    step: grid.step,
    candidates: grid.settings.length,
    wantedTotal: W.length,
    recordedBefore: tally(before, 1),
    recordedAfter: tally(after, 1),
    wellBefore: tally(before, 2),
    wellAfter: tally(after, 2),
    wellPossible: tally(possible, 2),
    familiesAfter: familiesAfter.size,
    familiesReachable: reachable.size,
    refined,
  };
}

/**
 * The setting near `start` (free axes moved in quarter steps within ±step, inside their limits) with the
 * lowest `score` (Infinity: not acceptable); `start` itself when nothing scores lower.
 */
function refine(model: GoniometerModel, start: readonly number[], step: number, score: (angles: readonly number[]) => number): number[] {
  const free = model.axes.flatMap((ax, i) => (ax.fixed === undefined ? [i] : []));
  const offsets = [-4, -3, -2, -1, 0, 1, 2, 3, 4].map((k) => (k * step) / 4);
  let best = [...start];
  let bestScore = score(start);
  const idx = free.map(() => 0);
  for (;;) {
    const a = [...start];
    let ok = true;
    free.forEach((i, k) => {
      const ax = model.axes[i]!;
      const v = start[i]! + offsets[idx[k]!]!;
      // A full-turn axis wraps (into min…min + 360); a narrower range is a hard limit.
      if (ax.max - ax.min >= 360) a[i] = ax.min + (((v - ax.min) % 360) + 360) % 360;
      else if (v < ax.min - 1e-9 || v > ax.max + 1e-9) ok = false;
      else a[i] = v;
    });
    if (ok) {
      const s = score(a);
      if (s < bestScore - 1e-12) {
        best = a;
        bestScore = s;
      }
    }
    let k = 0;
    while (k < free.length && ++idx[k]! >= offsets.length) idx[k++] = 0;
    if (k === free.length) break;
  }
  return best;
}

/** For each target, the number of settings that record it (same test as the search). */
export function targetCoverage(
  model: GoniometerModel,
  settings: readonly (readonly number[])[],
  UB: Mat3,
  targets: readonly PlanTarget[],
  panels: readonly DetectorPanel[],
  lambdaMin: number,
  lambdaMax: number,
  shadows?: Shadows,
): Uint16Array {
  const prepared = panels.map(preparePanel);
  const c = compile(UB, targets);
  const counts = new Uint16Array(targets.length);
  for (const s of settings) {
    const R = goniometerMatrix(model, s);
    const blocked = blockedAt(shadows, s);
    targets.forEach((_, i) => {
      if (landing(R, c, i, prepared, lambdaMin, lambdaMax, blocked)) counts[i]!++;
    });
  }
  return counts;
}

/** For tests: the hit offset and λ of one hkl at one setting, through the same path as the search. */
export function landingOf(
  model: GoniometerModel,
  angles: readonly number[],
  UB: Mat3,
  h: Vec3,
  panels: readonly DetectorPanel[],
  lambdaMin: number,
  lambdaMax: number,
  shadows?: Shadows,
): { lambda: number; offset: number } | undefined {
  return landing(goniometerMatrix(model, angles), compileMembers(UB, [h]), 0, panels.map(preparePanel), lambdaMin, lambdaMax, blockedAt(shadows, angles));
}
