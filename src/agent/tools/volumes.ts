/**
 * Reciprocal-space volumes, for the programs that reduce, view and clean them (the NeXus Viewer, NEBULA3D, Mantid
 * MDNorm output): the Laue symmetry to average with, the Bragg nodes on a volume's grid (allowed, forbidden,
 * satellites), and the part of the grid a measurement plan records.
 *
 * A volume's grid: projection axes D0, D1, D2 (rows, r.l.u. of the CIF cell) and per axis the bins, as Mantid's
 * MDNorm writes them ("min,step,max": edges from min to max) or an integrated slab ("min,max"). A grid point x
 * (coordinates along the axes) is the reflection h_file = Σ x_i·axis_i = Wᵀ·x. Under Mantid's default
 * Q.convention ("inelastic") the file labels NEXPLAN's h as −h (docs/data-verification/MANTID_CONSISTENCY.md), so
 * h = −h_file there and h = h_file under "crystallography".
 */
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { inverse, mulVec, transpose } from "@materia/core/math/mat3";
import { dSpacing } from "@materia/core/crystal/unitCell";
import { z } from "zod";
import type { CalcSuccess } from "../../app/compute.ts";
import { directionTable, recordedCounts } from "../../core/instrument/directionTable.ts";
import { braggCrossings } from "../../core/instrument/simulate.ts";
import { centringConditions, formatHklOp, laueClassName, laueGroupHkl, matchViewerPreset } from "../../core/symmetry/laue.ts";
import { isSystematicallyAbsent, parseSymOp, type IntMat3, type SymOp } from "../../core/symmetry/ops.ts";
import { findByHM, SETTINGS, settingOps } from "../../core/symmetry/spaceGroups.ts";
import { npyBytes } from "../../io/npy.ts";
import { axisName, beamSummary, resolveInstrument } from "../instrument.ts";
import { resolveOrientation } from "../orientation.ts";
import { dMinField, instrumentFields, limitField, orientationField, outputPath, planFields, structureId, vec3, writeBinary, writeText } from "../shared.ts";
import { defineTool, ToolError, type ToolContext } from "../tool.ts";
import { DEFAULT_D_MIN, DEFAULT_WAVELENGTH } from "../workspace.ts";
import { resolvePlan } from "./crystal.ts";

const TWO_PI = 2 * Math.PI;

// ---------------------------------------------------------------- grids

const gridField = z
  .strictObject({
    axes: z.array(vec3).length(3).optional().describe("Projection axes D0, D1, D2 as rows, in r.l.u. of the CIF cell: [[1,0,0],[0,1,0],[0,0,1]] (default) for H, K, L, or e.g. [[1,1,0],[-1,1,0],[0,0,1]]."),
    binning: z
      .array(z.union([z.string(), z.strictObject({ min: z.number(), max: z.number(), bins: z.number().int().min(1) })]))
      .length(3)
      .describe("Per axis: Mantid MDNorm binning 'min,step,max' (bin edges from min to max, as suggest_binning writes), 'min,max' for an integrated slab, or {min, max, bins}."),
    q_convention: z
      .enum(["inelastic", "crystallography"])
      .optional()
      .describe("How the volume was indexed: inelastic (Mantid's default Q.convention, which labels NEXPLAN's h as −h; default, as suggest_binning writes) or crystallography (NEXPLAN's own, and that of X-ray reductions)."),
  })
  .describe("The volume's grid.");

type GridArgs = z.infer<typeof gridField>;

interface Axis {
  readonly min: number;
  readonly max: number;
  readonly bins: number;
  readonly step: number;
  readonly slab: boolean;
}

interface Grid {
  readonly axes: number[][];
  /** h_file = Wt·x. */
  readonly Wt: Mat3;
  readonly WtInv: Mat3;
  readonly sign: 1 | -1;
  readonly dims: readonly [Axis, Axis, Axis];
  readonly convention: "inelastic" | "crystallography";
  readonly centre: (axis: number, i: number) => number;
}

