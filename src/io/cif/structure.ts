/**
 * Read a crystal structure from one CIF 1.1 data block. Nothing is inferred
 * silently: every default and every unsupported item becomes a diagnostic that
 * the UI shows and exports record.
 */
import { findLoop, getValue, parseCifBlocks, parseNumber, type CifBlock, type CifLoop, type CifValue, type NumberWithSu } from "./tokenizer.ts";

export type Severity = "error" | "warning" | "assumption" | "info";
export interface Diagnostic {
  readonly severity: Severity;
  readonly message: string;
  readonly line?: number;
}

export interface CifCell {
  readonly a: NumberWithSu;
  readonly b: NumberWithSu;
  readonly c: NumberWithSu;
  readonly alpha: NumberWithSu;
  readonly beta: NumberWithSu;
  readonly gamma: NumberWithSu;
}

export interface CifSite {
  readonly label: string;
  /** `_atom_site_type_symbol` as written (e.g. "Fe3+", "O2-", "D"), if present. */
  readonly typeSymbol?: string;
  readonly fract: readonly [NumberWithSu, NumberWithSu, NumberWithSu];
  readonly occupancy: NumberWithSu;
  readonly occupancyDefaulted: boolean;
  /** Isotropic B (Å²), converted from U when U was given. */
  readonly bIso: NumberWithSu;
  readonly adpSource: "Uiso" | "Biso" | "Ueq" | "default";
  readonly adpType?: string;
  readonly hasAniso: boolean;
  readonly multiplicity?: number;
  readonly line: number;
}

export interface CifSymmetryFields {
  readonly ops?: readonly string[];
  readonly hall?: string;
  readonly hm?: string;
  readonly number?: number;
}

export interface CifStructure {
  readonly blockName: string;
  readonly phaseName?: string;
  readonly formula?: string;
  readonly cell: CifCell;
  readonly symmetry: CifSymmetryFields;
  readonly sites: readonly CifSite[];
  readonly temperatureK?: NumberWithSu;
  readonly pressureKPa?: NumberWithSu;
  readonly codId?: string;
  readonly doi?: string;
  readonly diagnostics: readonly Diagnostic[];
}

export interface CifBlockSummary {
  readonly name: string;
  readonly line: number;
  readonly hasStructure: boolean;
  readonly phaseName?: string;
  readonly formula?: string;
  readonly cellText?: string;
  readonly symmetryText?: string;
  readonly siteCount: number;
}

const firstTag = (block: CifBlock, tags: readonly string[]): CifValue | undefined => {
  for (const t of tags) {
    const v = getValue(block, t);
    if (v) return v;
  }
  return undefined;
};
const textOf = (v: CifValue | undefined): string | undefined => (v && !v.special ? v.text.trim() : undefined);

const HM_TAGS = ["_space_group_name_h-m_alt", "_symmetry_space_group_name_h-m", "_space_group_name_h-m_full"];
const HALL_TAGS = ["_space_group_name_hall", "_symmetry_space_group_name_hall"];
const NUMBER_TAGS = ["_space_group_it_number", "_symmetry_int_tables_number"];
const OPS_TAGS = ["_space_group_symop_operation_xyz", "_symmetry_equiv_pos_as_xyz"];

function blockHasStructure(block: CifBlock): boolean {
  return !!findLoop(block, "_atom_site_fract_x");
}

