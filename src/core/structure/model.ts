/**
 * Structure model: a CIF structure with resolved symmetry and species, and its
 * expansion to the full unit cell.
 */
import type { UnitCell } from "@materia/core/crystal/types";
import { cellVolume, metricTensor } from "@materia/core/crystal/unitCell";
import type { Mat3 } from "@materia/core/math/types";
import type { CifStructure, Diagnostic } from "../../io/cif/structure.ts";
import { parseTypeSymbol, speciesFromLabel, speciesKey, type Species } from "../scattering/species.ts";
import { applyOp, type SymOp } from "../symmetry/ops.ts";
import { resolveSymmetry, SymmetryResolutionError, type ResolvedSymmetry } from "../symmetry/spaceGroups.ts";

export interface Site {
  readonly label: string;
  readonly species: Species;
  readonly typeSymbol?: string;
  readonly fract: readonly [number, number, number];
  readonly occupancy: number;
  readonly bIso: number;
  readonly cifMultiplicity?: number;
}

export interface StructureModel {
  readonly name: string;
  readonly cell: UnitCell;
  readonly volume: number;
  readonly symmetry: ResolvedSymmetry;
  readonly sites: readonly Site[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface BuildOptions {
  /** User's setting choice when the file is ambiguous (an xhm string). */
  readonly chosenSetting?: string;
  /** label → species text (e.g. "Ca", "Fe3+", "2H") overriding the file. */
  readonly speciesOverrides?: Readonly<Record<string, string>>;
}

export class ModelBuildError extends Error {
  readonly diagnostics: readonly Diagnostic[];
  readonly ambiguousLabels: readonly { label: string; candidates: readonly string[] }[];
  readonly settingCandidates: readonly string[];
  constructor(message: string, d: { diagnostics?: Diagnostic[]; ambiguousLabels?: { label: string; candidates: readonly string[] }[]; settingCandidates?: string[] } = {}) {
    super(message);
    this.diagnostics = d.diagnostics ?? [];
    this.ambiguousLabels = d.ambiguousLabels ?? [];
    this.settingCandidates = d.settingCandidates ?? [];
  }
}

function checkMetric(cell: UnitCell): string | undefined {
  const G = metricTensor(cell);
  const m1 = G[0][0];
  const m2 = G[0][0] * G[1][1] - G[0][1] * G[1][0];
  const det =
    G[0][0] * (G[1][1] * G[2][2] - G[1][2] * G[2][1]) - G[0][1] * (G[1][0] * G[2][2] - G[1][2] * G[2][0]) + G[0][2] * (G[1][0] * G[2][1] - G[1][1] * G[2][0]);
  if (!(m1 > 0 && m2 > 0 && det > 0)) return "The cell angles do not form a valid lattice (metric tensor not positive definite).";
  return undefined;
}

export function buildModel(cif: CifStructure, opts: BuildOptions = {}): StructureModel {
  const diagnostics: Diagnostic[] = [...cif.diagnostics];
  const cell: UnitCell = {
    a: cif.cell.a.value,
    b: cif.cell.b.value,
    c: cif.cell.c.value,
    alpha: cif.cell.alpha.value,
    beta: cif.cell.beta.value,
    gamma: cif.cell.gamma.value,
  };
  const metricProblem = checkMetric(cell);
  if (metricProblem) throw new ModelBuildError(metricProblem, { diagnostics });

  let symmetry: ResolvedSymmetry;
  try {
    symmetry = resolveSymmetry({ ...cif.symmetry, cell, ...(opts.chosenSetting ? { chosenSetting: opts.chosenSetting } : {}) });
  } catch (e) {
    if (e instanceof SymmetryResolutionError) {
      throw new ModelBuildError(e.message, { diagnostics, settingCandidates: e.candidates.map((c) => c.xhm) });
    }
    throw new ModelBuildError((e as Error).message, { diagnostics });
  }
  for (const w of symmetry.warnings) diagnostics.push({ severity: "warning", message: w });
  for (const a of symmetry.assumptions) diagnostics.push({ severity: "assumption", message: a });

  const ambiguous: { label: string; candidates: readonly string[] }[] = [];
  const sites: Site[] = [];
  for (const s of cif.sites) {
    const override = opts.speciesOverrides?.[s.label];
    const parsed = override !== undefined ? parseTypeSymbol(override) : s.typeSymbol ? parseTypeSymbol(s.typeSymbol) : speciesFromLabel(s.label);
    if (!parsed.ok) {
      ambiguous.push({ label: s.label, candidates: parsed.candidates });
      continue;
    }
    if (override !== undefined) diagnostics.push({ severity: "assumption", message: `Site ${s.label}: species set to ${speciesKey(parsed.species)} by the user.` });
    else if (parsed.note && !s.typeSymbol) diagnostics.push({ severity: "assumption", message: `Site ${s.label}: ${parsed.note} (no _atom_site_type_symbol).` });
    else if (parsed.note) diagnostics.push({ severity: "info", message: `Site ${s.label}: ${parsed.note}` });
    sites.push({
      label: s.label,
      species: parsed.species,
      ...(s.typeSymbol ? { typeSymbol: s.typeSymbol } : {}),
      fract: [s.fract[0].value, s.fract[1].value, s.fract[2].value],
      occupancy: s.occupancy.value,
      bIso: s.bIso.value,
      ...(s.multiplicity !== undefined ? { cifMultiplicity: s.multiplicity } : {}),
    });
  }
  if (ambiguous.length) {
    throw new ModelBuildError(`Element could not be determined for ${ambiguous.map((a) => a.label).join(", ")}; choose the species.`, { diagnostics, ambiguousLabels: ambiguous });
  }
  return { name: cif.phaseName ?? cif.formula ?? cif.blockName, cell, volume: cellVolume(cell), symmetry, sites, diagnostics };
}

// ------------------------------------------------------------------ expansion

export interface ExpandedAtom {
  readonly siteIndex: number;
  readonly fract: readonly [number, number, number];
}

export interface Expansion {
  readonly atoms: readonly ExpandedAtom[];
  /** Orbit size per site, in the same order as model.sites. */
  readonly multiplicities: readonly number[];
  readonly diagnostics: readonly Diagnostic[];
}

const wrap = (x: number) => {
  const w = x - Math.floor(x);
  return w >= 1 - 1e-12 ? 0 : w;
};

/** Minimum-image distance (Å) between fractional positions under metric G. */
export function periodicDistance(G: Mat3, p: readonly number[], q: readonly number[]): number {
  const d = [0, 1, 2].map((i) => {
    const x = p[i]! - q[i]!;
    return x - Math.round(x);
  });
  let s = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s += d[i]! * G[i]![j]! * d[j]!;
  return Math.sqrt(Math.max(0, s));
}

/**
 * Expand every site by all operations. Images closer than `mergeTolerance` Å
 * are the same position. Images between that and `warnTolerance` Å apart are
 * kept but reported: they usually mean coordinates rounded off a special
 * position, which would otherwise double the atom silently.
 */
export function expandModel(model: StructureModel, opts: { mergeTolerance?: number; warnTolerance?: number } = {}): Expansion {
  const tol = opts.mergeTolerance ?? 0.02;
  const warnTol = opts.warnTolerance ?? 0.5;
  const G = metricTensor(model.cell);
  const ops: readonly SymOp[] = model.symmetry.ops;
  const atoms: ExpandedAtom[] = [];
  const multiplicities: number[] = [];
  const diagnostics: Diagnostic[] = [];
  model.sites.forEach((site, siteIndex) => {
    // Coincident images: every pair closer than tol is linked, and each connected component becomes its centroid.
    // The operations are isometries that permute the images, so they permute the components too, and the centroid
    // set is invariant under the group whatever the order of the operations: a site on a rounded special position
    // (0.3333 for 1/3) still expands to an exactly symmetric arrangement.
    const images = ops.map((op) => applyOp(op, site.fract).map(wrap) as [number, number, number]);
    const n = images.length;
    const parent = images.map((_, k) => k);
    const root = (k: number): number => (parent[k] === k ? k : (parent[k] = root(parent[k]!)));
    const dist: number[] = [];
    for (let a = 0; a < n; a++)
      for (let b = a + 1; b < n; b++) {
        const d = periodicDistance(G, images[a]!, images[b]!);
        dist.push(d);
        if (d < tol) parent[root(b)] = root(a);
      }
    // The closest pair of images left in different components.
    let closest = Infinity;
    for (let a = 0, k = 0; a < n; a++) for (let b = a + 1; b < n; b++, k++) if (root(a) !== root(b)) closest = Math.min(closest, dist[k]!);
    const components = new Map<number, { first: [number, number, number]; sum: [number, number, number]; n: number }>();
    images.forEach((x, k) => {
      const r = root(k);
      const cl = components.get(r);
      if (!cl) components.set(r, { first: x, sum: [...x], n: 1 });
      else {
        // Unwrapped next to the component's first image (members are within a few tol of it).
        for (let i = 0; i < 3; i++) cl.sum[i]! += x[i]! - Math.round(x[i]! - cl.first[i]!);
        cl.n++;
      }
    });
    const orbit = [...components.values()].map((cl) => cl.sum.map((v) => wrap(v / cl.n)) as [number, number, number]);
    if (closest < warnTol) {
      // Partially occupied images close together are usually deliberate split-site disorder.
      const split = site.occupancy <= 0.5 + 1e-6;
      diagnostics.push({
        severity: split ? "info" : "warning",
        message: split
          ? `Site ${site.label}: symmetry images ${closest.toFixed(3)} Å apart (occupancy ${site.occupancy}); treated as split-site disorder.`
          : `Site ${site.label}: two symmetry images are ${closest.toFixed(3)} Å apart and were kept as separate atoms. If the site is meant to be on a special position, its coordinates are rounded too coarsely.`,
      });
    }
    if (site.cifMultiplicity !== undefined && site.cifMultiplicity !== orbit.length) {
      diagnostics.push({
        severity: "warning",
        message: `Site ${site.label}: the file gives multiplicity ${site.cifMultiplicity}, the expansion gives ${orbit.length}.`,
      });
    }
    multiplicities.push(orbit.length);
    for (const x of orbit) atoms.push({ siteIndex, fract: x });
  });

  // Occupancy sum at shared positions (disorder must not exceed full occupancy).
  const seen = new Set<number>();
  model.sites.forEach((site, i) => {
    if (seen.has(i)) return;
    const group = [i];
    model.sites.forEach((_other, j) => {
      if (j <= i || seen.has(j)) return;
      const shares = atoms.some((a) => a.siteIndex === j && periodicDistance(G, a.fract, site.fract.map(wrap)) < tol);
      if (shares) group.push(j);
    });
    if (group.length > 1) {
      group.forEach((g) => seen.add(g));
      const sum = group.reduce((t, g) => t + model.sites[g]!.occupancy, 0);
      const labels = group.map((g) => model.sites[g]!.label).join(", ");
      diagnostics.push({
        severity: sum > 1 + 1e-3 ? "warning" : "info",
        message: `Sites ${labels} share a position (total occupancy ${sum.toFixed(4)})${sum > 1 + 1e-3 ? " — exceeds 1" : ""}.`,
      });
    }
  });
  return { atoms, multiplicities, diagnostics };
}

/** Chemical content of the cell: Σ occupancy per species key. */
export function cellContent(model: StructureModel, expansion: Expansion): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of expansion.atoms) {
    const s = model.sites[a.siteIndex]!;
    const k = speciesKey(s.species);
    m.set(k, (m.get(k) ?? 0) + s.occupancy);
  }
  return m;
}
