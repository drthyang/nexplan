/** Structures and reflections: load a CIF, describe it, list its reflections, explain one. */
import { dSpacing } from "@materia/core/crystal/unitCell";
import { z } from "zod";
import type { CalcSuccess } from "../../app/compute.ts";
import { hklText } from "../../ui/format.ts";
import { REFERENCES } from "../../ui/standards.ts";
import { hklMiss } from "../../ui/ubShared.ts";
import { dMinField, hklField, limitField, outputPath, readText, structureId, writeText } from "../shared.ts";
import { defineTool, ToolError } from "../tool.ts";
import { DEFAULT_D_MIN, DEFAULT_WAVELENGTH, failureDetails, type LoadedStructure, type StructureChoices, type Workspace } from "../workspace.ts";

const BUNDLED = REFERENCES.map((r) => r.id) as [string, ...string[]];

export const radiationFields = {
  radiation: z.enum(["neutron", "xray"]).optional().describe("Radiation for structure factors: neutron (Sears 1992 coherent b; default) or xray (Waasmaier–Kirfel f0, non-resonant)."),
  wavelength: z.number().positive().max(100).optional().describe(`Wavelength (Å) for 2θ; default ${DEFAULT_WAVELENGTH}.`),
  d_min: dMinField,
};

/** The calculation a structure tool reads: radiation and d_min (the wavelength only sets 2θ). */
export async function calcFor(ws: Workspace, id: string, args: { radiation?: "neutron" | "xray" | undefined; wavelength?: number | undefined; d_min?: number | undefined }): Promise<CalcSuccess> {
  return ws.calculate(id, { radiation: args.radiation ?? "neutron", wavelength: args.wavelength ?? DEFAULT_WAVELENGTH, dMin: args.d_min ?? DEFAULT_D_MIN });
}

const CLASS = ["present", "systematic absence", "accidental absence"] as const;

/** The radiation and its table, briefly (the provenance has the full citation). */
export const radiationLabel = (r: CalcSuccess) => (r.provenance.settings.radiation === "xray" ? "X-ray, Waasmaier–Kirfel (1995) f0, non-resonant" : "neutron, Sears (1992) coherent b");

/** 2θ (deg) of spacing d at wavelength λ, or undefined beyond backscattering. */
const twoThetaOf = (d: number, lambda: number) => (lambda / (2 * d) <= 1 ? (2 * Math.asin(lambda / (2 * d)) * 180) / Math.PI : undefined);

/** What a caller needs to know about a structure as read. */
export function structureSummary(s: LoadedStructure, r: CalcSuccess) {
  const st = r.structure;
  return {
    structure_id: s.id,
    file: s.fileName,
    block: r.blockName,
    ...(r.blocks.filter((b) => b.hasStructure).length > 1 ? { other_blocks: r.blocks.filter((b) => b.hasStructure && b.name !== r.blockName).map((b) => b.name) } : {}),
    name: st.name,
    ...(st.formula ? { formula: st.formula } : {}),
    cell: { ...st.cell, volume: st.volume },
    space_group: { ...(st.setting ? { setting: st.setting, number: st.settingNumber, hall: st.hall } : {}), from: st.symmetrySource, operations: st.opCount },
    sites: st.sites.map((x) => ({ label: x.label, species: x.species, x: x.x, y: x.y, z: x.z, occupancy: x.occupancy, b_iso: x.bIso, multiplicity: x.multiplicity })),
    cell_content: Object.fromEntries(st.content),
    ...(st.codId ? { cod_id: st.codId } : {}),
    ...(st.doi ? { doi: st.doi } : {}),
    ...(st.temperatureK ? { temperature_k: st.temperatureK } : {}),
    ...(r.diagnostics.length ? { notes: r.diagnostics.map((d) => `${d.severity}: ${d.message}`) } : {}),
  };
}

