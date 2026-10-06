/**
 * Space-group settings (all 564 gemmi settings) and resolution of a structure's
 * symmetry from what a CIF provides. Resolution never guesses: an H-M symbol
 * shared by several settings (origin choice 1/2, unspecified monoclinic axis)
 * is an error unless explicit operations or the cell decide it.
 */
import table from "../../data/space-groups.json";
import { closeGroup, compose, makeOp, opKey, parseSymOp, sameOpSet, TDEN, type IntVec3, type SymOp } from "./ops.ts";

export interface SpaceGroupSetting {
  readonly number: number;
  readonly hm: string;
  readonly short: string;
  readonly ext: string;
  readonly xhm: string;
  readonly hall: string;
  readonly qualifier: string;
  readonly isReference: boolean;
  readonly ops: readonly string[];
}

export const SETTINGS: readonly SpaceGroupSetting[] = (table as { settings: SpaceGroupSetting[] }).settings;

const opsCache = new Map<SpaceGroupSetting, SymOp[]>();
export function settingOps(s: SpaceGroupSetting): SymOp[] {
  let ops = opsCache.get(s);
  if (!ops) {
    ops = s.ops.map(parseSymOp);
    opsCache.set(s, ops);
  }
  return ops;
}

/** Normalize an H-M symbol for matching: drop spaces/underscores/quotes, lower-case. */
export function normalizeHM(s: string): string {
  return s.replace(/['"_\s]/g, "").toLowerCase();
}

/** Split a trailing setting qualifier: ":1", ":2", ":H", ":R", " S", " Z", "origin choice 2". */
export function splitHMSuffix(symbol: string): { base: string; ext?: string } {
  let s = symbol.trim().replace(/^['"]|['"]$/g, "");
  const oc = /\s*[(,]?\s*origin\s*(?:choice)?\s*([12])\s*\)?\s*$/i.exec(s);
  if (oc) return { base: s.slice(0, oc.index), ext: oc[1]! };
  const colon = /:\s*([12HR])\s*$/i.exec(s);
  if (colon) return { base: s.slice(0, colon.index), ext: colon[1]!.toUpperCase() };
  // Legacy suffixes: S = origin choice 1 (site symmetry at origin), Z = origin choice 2 (centre at origin).
  const sz = /\s+([SZ])\s*$/.exec(s);
  if (sz) return { base: s.slice(0, sz.index), ext: sz[1] === "S" ? "1" : "2" };
  s = s.trim();
  return { base: s };
}

const byHall = new Map(SETTINGS.map((s) => [s.hall.replace(/\s+/g, " ").toLowerCase(), s]));

export function findByHall(hall: string): SpaceGroupSetting | undefined {
  return byHall.get(hall.trim().replace(/^['"]|['"]$/g, "").replace(/\s+/g, " ").toLowerCase());
}

/** All settings whose full or short H-M symbol matches (suffix applied when present). */
export function findByHM(symbol: string): SpaceGroupSetting[] {
  const { base, ext } = splitHMSuffix(symbol);
  const key = normalizeHM(base);
  const hits = SETTINGS.filter((s) => normalizeHM(s.hm) === key || normalizeHM(s.short) === key);
  return ext === undefined ? hits : hits.filter((s) => s.ext.toUpperCase() === ext);
}

/** Settings that contain exactly this operation set (after closure). */
export function findByOps(ops: readonly SymOp[]): SpaceGroupSetting[] {
  const keys = new Set(ops.map(opKey));
  return SETTINGS.filter((s) => s.ops.length === ops.length && settingOps(s).every((op) => keys.has(opKey(op))));
}

export interface CellLike {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly alpha: number;
  readonly beta: number;
  readonly gamma: number;
}

/** Rhombohedral axes (a=b=c, α=β=γ≠90) vs hexagonal axes (a=b, γ=120). */
function rhombohedralAxes(cell: CellLike): "H" | "R" | undefined {
  const near = (x: number, y: number, tol: number) => Math.abs(x - y) <= tol;
  if (near(cell.a, cell.b, 1e-3 * cell.a) && near(cell.gamma, 120, 0.01) && near(cell.alpha, 90, 0.01)) return "H";
  if (near(cell.a, cell.b, 1e-3 * cell.a) && near(cell.b, cell.c, 1e-3 * cell.a) && near(cell.alpha, cell.beta, 0.01) && near(cell.beta, cell.gamma, 0.01)) return "R";
  return undefined;
}

export interface SymmetryInput {
  /** Raw operation triplets as given in the file. */
  readonly ops?: readonly string[];
  readonly hall?: string;
  readonly hm?: string;
  readonly number?: number;
  readonly cell?: CellLike;
  /** User's explicit choice among ambiguous settings (an xhm string). */
  readonly chosenSetting?: string;
}

export interface ResolvedSymmetry {
  readonly ops: readonly SymOp[];
  readonly setting?: SpaceGroupSetting;
  readonly source: "ops" | "ops+centring" | "hall" | "hm" | "number" | "user";
  readonly warnings: readonly string[];
  readonly assumptions: readonly string[];
}

export class SymmetryResolutionError extends Error {
  /** Settings the user may choose from, when the problem is ambiguity. */
  readonly candidates: readonly SpaceGroupSetting[];
  constructor(message: string, candidates: readonly SpaceGroupSetting[] = []) {
    super(message);
    this.candidates = candidates;
  }
}

const CENTRING: Record<string, IntVec3[]> = {
  P: [],
  A: [[0, 12, 12]],
  B: [[12, 0, 12]],
  C: [[12, 12, 0]],
  I: [[12, 12, 12]],
  F: [
    [0, 12, 12],
    [12, 0, 12],
    [12, 12, 0],
  ],
  R: [
    [16, 8, 8],
    [8, 16, 16],
  ], // obverse, hexagonal axes
};

function describe(s: SpaceGroupSetting): string {
  return `${s.xhm} (No. ${s.number}, Hall '${s.hall}')`;
}

/**
 * Resolve symmetry. Precedence: explicit operations (checked for closure and,
 * when a symbol is also given, consistency) > Hall > H-M (+ suffix, + cell for
 * R groups) > number (only when the number has a single setting).
 */
export function resolveSymmetry(input: SymmetryInput): ResolvedSymmetry {
  const warnings: string[] = [];
  const assumptions: string[] = [];

  if (input.chosenSetting) {
    const s = SETTINGS.find((x) => x.xhm === input.chosenSetting);
    if (!s) throw new SymmetryResolutionError(`Unknown setting '${input.chosenSetting}'`);
    return { ops: settingOps(s), setting: s, source: "user", warnings, assumptions: [`Setting ${describe(s)} chosen by the user.`] };
  }

  // Candidate settings implied by the symbol fields, used for consistency checks.
  const fromHall = input.hall ? findByHall(input.hall) : undefined;
  if (input.hall && !fromHall) warnings.push(`Hall symbol '${input.hall}' not recognized; ignored.`);
  const fromHM = input.hm ? findByHM(input.hm) : [];
  if (input.hm && fromHM.length === 0) warnings.push(`H-M symbol '${input.hm}' not recognized.`);

  if (input.ops && input.ops.length > 0) {
    const given = input.ops.map(parseSymOp);
    const unique = new Map(given.map((o) => [opKey(o), o]));
    if (unique.size !== given.length) warnings.push(`${given.length - unique.size} duplicate operation(s) in the file were ignored.`);
    const listed = [...unique.values()];
    let ops = closeGroup(listed);
    let source: ResolvedSymmetry["source"] = "ops";
    // Older CIFs often list coset representatives without the lattice-centring translations. Only a list with
    // no centring of its own is completed: one that has some (e.g. reverse-setting R operations under an
    // obverse-assuming letter) would gain a second centring and the wrong group.
    const letter = (input.hm ?? fromHall?.hm ?? "").trim().charAt(0).toUpperCase();
    const rhombAxes = letter === "R" && input.cell ? rhombohedralAxes(input.cell) === "R" : false;
    const isIdentity = (o: SymOp) => o.R.every((r, i) => r.every((v, j) => v === (i === j ? 1 : 0)));
    const ownCentring = ops.some((o) => isIdentity(o) && o.t.some((v) => v !== 0));
    const centring = rhombAxes || ownCentring ? [] : (CENTRING[letter] ?? []);
    const centringOps = centring.map((t) => makeOp([[1, 0, 0], [0, 1, 0], [0, 0, 1]], t));
    const opsKeys = new Set(ops.map(opKey));
    if (centringOps.some((c) => !opsKeys.has(opKey(c)))) ops = closeGroup([...listed, ...centringOps]);
    if (ops.length !== listed.length) {
      // Accept only if the extra operations are exactly the listed ones times the centring translations.
      const expected = new Set<string>();
      for (const u of listed) {
        expected.add(opKey(u));
        for (const c of centringOps) expected.add(opKey(compose(c, u)));
      }
      if (centringOps.length > 0 && expected.size === ops.length && ops.every((o) => expected.has(opKey(o)))) {
        assumptions.push(`The file lists ${listed.length} operations without the ${letter}-centring translations; the ${ops.length}-operation group was completed from the symbol.`);
        source = "ops+centring";
      } else {
        throw new SymmetryResolutionError(
          `The ${listed.length} listed operations are not closed under composition (closure has ${ops.length}); the operation list is incomplete or inconsistent.`,
        );
      }
    }
    const matches = findByOps(ops);
    const setting = matches[0];
    if (!setting) warnings.push(`The operations (${ops.length}) do not match any tabulated setting; they are used as given.`);
    const declared = fromHall ? [fromHall] : fromHM;
    if (setting && declared.length > 0 && !declared.some((d) => sameOpSet(settingOps(d), ops))) {
      throw new SymmetryResolutionError(
        `The operations describe ${describe(setting)}, but the file's symbol says ${declared.map(describe).join(" or ")}. Resolve the conflict in the file.`,
        [setting, ...declared],
      );
    }
    if (setting && input.number !== undefined && input.number !== setting.number) {
      throw new SymmetryResolutionError(`The operations describe space group No. ${setting.number}, but the file gives No. ${input.number}.`, [setting]);
    }
    return { ops, ...(setting ? { setting } : {}), source, warnings, assumptions };
  }

  if (fromHall) {
    if (fromHM.length > 0 && !fromHM.includes(fromHall)) {
      throw new SymmetryResolutionError(`The Hall symbol '${input.hall}' (${fromHall.xhm}) contradicts the H-M symbol '${input.hm}' (${fromHM.map((s) => s.xhm).join(" or ")}).`, [fromHall, ...fromHM]);
    }
    if (input.number !== undefined && input.number !== fromHall.number) {
      throw new SymmetryResolutionError(`The Hall symbol '${input.hall}' is space group No. ${fromHall.number}, but the file gives No. ${input.number}.`, [fromHall]);
    }
    return { ops: settingOps(fromHall), setting: fromHall, source: "hall", warnings, assumptions };
  }

  if (fromHM.length > 0) {
    let candidates = fromHM;
    if (input.number !== undefined) {
      candidates = candidates.filter((s) => s.number === input.number);
      if (candidates.length === 0) throw new SymmetryResolutionError(`H-M symbol '${input.hm}' does not belong to space group No. ${input.number}.`, fromHM);
    }
    if (candidates.length > 1 && candidates.every((s) => s.ext === "H" || s.ext === "R") && input.cell) {
      const axes = rhombohedralAxes(input.cell);
      if (axes) {
        candidates = candidates.filter((s) => s.ext === axes);
        assumptions.push(`${axes === "H" ? "Hexagonal" : "Rhombohedral"} axes chosen from the cell metric.`);
      }
    }
    if (candidates.length === 1) return { ops: settingOps(candidates[0]!), setting: candidates[0]!, source: "hm", warnings, assumptions };
    throw new SymmetryResolutionError(
      `H-M symbol '${input.hm}' matches ${candidates.length} settings: ${candidates.map((s) => s.xhm).join(", ")}. The file has no operations to decide; choose the setting.`,
      candidates,
    );
  }

  if (input.number !== undefined) {
    const candidates = SETTINGS.filter((s) => s.number === input.number);
    if (candidates.length === 1) {
      warnings.push(`Symmetry taken from the space-group number alone (${candidates[0]!.xhm}).`);
      return { ops: settingOps(candidates[0]!), setting: candidates[0]!, source: "number", warnings, assumptions };
    }
    throw new SymmetryResolutionError(
      `Space group No. ${input.number} has ${candidates.length} settings and the file gives no operations or symbol; choose the setting.`,
      candidates,
    );
  }

  throw new SymmetryResolutionError("The file gives no symmetry operations, Hall symbol, H-M symbol or space-group number.");
}

export { TDEN };
