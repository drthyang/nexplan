/** UB matrices: read and check one, re-index it to another cell, or build one from a mount (Mantid SetUB). */
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { determinant, mulMat } from "@materia/core/math/mat3";
import { z } from "zod";
import { BASIS_PRESETS, hklTransformText, supercell } from "../../core/ub/basis.ts";
import { goniometerMatrix } from "../../core/ub/goniometer.ts";
import { mountUB, planeGeometry, setUBCall, zoneAxis, type ScatteringPlane } from "../../core/ub/mount.ts";
import { axisAngle, directBasisInSample, latticeFromUB, nearestIndices, orientationFromUB, transformUB } from "../../core/ub/ub.ts";
import { formatIsawUB } from "../../io/isaw.ts";
import { hklText } from "../../ui/format.ts";
import { cellMatches, chosenMatch } from "../../ui/ubShared.ts";
import { axisName, resolveAngles, resolveInstrument } from "../instrument.ts";
import { loadUB, matchSummary } from "../orientation.ts";
import { anglesField, instrumentField, mat3, outputPath, structureId, vec3, writeText } from "../shared.ts";
import { defineTool, ToolError } from "../tool.ts";
import { DEFAULT_D_MIN, DEFAULT_WAVELENGTH } from "../workspace.ts";

const ubSource = {
  ub: mat3.optional().describe("UB matrix (rows), Mantid sample frame: q = UB·h in 1/Å without 2π."),
  ub_path: z.string().optional().describe("Path to an ISAW UB file (.mat)."),
  ub_text: z.string().optional().describe("Contents of an ISAW UB file."),
};

const lattice = (UB: Mat3) => {
  const l = latticeFromUB(UB);
  return { a: l.a, b: l.b, c: l.c, alpha: l.alpha, beta: l.beta, gamma: l.gamma, volume: l.volume };
};

/** The crystal directions nearest the beam (+z) and the vertical (+y) at rotation R, as (hkl) and [uvw]. */
function along(R: Mat3, UB: Mat3) {
  const RUB = mulMat(R, UB);
  const A = directBasisInSample(RUB);
  const fmt = (x: { indices: Vec3; angleDeg: number }, rec: boolean) => ({ indices: x.indices, text: rec ? `(${hklText(x.indices)})` : `[${hklText(x.indices)}]`, off_by_deg: x.angleDeg });
  return {
    beam: { reciprocal: fmt(nearestIndices(RUB, [0, 0, 1]), true), direct: fmt(nearestIndices(A, [0, 0, 1]), false) },
    vertical: { reciprocal: fmt(nearestIndices(RUB, [0, 1, 0]), true), direct: fmt(nearestIndices(A, [0, 1, 0]), false) },
  };
}

/** UB in the physics convention (Q = 2π·UB·h), as NEBULA3D holds it in memory and in its HDF5 files. */
const times2pi = (UB: Mat3) => UB.map((row) => row.map((v) => 2 * Math.PI * v));

const I3: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