export const loadStructure = defineTool({
  name: "load_structure",
  title: "Load a crystal structure",
  description:
    "Read a crystal structure from a CIF (1.1) file, CIF text, or one bundled with NEXPLAN, and return its id with what was read: cell, space group, sites and cell content. Every other structure tool takes the id. " +
    "When the CIF is ambiguous (several data blocks, a space-group setting such as an origin choice or rhombohedral axes, unclear species), the result has status 'needs_choice' with the candidates: call load_structure again with the structure_id and the choice (block, setting or species). NEXPLAN asks rather than guesses.",
  input: z.strictObject({
    path: z.string().optional().describe("Path to a CIF file."),
    cif_text: z.string().optional().describe("CIF text, when there is no file."),
    bundled: z.enum(BUNDLED).optional().describe("A structure shipped with NEXPLAN (COD entries): si, vanadium, diamond, ceo2, al2o3 (reference standards), spinel, quartz, nacl (demos)."),
    structure_id: structureId.optional().describe("A structure already loaded, to read again with new choices (block, setting, species, xray_ions)."),
    name: z.string().optional().describe("Id to give a new structure; default from the file name."),
    block: z.string().optional().describe("The CIF data block to read, when several hold a structure."),
    setting: z.string().optional().describe("The space-group setting, when the CIF's symmetry is ambiguous; a 'needs_choice' result lists the candidates."),
    species: z.record(z.string(), z.string()).optional().describe('Species for site labels whose type symbol is ambiguous, e.g. {"M1": "Fe"}.'),
    xray_ions: z.record(z.string(), z.string()).optional().describe('X-ray only: site label → tabulated ion whose f0 to use, e.g. {"Fe1": "Fe3+"}; other sites use the neutral atom.'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run(args, { workspace }) {
    const sources = [args.path, args.cif_text, args.bundled].filter((x) => x !== undefined).length;
    const choices: StructureChoices = {
      ...(args.block !== undefined ? { blockName: args.block } : {}),
      ...(args.setting !== undefined ? { chosenSetting: args.setting } : {}),
      ...(args.species !== undefined ? { speciesOverrides: args.species } : {}),
      ...(args.xray_ions !== undefined ? { xrayIons: args.xray_ions } : {}),
    };
    let s: LoadedStructure;
    if (args.structure_id !== undefined && sources > 0) throw new ToolError("Give structure_id alone (to read a loaded structure with new choices), or a source (path, cif_text or bundled) for a new one.");
    if (args.structure_id !== undefined) {
      s = workspace.update(args.structure_id, { ...workspace.get(args.structure_id).choices, ...choices });
    } else {
      if (sources !== 1) throw new ToolError("Give one source: path, cif_text or bundled (or structure_id alone to change the choices of a loaded structure).");
      let text: string;
      let fileName: string;
      let source: string;
      if (args.path !== undefined) {
        const f = await readText(args.path, "CIF");
        ({ text, name: fileName, path: source } = f);
      } else if (args.bundled !== undefined) {
        const ref = REFERENCES.find((r) => r.id === args.bundled)!;
        text = await ref.load();
        fileName = ref.file;
        source = `bundled: ${ref.label}. ${ref.source}`;
      } else {
        text = args.cif_text!;
        fileName = `${args.name ?? "structure"}.cif`;
        source = "CIF text given inline";
      }
      s = workspace.add({ fileName, cifText: text, source, choices }, args.name ?? args.bundled ?? fileName);
    }

    // Read at the default d_min; a large cell that exceeds the reflection limit there is summarised at a larger one.
    let r = await workspace.run(s, { radiation: "neutron", wavelength: DEFAULT_WAVELENGTH, dMin: DEFAULT_D_MIN });
    let note: string | undefined;
    if (!r.ok && r.stage === "limit" && r.suggestedDMin !== undefined) {
      note = `${r.message} Pass d_min ≥ ${r.suggestedDMin} to the other tools.`;
      r = await workspace.run(s, { radiation: "neutron", wavelength: DEFAULT_WAVELENGTH, dMin: r.suggestedDMin });
    }
    if (!r.ok) {
      if (r.stage === "block" || r.stage === "symmetry" || r.stage === "species")
        return {
          status: "needs_choice",
          structure_id: s.id,
          message: r.message,
          ...failureDetails(r),
          next: `Call load_structure with structure_id '${s.id}' and ${r.stage === "block" ? "block" : r.stage === "species" ? "species" : "setting"} set to one of the candidates.`,
        };
      workspace.remove(s.id);
      throw new ToolError(r.message, failureDetails(r));
    }
    workspace.markReported(s.id, r);
    return { status: "ok", ...structureSummary(s, r), source: s.source, ...(note ? { d_min_note: note } : {}) };
  },
});

export const describeStructure = defineTool({
  name: "describe_structure",
  title: "Describe a loaded structure",
  description:
    "Full detail of a loaded structure: the summary of load_structure plus the symmetry operations, each site's scattering (neutron b source and Sears cross-sections in barn, the X-ray f0 in use and the ions available), and the choices in effect. Without structure_id, lists the structures loaded in this session.",
  input: z.strictObject({ structure_id: structureId.optional() }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run(args, { workspace }) {
    if (args.structure_id === undefined) return { structures: workspace.list().map((s) => ({ structure_id: s.id, file: s.fileName, source: s.source, choices: s.choices })) };
    const s = workspace.get(args.structure_id);
    const r = await calcFor(workspace, s.id, { d_min: Math.max(DEFAULT_D_MIN, 2) });
    workspace.markReported(s.id, r);
    return {
      ...structureSummary(s, r),
      source: s.source,
      choices: s.choices,
      symmetry_operations: r.structure.ops,
      scattering: r.structure.sites.map((x) => ({
        label: x.label,
        ...(x.typeSymbol ? { type_symbol: x.typeSymbol } : {}),
        neutron: { species: x.neutronXs.id, b_source: x.amplitudeSource, tier: x.tier, coherent_xs_barn: x.neutronXs.coh, incoherent_xs_barn: x.neutronXs.inc, absorption_xs_2200_barn: x.neutronXs.abs2200, resonant: x.neutronXs.resonant },
        xray: { f0: x.xrayFormFactor, options: x.xrayOptions },
      })),
    };
  },
});

export const listReflections = defineTool({
  name: "list_reflections",
  title: "List reflections",
  description:
    "Reflections of a structure down to d_min with d, Q = 2π/d, 2θ at the wavelength, the complex structure factor F (neutron: fm; X-ray: electrons) and |F|², folded into symmetry families by default (one row per family with its multiplicity; Friedel mates merged unless amplitudes are complex). " +
    "Absences (systematic, from the space group, or accidental, |F| ≈ 0) are left out unless include_absent. Sorted by d (longest first) or by |F|².",
  input: z.strictObject({
    structure_id: structureId,
    ...radiationFields,
    fold: z.boolean().optional().describe("One row per symmetry family (default true); false lists every signed hkl."),
    include_absent: z.boolean().optional().describe("Include systematically and accidentally absent reflections (default false)."),
    d_range: z.strictObject({ min: z.number().positive().optional(), max: z.number().positive().optional() }).optional().describe("Only reflections with d in this range (Å)."),
    sort: z.enum(["d", "f2"]).optional().describe("d: longest d first (default); f2: strongest first."),
    limit: limitField(100, 5000),
    output_path: outputPath.describe("Also write every row that passes the filters as CSV to this file (overwritten if it exists)."),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  async run(args, { workspace }) {
    const r = await calcFor(workspace, args.structure_id, args);
    const R = r.reflections;
    const lambda = args.wavelength ?? DEFAULT_WAVELENGTH;
    const fold = args.fold ?? true;
    const lo = args.d_range?.min ?? 0;
    const hi = args.d_range?.max ?? Infinity;
    const counts = new Map<number, number>();
    for (let i = 0; i < R.h.length; i++) counts.set(R.family[i]!, (counts.get(R.family[i]!) ?? 0) + 1);
    const seen = new Set<number>();
    const rows: { i: number; hkl: [number, number, number]; multiplicity?: number }[] = [];
    for (let i = 0; i < R.h.length; i++) {
      if (!args.include_absent && R.cls[i] !== 0) continue;
      if (R.d[i]! < lo || R.d[i]! > hi) continue;
      if (!fold) {
        rows.push({ i, hkl: [R.h[i]!, R.k[i]!, R.l[i]!] });
        continue;
      }
      const f = R.family[i]!;
      if (seen.has(f)) continue;
      seen.add(f);
      rows.push({ i, hkl: [R.familyRep[3 * f]!, R.familyRep[3 * f + 1]!, R.familyRep[3 * f + 2]!], multiplicity: counts.get(f)! });
    }
    rows.sort((a, b) => (args.sort === "f2" ? R.f2[b.i]! - R.f2[a.i]! : R.d[b.i]! - R.d[a.i]! || R.f2[b.i]! - R.f2[a.i]!));
    const row = (x: (typeof rows)[number]) => {
      const i = x.i;
      const tt = twoThetaOf(R.d[i]!, lambda);
      return {
        hkl: x.hkl,
        d: R.d[i]!,
        q: (2 * Math.PI) / R.d[i]!,
        ...(tt !== undefined ? { two_theta: tt } : {}),
        f_re: R.re[i]!,
        f_im: R.im[i]!,
        f2: R.f2[i]!,
        ...(x.multiplicity !== undefined ? { multiplicity: x.multiplicity } : {}),
        ...(R.cls[i] !== 0 ? { class: CLASS[R.cls[i]!] } : {}),
      };
    };
    let written: string | undefined;
    if (args.output_path) {
      const lines = [
        `# NEXPLAN reflections: ${r.structure.name || r.blockName}; ${r.provenance.radiation}; d_min ${r.provenance.dMin} A; 2theta at ${lambda} A; input sha256 ${r.provenance.inputSha256}`,
        `h,k,l,d_A,Q_invA,two_theta_deg,F_re,F_im,F2${fold ? ",multiplicity" : ""},class`,
        ...rows.map((x) => {
          const v = row(x);
          return [...x.hkl, v.d, v.q, v.two_theta ?? "", v.f_re, v.f_im, v.f2, ...(fold ? [x.multiplicity] : []), CLASS[R.cls[x.i]!]].map((c) => (typeof c === "number" && !Number.isInteger(c) ? Number(c.toPrecision(8)) : c)).join(",");
        }),
      ];
      written = await writeText(args.output_path, lines.join("\n") + "\n");
    }
    const limit = args.limit ?? 100;
    return {
      structure_id: args.structure_id,
      radiation: radiationLabel(r),
      d_min: r.provenance.dMin,
      wavelength: lambda,
      units: { d: "Å", q: "1/Å (2π/d)", two_theta: "deg", F: r.provenance.settings.radiation === "xray" ? "electrons" : "fm" },
      friedel_merged: r.friedelMerged,
      total: rows.length,
      shown: Math.min(limit, rows.length),
      reflections: rows.slice(0, limit).map(row),
      ...(written ? { written } : {}),
      ...(workspace.newNotes(args.structure_id, r).length ? { notes: workspace.newNotes(args.structure_id, r) } : {}),
    };
  },
});

export const reflectionInfo = defineTool({
  name: "reflection_info",
  title: "Explain one reflection",
  description:
    "Everything about one hkl: d, Q, 2θ at the wavelength, F and |F|², its rank among the present reflections, its symmetry family (equivalents and multiplicity), and, if it is not observed, why: a systematic absence (forbidden by the space group), an accidental absence (|F| ≈ 0) or below d_min.",
  input: z.strictObject({ structure_id: structureId, hkl: hklField, ...radiationFields }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run(args, { workspace }) {
    const r = await calcFor(workspace, args.structure_id, args);
    const R = r.reflections;
    const [h, k, l] = args.hkl as [number, number, number];
    if (h === 0 && k === 0 && l === 0) throw new ToolError("(0 0 0) is the direct beam, not a reflection.");
    const lambda = args.wavelength ?? DEFAULT_WAVELENGTH;
    let at = -1;
    for (let i = 0; i < R.h.length && at < 0; i++) if (R.h[i] === h && R.k[i] === k && R.l[i] === l) at = i;
    const d = dSpacing(r.structure.cell, h, k, l);
    const tt = twoThetaOf(d, lambda);
    const base = { hkl: args.hkl, d, q: (2 * Math.PI) / d, ...(tt !== undefined ? { two_theta: tt, wavelength: lambda } : {}) };
    if (at < 0) {
      const miss = hklMiss(r, args.hkl.join(" "));
      return { ...base, status: miss.kind === "dmin" ? "below d_min" : "not calculated", message: miss.message, ...(miss.kind === "dmin" ? { next: `Pass d_min ≤ ${Math.floor(d * 1000) / 1000} to calculate it.` } : {}) };
    }
    const fam = R.family[at]!;
    const members: number[][] = [];
    for (let i = 0; i < R.h.length; i++) if (R.family[i] === fam) members.push([R.h[i]!, R.k[i]!, R.l[i]!]);
    let rank = 1;
    let strongest = 0;
    const seen = new Set<number>();
    for (let i = 0; i < R.h.length; i++) {
      if (R.cls[i] !== 0) continue;
      strongest = Math.max(strongest, R.f2[i]!);
      if (R.f2[i]! > R.f2[at]! && !seen.has(R.family[i]!)) {
        seen.add(R.family[i]!);
        rank++;
      }
    }
    const status = CLASS[R.cls[at]!];
    const message = R.cls[at] === 0 ? `(${hklText(args.hkl)}) is present.` : hklMiss(r, args.hkl.join(" ")).message;
    return {
      ...base,
      status,
      message,
      f_re: R.re[at]!,
      f_im: R.im[at]!,
      f_abs: Math.hypot(R.re[at]!, R.im[at]!),
      ...(R.cls[at] === 0 ? { phase_deg: (Math.atan2(R.im[at]!, R.re[at]!) * 180) / Math.PI } : {}),
      f2: R.f2[at]!,
      ...(R.cls[at] === 0 ? { rank_by_f2: rank, percent_of_strongest: strongest > 0 ? (100 * R.f2[at]!) / strongest : 0 } : {}),
      family: { representative: [R.familyRep[3 * fam]!, R.familyRep[3 * fam + 1]!, R.familyRep[3 * fam + 2]!], multiplicity: members.length, members: members.slice(0, 48), friedel_merged: r.friedelMerged },
      radiation: radiationLabel(r),
    };
  },
});