function parseGrid(g: GridArgs): Grid {
  const axes = (g.axes ?? [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) as number[][];
  const Wt = transpose(axes as unknown as Mat3);
  const det = Wt[0][0] * (Wt[1][1] * Wt[2][2] - Wt[1][2] * Wt[2][1]) - Wt[0][1] * (Wt[1][0] * Wt[2][2] - Wt[1][2] * Wt[2][0]) + Wt[0][2] * (Wt[1][0] * Wt[2][1] - Wt[1][1] * Wt[2][0]);
  if (Math.abs(det) < 1e-9) throw new ToolError("The three axes are coplanar: choose independent ones.");
  const dims = g.binning.map((b, i): Axis => {
    if (typeof b !== "string") {
      if (!(b.max > b.min)) throw new ToolError(`Axis ${i}: max must exceed min.`);
      return { min: b.min, max: b.max, bins: b.bins, step: (b.max - b.min) / b.bins, slab: b.bins === 1 };
    }
    const v = b.split(",").map((s) => Number(s.trim()));
    if (v.some((x) => !Number.isFinite(x)) || (v.length !== 2 && v.length !== 3)) throw new ToolError(`Axis ${i}: '${b}' is not 'min,step,max' or 'min,max'.`);
    if (v.length === 2) {
      if (!(v[1]! > v[0]!)) throw new ToolError(`Axis ${i}: '${b}' needs min < max.`);
      return { min: v[0]!, max: v[1]!, bins: 1, step: v[1]! - v[0]!, slab: true };
    }
    const [min, step, max] = v as [number, number, number];
    const n = (max - min) / step;
    if (!(step > 0) || !(max > min) || Math.abs(n - Math.round(n)) > 1e-6 * Math.max(1, n)) throw new ToolError(`Axis ${i}: '${b}' does not split into whole bins of ${step}.`);
    return { min, max, bins: Math.round(n), step, slab: false };
  }) as unknown as [Axis, Axis, Axis];
  const convention = g.q_convention ?? "inelastic";
  return { axes, Wt, WtInv: inverse(Wt), sign: convention === "inelastic" ? -1 : 1, dims, convention, centre: (a, i) => dims[a]!.min + (i + 0.5) * dims[a]!.step };
}

/** NEXPLAN's h at grid coordinates x. */
const hAt = (g: Grid, x: Vec3): Vec3 => {
  const h = mulVec(g.Wt, x);
  return [g.sign * h[0], g.sign * h[1], g.sign * h[2]];
};

/** Grid coordinates of NEXPLAN's h. */
const xOf = (g: Grid, h: readonly number[]): Vec3 => mulVec(g.WtInv, [g.sign * h[0]!, g.sign * h[1]!, g.sign * h[2]!]);

const gridSummary = (g: Grid) => ({
  axes: g.axes,
  bins: g.dims.map((a) => a.bins),
  ranges: g.dims.map((a) => [a.min, a.max]),
  q_convention: g.convention,
  indices: g.convention === "inelastic" ? "grid coordinates are Mantid's (inelastic): NEXPLAN's hkl = −(file hkl)" : "grid coordinates are crystallographic: NEXPLAN's hkl = file hkl",
});

const opsOf = (r: CalcSuccess): SymOp[] => r.structure.ops.map(parseSymOp);

// ---------------------------------------------------------------- Laue symmetry

export const laueSymmetry = defineTool({
  name: "laue_symmetry",
  title: "Laue symmetry for averaging a volume",
  description:
    "The Laue group of a structure (or a space group) as operations on Miller indices, (h′, k′, l′) = M·(h, k, l), written as hkl triplets ('h+k,-h,l; -k,-h,-l; …') in the syntax the NeXus Viewer's symmetry field and NEBULA3D's symmetry_ops / PipelineParams.symmetry read. Gives the Laue class, the NeXus Viewer preset it equals (if any, in the same setting), the point group's own operations, and the reflection conditions of the lattice centring. " +
    "With a volume grid, checks that every operation maps the grid onto itself (needed to symmetrise a binned volume, e.g. NEBULA3D's GridSymmetry): integer on the grid's axes, equal steps on the axes it mixes, and ranges symmetric about zero.",
  input: z.strictObject({
    structure_id: structureId.optional(),
    space_group: z.string().optional().describe("A space-group symbol (e.g. 'P 63/m m c', 'F d -3 m:2') or number, instead of a structure."),
    grid: gridField.optional(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run(args, { workspace }) {
    if ((args.structure_id === undefined) === (args.space_group === undefined)) throw new ToolError("Give structure_id or space_group.");
    let ops: SymOp[];
    let label: string;
    if (args.structure_id !== undefined) {
      const r = await workspace.calculate(args.structure_id, { radiation: "neutron", wavelength: DEFAULT_WAVELENGTH, dMin: Math.max(DEFAULT_D_MIN, 2) });
      ops = opsOf(r);
      label = r.structure.setting ?? `${r.structure.opCount} operations from the CIF`;
    } else {
      const sg = args.space_group!.trim();
      const hits = /^\d+$/.test(sg) ? SETTINGS.filter((s) => s.number === Number(sg)) : findByHM(sg);
      if (!hits.length) throw new ToolError(`Unknown space group '${sg}'.`);
      // Settings of one group differ only in axes or origin; the Laue group depends on the axes, so ask when they differ.
      const groups = new Map(hits.map((s) => [laueGroupHkl(settingOps(s)).map((m) => m.flat().join(",")).sort().join(";"), s]));
      if (groups.size > 1) throw new ToolError(`'${sg}' has settings with different axes: give one of ${hits.map((s) => `'${s.xhm}'`).join(", ")}.`, { candidates: hits.map((s) => s.xhm) });
      const s = hits.find((x) => x.isReference) ?? hits[0]!;
      ops = settingOps(s);
      label = s.xhm;
    }
    const laue = laueGroupHkl(ops);
    const point = [...new Map(ops.map((op) => [op.R.flat().join(","), [0, 1, 2].map((i) => [0, 1, 2].map((j) => op.R[j]![i]! + 0)) as unknown as IntMat3])).values()];
    const preset = matchViewerPreset(laue);
    const triplets = laue.map(formatHklOp);
    const out: Record<string, unknown> = {
      space_group: label,
      laue_class: preset ?? laueClassName(laue),
      order: laue.length,
      ...(preset ? { nexus_viewer_preset: preset } : { nexus_viewer_preset: null, note: "No NeXus Viewer preset equals this group in this setting: paste symmetry_ops into its custom field." }),
      symmetry_ops: triplets.join("; "),
      point_group_ops: point.map(formatHklOp).join("; "),
      centrosymmetric: point.length === laue.length,
      centring_conditions: centringConditions(ops),
      convention: "(h′, k′, l′) = M·(h, k, l); the Laue group is the point group with the inversion added (Friedel's law). Equivalent under either Q convention: the group is the same for h and −h.",
    };
    if (args.grid) {
      const g = parseGrid(args.grid);
      const bad: string[] = [];
      for (const M of laue) {
        // The operation on grid coordinates: A = (Wᵀ)⁻¹·M·Wᵀ (the sign of the convention cancels).
        const A = [0, 1, 2].map((i) => [0, 1, 2].map((j) => [0, 1, 2].reduce((s, k) => s + g.WtInv[i]![k]! * [0, 1, 2].reduce((t, m) => t + M[k]![m]! * g.Wt[m]![j]!, 0), 0)));
        const name = formatHklOp(M);
        if (A.flat().some((v) => Math.abs(v - Math.round(v)) > 1e-9)) {
          bad.push(`${name}: not integer on these axes`);
          continue;
        }
        // x′ = A·x must send bin centres to bin centres: mixed axes need equal bins, a sign flip a range symmetric about
        // 0, and a sum of axes (h+k) a bin centred on 0.
        const symmetric = (a: Axis) => Math.abs(a.min + a.max) < 1e-9 * Math.max(1, Math.abs(a.max));
        const same = (a: Axis, b: Axis) => Math.abs(a.step - b.step) < 1e-9 && Math.abs(a.min - b.min) < 1e-9 && Math.abs(a.max - b.max) < 1e-9;
        for (let i = 0; i < 3; i++) {
          const row = A[i]!.map((v) => Math.round(v));
          const used = row.flatMap((v, j) => (v ? [j] : []));
          const a = g.dims[i]!;
          for (const j of used) {
            const b = g.dims[j]!;
            if (i !== j && (a.slab || b.slab)) bad.push(`${name}: mixes axis ${j} into axis ${i}, but an integrated axis cannot be mixed`);
            else if (i !== j && !same(a, b) && !(symmetric(a) && symmetric(b) && Math.abs(a.step - b.step) < 1e-9 && Math.abs(a.max - b.max) < 1e-9)) bad.push(`${name}: mixes axis ${j} into axis ${i}, whose bins differ`);
          }
          if (row.some((v) => v < 0) && !symmetric(a)) bad.push(`${name}: flips axis ${i}, whose range is not symmetric about 0`);
          if (used.length > 1 && !a.slab && (!symmetric(a) || a.bins % 2 === 0)) bad.push(`${name}: axis ${i} needs a bin centred on 0 (a range symmetric about 0 with an odd number of bins)`);
        }
      }
      out.grid = { ...gridSummary(g), compatible: bad.length === 0, ...(bad.length ? { problems: [...new Set(bad)].slice(0, 24) } : {}) };
    }
    return out;
  },
});

// ---------------------------------------------------------------- Bragg nodes

const CLASS = ["present", "systematic absence", "accidental absence"] as const;

export const braggPositions = defineTool({
  name: "bragg_positions",
  title: "Bragg nodes on a volume's grid",
  description:
    "Every integer reciprocal-lattice node of the structure inside a volume's grid, with its grid coordinates and voxel, d, |Q| (with 2π), |F|² and whether it is present, systematically absent (forbidden by the space group: intensity there is λ/2, multiple scattering, a lower symmetry or a superlattice) or accidentally absent (|F| ≈ 0); optionally the satellites at ±m·k of propagation vectors. " +
    "For marking Bragg peaks on NeXus Viewer slices, as a node prior for NEBULA3D's Bragg punch, or to tell superlattice peaks from diffuse scattering. Writes the full list as CSV or JSON.",
  input: z.strictObject({
    structure_id: structureId,
    grid: gridField,
    d_min: dMinField,
    include: z.enum(["all", "present"]).optional().describe("all (default): absent nodes too, flagged; present: only present ones."),
    propagation_vectors: z.array(vec3).optional().describe("Satellite positions h ± m·k (r.l.u.), e.g. [[0.5,0,0]] or [[0,0,0.333]]; no satellite intensity is computed."),
    satellite_orders: z.number().int().min(1).max(4).optional().describe("Satellite orders m (default 1)."),
    limit: limitField(200, 20000),
    output_path: outputPath.describe("Write every node: CSV for a .csv path, otherwise JSON with the grid. Overwritten if it exists."),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  async run(args, { workspace }) {
    const r = await workspace.calculate(args.structure_id, { radiation: "neutron", wavelength: DEFAULT_WAVELENGTH, dMin: args.d_min ?? DEFAULT_D_MIN });
    const g = parseGrid(args.grid);
    const ops = opsOf(r);
    const R = r.reflections;
    const at = new Map<string, number>();
    for (let i = 0; i < R.h.length; i++) at.set(`${R.h[i]},${R.k[i]},${R.l[i]}`, i);
    const strongest = R.f2.reduce((m, v) => Math.max(m, v), 0);
    const cell = r.structure.cell;
    const tol = 1e-6;
    const inside = (x: Vec3) => g.dims.every((a, i) => x[i]! >= a.min - tol && x[i]! <= a.max + tol);
    const voxel = (x: Vec3) => g.dims.map((a, i) => (a.slab ? 0 : Math.min(a.bins - 1, Math.max(0, Math.floor((x[i]! - a.min) / a.step)))));
    // The grid's box in h: its corners' bounding box, widened by the satellites' reach.
    const ks = (args.propagation_vectors ?? []) as number[][];
    const orders = args.satellite_orders ?? 1;
    const pad = ks.length ? orders * Math.max(...ks.map((k) => Math.max(...k.map(Math.abs)))) : 0;
    const corners: Vec3[] = [];
    for (const a of [g.dims[0].min, g.dims[0].max]) for (const b of [g.dims[1].min, g.dims[1].max]) for (const c of [g.dims[2].min, g.dims[2].max]) corners.push(hAt(g, [a, b, c]));
    const lo = [0, 1, 2].map((i) => Math.floor(Math.min(...corners.map((c) => c[i]!)) - pad));
    const hi = [0, 1, 2].map((i) => Math.ceil(Math.max(...corners.map((c) => c[i]!)) + pad));
    const span = lo.reduce((n, l, i) => n * (hi[i]! - l + 1), 1);
    if (span > 5_000_000) throw new ToolError(`The grid spans ${span.toLocaleString("en-US")} integer nodes; give a smaller region.`);
    const dMin = r.provenance.dMin;
    const nodes: Record<string, unknown>[] = [];
    const counts: Record<string, number> = {};
    const seen = new Set<string>();
    for (let h = lo[0]!; h <= hi[0]!; h++)
      for (let k = lo[1]!; k <= hi[1]!; k++)
        for (let l = lo[2]!; l <= hi[2]!; l++) {
          if (!h && !k && !l) continue;
          const hkl = [h, k, l];
          const d = dSpacing(cell, h, k, l);
          const x = xOf(g, hkl);
          if (inside(x)) {
            const i = at.get(`${h},${k},${l}`);
            const cls: string = i !== undefined ? CLASS[R.cls[i]!]! : isSystematicallyAbsent(ops, [h, k, l]) ? "systematic absence" : "beyond d_min";
            if (args.include !== "present" || cls === "present") {
              counts[cls] = (counts[cls] ?? 0) + 1;
              nodes.push({ hkl, grid: x, voxel: voxel(x), d, q: TWO_PI / d, ...(i !== undefined ? { f2: R.f2[i]!, relative: strongest > 0 ? (100 * R.f2[i]!) / strongest : 0 } : {}), class: cls });
            }
          }
          for (const kv of ks)
            for (let m = 1; m <= orders; m++)
              for (const s of [1, -1]) {
                const p = [h + s * m * kv[0]!, k + s * m * kv[1]!, l + s * m * kv[2]!];
                const xs = xOf(g, p);
                if (!inside(xs)) continue;
                // A commensurate k reaches one position from several parents: list it once.
                const key = p.map((v) => v.toFixed(6)).join(",");
                if (seen.has(key)) continue;
                seen.add(key);
                const ds = dSpacing(cell, p[0]!, p[1]!, p[2]!);
                counts.satellite = (counts.satellite ?? 0) + 1;
                nodes.push({ hkl: p, grid: xs, voxel: voxel(xs), d: ds, q: TWO_PI / ds, class: "satellite", of: hkl, order: s * m, k: kv });
              }
        }
    const rank = { present: 0, satellite: 1, "accidental absence": 2, "systematic absence": 3, "beyond d_min": 4 } as Record<string, number>;
    nodes.sort((a, b) => rank[a.class as string]! - rank[b.class as string]! || ((b.f2 as number) ?? 0) - ((a.f2 as number) ?? 0) || (a.d as number) - (b.d as number));
    let written: string | undefined;
    if (args.output_path) {
      if (/\.csv$/i.test(args.output_path)) {
        const lines = [
          `# NEXPLAN Bragg nodes: ${r.structure.name || r.blockName}; axes ${JSON.stringify(g.axes)}; ${g.convention} convention (grid coordinates as the file's); d_min ${dMin} A`,
          "h,k,l,x0,x1,x2,i0,i1,i2,d_A,Q_invA,F2_fm2,class,parent_h,parent_k,parent_l",
          ...nodes.map((n) => {
            const v = n.voxel as number[];
            const x = n.grid as number[];
            const of = (n.of as number[] | undefined) ?? ["", "", ""];
            return [...(n.hkl as number[]), ...x.map((t) => Number(t.toPrecision(8))), ...v, Number((n.d as number).toPrecision(8)), Number((n.q as number).toPrecision(8)), n.f2 ?? "", n.class, ...of].join(",");
          }),
        ];
        written = await writeText(args.output_path, lines.join("\n") + "\n");
      } else written = await writeText(args.output_path, JSON.stringify({ schema: "nexplan-bragg-nodes/1", structure: r.structure.name || r.blockName, d_min: dMin, grid: gridSummary(g), units: { d: "Å", q: "1/Å with 2π", f2: "fm²" }, nodes }, null, 1));
    }
    const limit = args.limit ?? 200;
    return {
      structure_id: args.structure_id,
      grid: gridSummary(g),
      d_min: dMin,
      counts,
      total: nodes.length,
      shown: Math.min(limit, nodes.length),
      nodes: nodes.slice(0, limit),
      ...(written ? { written } : {}),
      units: { grid: "coordinates along the axes, as the file's", voxel: "bin indices from 0 (an integrated axis is 0)", d: "Å", q: "1/Å with 2π", f2: "fm² (neutron)" },
      ...(counts["beyond d_min"] ? { note: `Some nodes have d below d_min = ${dMin} Å, so their |F| is not calculated (only absences are known); pass a smaller d_min.` } : {}),
    };
  },
});

// ---------------------------------------------------------------- coverage

export const coverageMap = defineTool({
  name: "coverage_map",
  title: "What a measurement records on a volume's grid",
  description:
    "Predicts which voxels of a reciprocal-space volume a single-crystal measurement plan records (an orientation list or a rotation scan, with the crystal's UB), as the number of settings recording each voxel or a 0/1 mask, written as a NumPy .npy array on the volume's grid. " +
    "For telling unmeasured from empty or punched space: NEBULA3D's backfill and ΔPDF support window, or the coverage wedges and detector-edge rims seen in NeXus Viewer slices. Computed on a grid of at most max_points points (every n-th voxel) and written at the volume's full size by nearest neighbour; detector directions are tabulated at 0.1°, so voxels at a coverage edge may differ.",
  input: z.strictObject({
    structure_id: structureId,
    orientation: orientationField,
    ...instrumentFields,
    ...planFields,
    grid: gridField,
    values: z.enum(["count", "mask"]).optional().describe("count (default): settings recording each voxel (uint16); mask: 1 where recorded at all (uint8)."),
    array_order: z.enum(["mantid", "hkl"]).optional().describe("mantid (default): shape (n2, n1, n0), as a Mantid MDHisto signal and the NeXus Viewer store it; hkl: shape (n0, n1, n2), as NEBULA3D's HKLVolume."),
    max_points: z.number().int().min(1000).max(5_000_000).optional().describe("Most grid points computed (default 400000)."),
    output_path: outputPath.describe("Write the array as .npy; overwritten if it exists."),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  async run(args, ctx: ToolContext) {
    const ins = await resolveInstrument(args, ctx.workspace);
    if (!ins.model.axes.some((ax) => ax.fixed === undefined)) throw new ToolError(`${ins.preset.label} has no goniometer: coverage maps are for single crystals.`);
    const r = await ctx.workspace.calculate(args.structure_id, { radiation: "neutron", wavelength: DEFAULT_WAVELENGTH, dMin: Math.max(DEFAULT_D_MIN, 2) });
    const o = await resolveOrientation(r, args.orientation);
    const plan = resolvePlan(ins, args);
    const g = parseGrid(args.grid);
    const n = g.dims.map((a) => a.bins);
    const total = n[0]! * n[1]! * n[2]!;
    if (total > 64_000_000) throw new ToolError(`The grid has ${total.toLocaleString("en-US")} voxels; coverage maps are limited to 64 million.`);
    // Every s-th voxel along each binned axis, so that at most max_points are computed.
    const maxPoints = args.max_points ?? 400_000;
    const binned = g.dims.filter((a) => !a.slab).length || 1;
    const s = Math.max(1, Math.ceil((total / maxPoints) ** (1 / binned)));
    const coarse = g.dims.map((a) => (a.slab ? 1 : Math.ceil(a.bins / s)));
    const idx = (a: number, c: number) => (g.dims[a]!.slab ? 0 : Math.min(g.dims[a]!.bins - 1, c * s + Math.floor(s / 2)));
    const qs: Vec3[] = [];
    for (let i = 0; i < coarse[0]!; i++)
      for (let j = 0; j < coarse[1]!; j++)
        for (let k = 0; k < coarse[2]!; k++) {
          const x: Vec3 = [g.dims[0].slab ? (g.dims[0].min + g.dims[0].max) / 2 : g.centre(0, idx(0, i)), g.dims[1].slab ? (g.dims[1].min + g.dims[1].max) / 2 : g.centre(1, idx(1, j)), g.dims[2].slab ? (g.dims[2].min + g.dims[2].max) / 2 : g.centre(2, idx(2, k))];
          qs.push(mulVec(o.UB, hAt(g, x)));
        }
    const { model, panels, exp, shadows } = ins;
    let counts: Uint16Array;
    let method: string;
    if (ins.preset.incident && plan.kind === "scan") {
      counts = new Uint16Array(qs.length);
      const I3: Mat3 = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ];
      const half = plan.scan.step / 2;
      for (const c of braggCrossings(model, plan.axis, plan.base, { start: plan.scan.start - half, end: plan.scan.end + half }, I3, qs.map((h) => ({ h, family: 0 })), panels, (exp.lambdaMin + exp.lambdaMax) / 2, shadows)) if (c.hit) counts[c.index]!++;
      method = "exact Bragg crossings over the scan";
    } else {
      const table = directionTable(panels);
      counts = recordedCounts(model, plan.settings, qs, table, exp.lambdaMin, exp.lambdaMax, shadows);
      method = `Laue test at each of ${plan.settings.length} settings; detector directions tabulated at ${table.step}°`;
    }
    // The full grid, nearest coarse point per voxel, in the requested order.
    const mask = args.values === "mask";
    const out = mask ? new Uint8Array(total) : new Uint16Array(total);
    const order = args.array_order ?? "mantid";
    const ci = (a: number, v: number) => (g.dims[a]!.slab ? 0 : Math.min(coarse[a]! - 1, Math.floor(v / s)));
    let measured = 0;
    for (let i = 0; i < n[0]!; i++)
      for (let j = 0; j < n[1]!; j++)
        for (let k = 0; k < n[2]!; k++) {
          const c = counts[(ci(0, i) * coarse[1]! + ci(1, j)) * coarse[2]! + ci(2, k)]!;
          if (c) measured++;
          const at = order === "hkl" ? (i * n[1]! + j) * n[2]! + k : (k * n[1]! + j) * n[0]! + i;
          out[at] = mask ? (c ? 1 : 0) : c;
        }
    const shape = order === "hkl" ? n : [n[2]!, n[1]!, n[0]!];
    const written = args.output_path ? await writeBinary(args.output_path, npyBytes(out, shape)) : undefined;
    let maxCount = 0;
    for (const c of counts) maxCount = Math.max(maxCount, c);
    return {
      instrument: ins.preset.label,
      beam: beamSummary(ins),
      orientation: o.description,
      plan: plan.kind === "list" ? `orientation list of ${plan.settings.length}` : `scan of ${axisName(model.axes[plan.axis]!.name)} ${plan.scan.start}–${plan.scan.end}° in ${plan.scan.step}° steps`,
      grid: gridSummary(g),
      computed_on: { shape: coarse, every: s, points: qs.length },
      method,
      fraction_recorded: measured / total,
      most_recordings: maxCount,
      array: { values: mask ? "uint8, 1 = recorded" : "uint16, settings recording the voxel", order, shape },
      ...(written ? { written } : { note: "Give output_path to write the array." }),
      ...([...ins.notes, ...o.warnings].length ? { notes: [...ins.notes, ...o.warnings] } : {}),
    };
  },
});