export const analyzeUB = defineTool({
  name: "analyze_ub",
  title: "Read and check a UB matrix",
  description:
    "Reads a UB (matrix, or ISAW .mat file as Mantid's SaveIsawUB writes it) and reports its lattice, U and B, whether U is a proper rotation, and the crystal directions along the beam and the vertical (at zero goniometer angles, or at a setting of an instrument). " +
    "With a structure, finds the cells of the structure the UB fits: the same cell in another setting, a supercell (e.g. 2 × 2 × 2) or a smaller cell, within 2 %, and gives the UB in the CIF cell (what the single-crystal tools use).",
  input: z.strictObject({
    ...ubSource,
    structure_id: structureId.optional().describe("Compare the UB's cell with this structure's."),
    instrument: instrumentField.optional().describe("With angles: report the directions at this instrument's goniometer setting."),
    angles: anglesField,
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run(args, { workspace }) {
    const file = await loadUB(args);
    if (!file) throw new ToolError("Give the UB: ub, ub_path or ub_text.");
    const UB = file.UB;
    const o = orientationFromUB(UB);
    const aa = axisAngle(o.U);
    let R = I3;
    let at = "zero goniometer angles";
    if (args.instrument) {
      const ins = await resolveInstrument({ instrument: args.instrument });
      const angles = resolveAngles(ins.model, args.angles);
      R = goniometerMatrix(ins.model, angles);
      at = `${ins.preset.label} at ${ins.model.axes.map((ax, i) => `${axisName(ax.name)} = ${angles[i]}°`).join(", ") || "its fixed sample position"}`;
    } else if (args.angles) throw new ToolError("angles need an instrument (its goniometer).");
    const warnings = [...file.warnings];
    if (o.detUB <= 0) warnings.push("det(UB) ≤ 0: a left-handed basis.");
    if (o.orthogonalityError > 1e-3) warnings.push(`U is not a rotation (max |UᵀU − I| = ${o.orthogonalityError.toExponential(2)}).`);
    let cif: object | undefined;
    if (args.structure_id) {
      const r = await workspace.calculate(args.structure_id, { radiation: "neutron", wavelength: DEFAULT_WAVELENGTH, dMin: Math.max(DEFAULT_D_MIN, 2) });
      const matches = cellMatches(r.structure.cell, UB, r.structure.rotations);
      const best = chosenMatch(matches, { warnings: [] });
      cif = {
        structure_id: args.structure_id,
        cif_cell: r.structure.cell,
        matches: matches.map((m, i) => matchSummary(m, i)),
        ...(best ? { ub_in_cif_cell: best.ubForCif } : { message: "The UB cell does not match the CIF cell, a supercell of it or a smaller cell of it (within 2 %); CIF indices would not be the UB's. transform_ub re-indexes a UB." }),
      };
    }
    return {
      source: file.fileName,
      ub: UB,
      ub_times_2pi: times2pi(UB),
      lattice: lattice(UB),
      ...(file.latticeLine ? { lattice_line_in_file: file.latticeLine } : {}),
      U: o.U,
      B: o.B,
      det_ub: o.detUB,
      u_rotation: { axis: aa.axis, angle_deg: aa.angleDeg },
      directions: { at, ...along(R, UB) },
      ...(cif ? { structure: cif } : {}),
      ...(warnings.length ? { warnings } : {}),
      conventions: "Mantid sample frame: beam +z, up +y; q = UB·h in 1/Å without 2π (ub, as Mantid and ISAW files), or Q = 2π·UB·h (ub_times_2pi, NEBULA3D's in-memory and HDF5 ub_matrix); ISAW files store UBᵀ in IPNS axes, converted on reading.",
    };
  },
});

export const transformUBTool = defineTool({
  name: "transform_ub",
  title: "Re-index a UB to another cell",
  description:
    "Writes the UB for another cell of the same crystal: a supercell (to index superlattice or magnetic peaks), a smaller cell, the primitive cell of a centred lattice, or any setting given by P, where (a, b, c)_new = (a, b, c)_old · P and h_new = Pᵀ·h_old. Reflections stay where they are; only their indices change. " +
    "Returns the new UB and lattice, the ISAW file text (written to output_path if given) and the Mantid TransformHKL call for a peaks workspace.",
  input: z.strictObject({
    ...ubSource,
    P: mat3.optional().describe("Transformation P (rows): the new axes' components in the old axes are P's columns."),
    supercell: z.array(z.number().positive()).length(3).optional().describe("Multiples of a, b, c: [2, 2, 2] for a doubled cell, [0.5, 0.5, 0.5] for a halved one."),
    preset: z.enum(BASIS_PRESETS.map((b) => b.id) as [string, ...string[]]).optional().describe(`A common transformation: ${BASIS_PRESETS.map((b) => `${b.id} (${b.label})`).join("; ")}.`),
    output_path: outputPath.describe("Write the new UB as an ISAW file (.mat); overwritten if it exists."),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  async run(args) {
    const file = await loadUB(args);
    if (!file) throw new ToolError("Give the UB: ub, ub_path or ub_text.");
    const given = [args.P, args.supercell, args.preset].filter((x) => x !== undefined).length;
    if (given !== 1) throw new ToolError("Give one transformation: P, supercell or preset.");
    const P: Mat3 = args.P ? (args.P as unknown as Mat3) : args.supercell ? supercell(args.supercell[0]!, args.supercell[1]!, args.supercell[2]!) : BASIS_PRESETS.find((b) => b.id === args.preset)!.P;
    const det = determinant(P);
    if (!(det > 1e-9)) throw new ToolError(`det P = ${det}: P must keep a right-handed cell (det P > 0).`);
    const UB = transformUB(file.UB, P);
    const text = formatIsawUB(UB);
    const written = args.output_path ? await writeText(args.output_path, text) : undefined;
    return {
      source: file.fileName,
      P,
      det_P: det,
      volume_ratio: det,
      ub: UB,
      lattice_before: lattice(file.UB),
      lattice: lattice(UB),
      indices: "h_new = Pᵀ·h_old",
      mantid_transform_hkl: `TransformHKL(PeaksWorkspace="peaks", HKLTransform="${hklTransformText(P)}")`,
      isaw: text,
      ...(written ? { written } : {}),
    };
  },
});

export const mountCrystal = defineTool({
  name: "mount_crystal",
  title: "Orient a crystal by its scattering plane",
  description:
    "The UB of a crystal mounted with u (r.l.u.) along the beam and v horizontal at zero goniometer angles, as Mantid's SetUB(u, v) sets it for the structure's cell, so (u, v) is the horizontal scattering plane, e.g. (H K 0) with u = [1,0,0], v = [0,1,0] or (H H L) with u = [1,1,0], v = [0,0,1]. " +
    "Returns the UB, the SetUB call, the zone axis, and with an instrument and angles where the plane is then (tilt from the horizontal, angle to the beam). The single-crystal tools take the same mount as orientation {u, v}.",
  input: z.strictObject({
    structure_id: structureId,
    u: vec3.describe("Along the beam at zero angles (r.l.u.)."),
    v: vec3.describe("Horizontal, perpendicular to the beam at zero angles (r.l.u.)."),
    instrument: instrumentField.optional(),
    angles: anglesField,
    output_path: outputPath.describe("Write the UB as an ISAW file (.mat); overwritten if it exists."),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  async run(args, { workspace }) {
    const r = await workspace.calculate(args.structure_id, { radiation: "neutron", wavelength: DEFAULT_WAVELENGTH, dMin: Math.max(DEFAULT_D_MIN, 2) });
    const plane: ScatteringPlane = { u: args.u as unknown as Vec3, v: args.v as unknown as Vec3 };
    let UB: Mat3;
    try {
      UB = mountUB(r.structure.cell, plane);
    } catch (e) {
      throw new ToolError(`Cannot mount u (${hklText(plane.u)}), v (${hklText(plane.v)}): ${(e as Error).message}. Choose two independent vectors.`);
    }
    let R = I3;
    let at = "zero goniometer angles";
    if (args.instrument) {
      const ins = await resolveInstrument({ instrument: args.instrument });
      const angles = resolveAngles(ins.model, args.angles);
      R = goniometerMatrix(ins.model, angles);
      at = `${ins.preset.label} at ${ins.model.axes.map((ax, i) => `${axisName(ax.name)} = ${angles[i]}°`).join(", ") || "its fixed sample position"}`;
    } else if (args.angles) throw new ToolError("angles need an instrument (its goniometer).");
    const g = planeGeometry(UB, R, plane);
    const text = formatIsawUB(UB);
    const written = args.output_path ? await writeText(args.output_path, text) : undefined;
    return {
      structure_id: args.structure_id,
      ub: UB,
      ub_times_2pi: times2pi(UB),
      U: orientationFromUB(UB).U,
      mantid_setub: setUBCall(r.structure.cell, plane),
      zone_axis: zoneAxis(plane),
      plane: { at, tilt_from_horizontal_deg: g.tiltDeg, beam_angle_to_plane_deg: g.beamDeg, normal_lab: g.normal },
      directions: along(R, UB),
      isaw: text,
      ...(written ? { written } : {}),
    };
  },
});