export function summarizeBlocks(text: string): CifBlockSummary[] {
  return parseCifBlocks(text).map((b) => {
    const cellVals = ["_cell_length_a", "_cell_length_b", "_cell_length_c", "_cell_angle_alpha", "_cell_angle_beta", "_cell_angle_gamma"].map((t) => textOf(getValue(b, t)));
    const sites = findLoop(b, "_atom_site_fract_x");
    const phaseName = textOf(firstTag(b, ["_pd_phase_name", "_chemical_name_mineral", "_chemical_name_common", "_chemical_name_systematic"]));
    const formula = textOf(firstTag(b, ["_chemical_formula_sum", "_chemical_formula_structural"]));
    const hm = textOf(firstTag(b, HM_TAGS));
    return {
      name: b.name,
      line: b.line,
      hasStructure: blockHasStructure(b),
      ...(phaseName ? { phaseName } : {}),
      ...(formula ? { formula } : {}),
      ...(cellVals.every(Boolean) ? { cellText: cellVals.join(" ") } : {}),
      ...(hm ? { symmetryText: hm } : {}),
      siteCount: sites?.rows.length ?? 0,
    };
  });
}

export class CifStructureError extends Error {
  readonly diagnostics: readonly Diagnostic[];
  constructor(message: string, diagnostics: readonly Diagnostic[]) {
    super(message);
    this.diagnostics = diagnostics;
  }
}

/**
 * Read the structure in block `blockName`. When the file has exactly one block
 * with atom sites, `blockName` may be omitted; otherwise it is required.
 */
export function readCifStructure(text: string, blockName?: string): CifStructure {
  const blocks = parseCifBlocks(text);
  const candidates = blocks.filter(blockHasStructure);
  let block: CifBlock | undefined;
  if (blockName !== undefined) {
    block = blocks.find((b) => b.name === blockName);
    if (!block) throw new CifStructureError(`No data block named '${blockName}'`, []);
  } else if (candidates.length === 1) block = candidates[0];
  else if (candidates.length === 0) throw new CifStructureError("No data block contains atom sites (_atom_site_fract_x)", []);
  else throw new CifStructureError(`The file has ${candidates.length} structure blocks (${candidates.map((b) => b.name).join(", ")}); choose one.`, []);
  return readBlock(block!);
}

function readBlock(block: CifBlock): CifStructure {
  const diag: Diagnostic[] = [];
  const err = (message: string, line?: number) => diag.push({ severity: "error", message, ...(line ? { line } : {}) });

  // DDLm-only files (dotted names) are CIF 2 dictionaries in disguise.
  if ([...block.items.keys(), ...block.loops.flatMap((l) => l.tags)].some((t) => /^_(cell|atom_site|space_group(_symop)?)\./.test(t))) {
    throw new CifStructureError("This block uses DDLm (dotted) data names such as _cell.length_a; only CIF 1.1 names are supported.", []);
  }
  if (findLoop(block, "_atom_site_fract_x") === undefined && findLoop(block, "_atom_site_cartn_x")) {
    throw new CifStructureError("Atom sites are given only in Cartesian coordinates; fractional coordinates are required.", []);
  }

  const num = (tag: string, required: boolean): NumberWithSu | undefined => {
    const v = getValue(block, tag);
    const n = parseNumber(v);
    if (n === undefined && required) err(`Missing ${tag}`, v?.line ?? block.line);
    return n;
  };
  const a = num("_cell_length_a", true);
  const b = num("_cell_length_b", true);
  const c = num("_cell_length_c", true);
  const alpha = num("_cell_angle_alpha", true);
  const beta = num("_cell_angle_beta", true);
  const gamma = num("_cell_angle_gamma", true);
  if (diag.some((d) => d.severity === "error")) throw new CifStructureError("Incomplete unit cell", diag);
  for (const [name, v] of [["a", a], ["b", b], ["c", c]] as const) if (v!.value <= 0) err(`Cell length ${name} must be positive`);
  for (const [name, v] of [["alpha", alpha], ["beta", beta], ["gamma", gamma]] as const) if (v!.value <= 0 || v!.value >= 180) err(`Cell angle ${name} must lie in (0, 180)`);

  // Symmetry fields (resolved later against the space-group table).
  const opsLoop = OPS_TAGS.map((t) => [t, findLoop(block, t)] as const).find(([, l]) => l);
  let ops: string[] | undefined;
  if (opsLoop) {
    const [tag, loop] = opsLoop;
    const col = loop!.tags.indexOf(tag);
    ops = loop!.rows.map((r) => r[col]!.text);
  } else {
    const single = firstTag(block, OPS_TAGS);
    if (single && !single.special) ops = [single.text];
  }
  const numberText = textOf(firstTag(block, NUMBER_TAGS));
  const symmetry: CifSymmetryFields = {
    ...(ops ? { ops } : {}),
    ...(textOf(firstTag(block, HALL_TAGS)) ? { hall: textOf(firstTag(block, HALL_TAGS))! } : {}),
    ...(textOf(firstTag(block, HM_TAGS)) ? { hm: textOf(firstTag(block, HM_TAGS))! } : {}),
    ...(numberText && /^\d+$/.test(numberText) ? { number: Number(numberText) } : {}),
  };

  // Atom sites.
  const loop = findLoop(block, "_atom_site_fract_x")!;
  const col = (tag: string) => loop.tags.indexOf(tag);
  const iLabel = col("_atom_site_label");
  const iType = col("_atom_site_type_symbol");
  const iX = col("_atom_site_fract_x");
  const iY = col("_atom_site_fract_y");
  const iZ = col("_atom_site_fract_z");
  const iOcc = col("_atom_site_occupancy");
  const iU = col("_atom_site_u_iso_or_equiv");
  const iB = col("_atom_site_b_iso_or_equiv");
  const iAdp = loop.tags.includes("_atom_site_adp_type") ? col("_atom_site_adp_type") : col("_atom_site_thermal_displace_type");
  const iMult = loop.tags.includes("_atom_site_symmetry_multiplicity") ? col("_atom_site_symmetry_multiplicity") : col("_atom_site_site_symmetry_multiplicity");
  const iCalc = col("_atom_site_calc_flag");
  if (iLabel < 0 && iType < 0) err("Atom-site loop has neither _atom_site_label nor _atom_site_type_symbol", loop.line);
  if (iY < 0 || iZ < 0) err("Atom-site loop lacks _atom_site_fract_y or _atom_site_fract_z", loop.line);

  const anisoLoop = findLoop(block, "_atom_site_aniso_label");
  const anisoLabels = new Set(anisoLoop ? anisoLoop.rows.map((r) => r[anisoLoop.tags.indexOf("_atom_site_aniso_label")]!.text) : []);
  const ueq = anisoLoop ? equivalentIsotropicU(anisoLoop, { a: a!.value, b: b!.value, c: c!.value, alpha: alpha!.value, beta: beta!.value, gamma: gamma!.value }) : new Map<string, NumberWithSu>();

  const sites: CifSite[] = [];
  const labels = new Set<string>();
  let defaultedOcc = 0;
  let defaultedAdp = 0;
  for (const row of loop.rows) {
    const line = row[0]!.line;
    const label = iLabel >= 0 ? row[iLabel]!.text : row[iType]!.text;
    if (iCalc >= 0 && /^dum/i.test(row[iCalc]!.text)) {
      diag.push({ severity: "info", message: `Site ${label} is a dummy atom (calc_flag dum) and was skipped.`, line });
      continue;
    }
    if (labels.has(label)) err(`Duplicate atom-site label ${label}`, line);
    labels.add(label);
    let fract: [NumberWithSu, NumberWithSu, NumberWithSu];
    try {
      const xyz = [iX, iY, iZ].map((i) => parseNumber(row[i]));
      if (xyz.some((v) => v === undefined)) {
        err(`Site ${label} has a missing coordinate`, line);
        continue;
      }
      fract = xyz as [NumberWithSu, NumberWithSu, NumberWithSu];
    } catch (e) {
      err(`Site ${label}: ${(e as Error).message}`, line);
      continue;
    }
    const typeSymbol = iType >= 0 && !row[iType]!.special ? row[iType]!.text : undefined;

    let occupancy = iOcc >= 0 ? parseNumber(row[iOcc]) : undefined;
    const occupancyDefaulted = occupancy === undefined;
    if (occupancyDefaulted) {
      occupancy = { value: 1 };
      defaultedOcc++;
    } else if (occupancy!.value <= 0 || occupancy!.value > 1 + 1e-6) err(`Site ${label} occupancy ${occupancy!.value} is outside (0, 1]`, line);

    const u = iU >= 0 ? parseNumber(row[iU]) : undefined;
    const bv = iB >= 0 ? parseNumber(row[iB]) : undefined;
    let bIso: NumberWithSu;
    let adpSource: CifSite["adpSource"];
    const k = 8 * Math.PI * Math.PI;
    if (u) {
      bIso = { value: k * u.value, ...(u.su !== undefined ? { su: k * u.su } : {}) };
      adpSource = "Uiso";
    } else if (bv) {
      bIso = bv;
      adpSource = "Biso";
    } else if (ueq.has(label)) {
      bIso = { value: k * ueq.get(label)!.value };
      adpSource = "Ueq";
    } else {
      bIso = { value: 0 };
      adpSource = "default";
      defaultedAdp++;
    }
    if (bIso.value < 0) diag.push({ severity: "warning", message: `Site ${label} has a negative isotropic ADP (B = ${bIso.value.toFixed(3)} Å²).`, line });
    const adpType = iAdp >= 0 && !row[iAdp]!.special ? row[iAdp]!.text : undefined;
    const hasAniso = anisoLabels.has(label) || /^[UB]ani$/i.test(adpType ?? "");
    const multText = iMult >= 0 && !row[iMult]!.special ? row[iMult]!.text : undefined;
    sites.push({
      label,
      ...(typeSymbol ? { typeSymbol } : {}),
      fract,
      occupancy: occupancy!,
      occupancyDefaulted,
      bIso,
      adpSource,
      ...(adpType ? { adpType } : {}),
      hasAniso,
      ...(multText && /^\d+$/.test(multText) ? { multiplicity: Number(multText) } : {}),
      line,
    });
  }
  if (defaultedOcc) diag.push({ severity: "assumption", message: `${defaultedOcc} site(s) have no occupancy; 1 was assumed.` });
  if (defaultedAdp) diag.push({ severity: "assumption", message: `${defaultedAdp} site(s) have no isotropic ADP; B = 0 Å² was assumed.` });
  const anisoSites = sites.filter((s) => s.hasAniso);
  if (anisoSites.length) {
    diag.push({
      severity: "warning",
      message: `${anisoSites.length} site(s) have anisotropic ADPs (${anisoSites.slice(0, 6).map((s) => s.label).join(", ")}${anisoSites.length > 6 ? ", …" : ""}). This version uses the isotropic U_iso/U_eq value from the file; anisotropic Debye–Waller factors are not applied.`,
    });
    const fromUeq = anisoSites.filter((s) => s.adpSource === "Ueq");
    if (fromUeq.length) {
      diag.push({
        severity: "assumption",
        message: `U_eq = ⅓ Σ U^ij a*_i a*_j a_i·a_j (Fischer & Tillmanns 1988) computed from the anisotropic ADPs of ${fromUeq.map((s) => s.label).join(", ")}, which have no U_iso in the file.`,
      });
    }
    for (const s of anisoSites) if (s.adpSource === "default") err(`Site ${s.label} has anisotropic ADPs but no usable U_iso or U_ij; supply U_iso or remove the site.`, s.line);
  }
  if (sites.length === 0) err("No usable atom sites");
  if (diag.some((d) => d.severity === "error")) throw new CifStructureError("The structure block has errors", diag);

  const phaseName = textOf(firstTag(block, ["_pd_phase_name", "_chemical_name_mineral", "_chemical_name_common", "_chemical_name_systematic"]));
  const formula = textOf(firstTag(block, ["_chemical_formula_sum", "_chemical_formula_structural"]));
  const temperatureK = parseNumber(firstTag(block, ["_diffrn_ambient_temperature", "_cell_measurement_temperature"]));
  const pressureKPa = parseNumber(firstTag(block, ["_diffrn_ambient_pressure", "_cell_measurement_pressure"]));
  const codId = textOf(getValue(block, "_cod_database_code"));
  const doi = textOf(getValue(block, "_journal_paper_doi"));
  return {
    blockName: block.name,
    ...(phaseName ? { phaseName } : {}),
    ...(formula ? { formula } : {}),
    cell: { a: a!, b: b!, c: c!, alpha: alpha!, beta: beta!, gamma: gamma! },
    symmetry,
    sites,
    ...(temperatureK ? { temperatureK } : {}),
    ...(pressureKPa ? { pressureKPa } : {}),
    ...(codId ? { codId } : {}),
    ...(doi ? { doi } : {}),
    diagnostics: diag,
  };
}

const DEG = Math.PI / 180;

/**
 * U_eq = ⅓ Σ_ij U^ij a*_i a*_j (a_i · a_j) (Fischer & Tillmanns 1988, Acta Cryst. C44, 775),
 * from _atom_site_aniso_U_ij, _B_ij (U = B/8π²) or _beta_ij (U^ij = β_ij / (2π² a*_i a*_j)).
 */
export function equivalentIsotropicU(loop: CifLoop, cell: { a: number; b: number; c: number; alpha: number; beta: number; gamma: number }): Map<string, NumberWithSu> {
  const { a, b, c } = cell;
  const ca = Math.cos(cell.alpha * DEG), cb = Math.cos(cell.beta * DEG), cg = Math.cos(cell.gamma * DEG);
  const G = [
    [a * a, a * b * cg, a * c * cb],
    [a * b * cg, b * b, b * c * ca],
    [a * c * cb, b * c * ca, c * c],
  ];
  const det = G[0]![0]! * (G[1]![1]! * G[2]![2]! - G[1]![2]! * G[2]![1]!) - G[0]![1]! * (G[1]![0]! * G[2]![2]! - G[1]![2]! * G[2]![0]!) + G[0]![2]! * (G[1]![0]! * G[2]![1]! - G[1]![1]! * G[2]![0]!);
  const cof = (i: number, j: number) => {
    const r = [0, 1, 2].filter((x) => x !== i);
    const q = [0, 1, 2].filter((x) => x !== j);
    return G[r[0]!]![q[0]!]! * G[r[1]!]![q[1]!]! - G[r[0]!]![q[1]!]! * G[r[1]!]![q[0]!]!;
  };
  const astar = [0, 1, 2].map((i) => Math.sqrt(cof(i, i) / det));
  const pairs = ["11", "22", "33", "12", "13", "23"];
  const kind = loop.tags.includes("_atom_site_aniso_u_11") ? "u" : loop.tags.includes("_atom_site_aniso_b_11") ? "b" : loop.tags.includes("_atom_site_aniso_beta_11") ? "beta" : undefined;
  const out = new Map<string, NumberWithSu>();
  if (!kind) return out;
  const iLabel = loop.tags.indexOf("_atom_site_aniso_label");
  for (const row of loop.rows) {
    const vals = pairs.map((p) => parseNumber(row[loop.tags.indexOf(`_atom_site_aniso_${kind}_${p}`)]));
    if (vals.some((v) => v === undefined)) continue;
    const U = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    pairs.forEach((p, n) => {
      const i = Number(p[0]) - 1, j = Number(p[1]) - 1;
      let v = vals[n]!.value;
      if (kind === "b") v /= 8 * Math.PI * Math.PI;
      if (kind === "beta") v /= 2 * Math.PI * Math.PI * astar[i]! * astar[j]!;
      U[i]![j] = v;
      U[j]![i] = v;
    });
    let s = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s += U[i]![j]! * astar[i]! * astar[j]! * G[i]![j]!;
    out.set(row[iLabel]!.text, { value: s / 3 });
  }
  return out;
}
