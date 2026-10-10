/**
 * The agent session's state: the structures loaded so far (by id) and their recent calculations. Each tool call
 * names the structure it works on; a calculation runs once per structure and settings, then comes from the cache.
 */
import { runCalculation, type CalcInput, type CalcResult, type CalcSuccess, type TofInput } from "../app/compute.ts";
import type { Polarization, PowderAxis } from "../core/diffraction/powder.ts";
import type { AcceptanceArgs } from "./shared.ts";
import { ToolError } from "./tool.ts";

/** Defaults of the web app's bar: neutrons, λ = 1.5 Å, d_min = 0.8 Å. */
export const DEFAULT_D_MIN = 0.8;
export const DEFAULT_WAVELENGTH = 1.5;
export const DEFAULT_TOF: TofInput = { twoThetaDeg: 90, flightPathM: 20, difa: 0, zero: 0, lambdaMin: 0.5, lambdaMax: 3.5, shape: { kind: "gaussian", dOverD: 0.003 } };

/** Choices that resolve an ambiguous CIF: the data block, the space-group setting, species per site label, X-ray ions. */
export interface StructureChoices {
  readonly blockName?: string;
  readonly chosenSetting?: string;
  readonly speciesOverrides?: Readonly<Record<string, string>>;
  readonly xrayIons?: Readonly<Record<string, string>>;
}

export interface LoadedStructure {
  readonly id: string;
  readonly fileName: string;
  readonly cifText: string;
  /** Where the text came from: a path, a bundled structure, or text given inline. */
  readonly source: string;
  readonly choices: StructureChoices;
  /** Bumped when the text or the choices change, so cached calculations of the old version are not reused. */
  readonly version: number;
}

/** What a calculation depends on besides the structure (compute.ts CalcInput without the CIF). */
export interface CalcParams {
  readonly radiation: "xray" | "neutron";
  readonly wavelength: number;
  readonly dMin: number;
  readonly polarization?: Polarization;
  readonly neutronMode?: "cw" | "tof";
  readonly tof?: TofInput;
  readonly profile?: { readonly axis: PowderAxis; readonly fwhm: number; readonly eta: number };
}

/** Lowercase letters, digits and dashes. */
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/\.cif$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "structure";

export class Workspace {
  private readonly structures = new Map<string, LoadedStructure>();
  private readonly cache = new Map<string, CalcSuccess>();
  private readonly cacheSize: number;
  /** Per structure, the notes already reported with it (load_structure), which later results do not repeat. */
  private readonly reported = new Map<string, ReadonlySet<string>>();
  /** Per instrument id, the goniometer limits, masks and shadows set with configure_instrument. */
  private readonly acceptances = new Map<string, AcceptanceArgs>();

  acceptance(instrument: string): AcceptanceArgs | undefined {
    return this.acceptances.get(instrument);
  }

  setAcceptance(instrument: string, a: AcceptanceArgs | undefined): void {
    if (a && Object.values(a).some((v) => v !== undefined)) this.acceptances.set(instrument, a);
    else this.acceptances.delete(instrument);
  }

  constructor(cacheSize = 6) {
    this.cacheSize = cacheSize;
  }

  list(): LoadedStructure[] {
    return [...this.structures.values()];
  }

  get(id: string): LoadedStructure {
    const s = this.structures.get(id);
    if (!s) {
      const ids = [...this.structures.keys()];
      throw new ToolError(ids.length ? `No structure '${id}'. Loaded: ${ids.join(", ")}.` : `No structure '${id}': none is loaded. Call load_structure first.`, { loaded: ids });
    }
    return s;
  }

  /**
   * Adds a structure under `preferredId` (made unique with -2, -3, …), or replaces the one there when it holds the
   * same text, so loading a file twice does not pile up copies.
   */
  add(s: { readonly fileName: string; readonly cifText: string; readonly source: string; readonly choices: StructureChoices }, preferredId: string): LoadedStructure {
    const base = slug(preferredId);
    let id = base;
    for (let k = 2; this.structures.has(id) && this.structures.get(id)!.cifText !== s.cifText; k++) id = `${base}-${k}`;
    const version = (this.structures.get(id)?.version ?? 0) + 1;
    const loaded: LoadedStructure = { ...s, id, version };
    this.structures.set(id, loaded);
    return loaded;
  }

  /** Forgets a structure (one whose CIF cannot be read at all). */
  remove(id: string): void {
    this.structures.delete(id);
  }

  /** Replaces a structure's choices (the text stays). */
  update(id: string, choices: StructureChoices): LoadedStructure {
    const s = this.get(id);
    const loaded: LoadedStructure = { ...s, choices, version: s.version + 1 };
    this.structures.set(id, loaded);
    return loaded;
  }

  /** The calculation's result, ok or not (a failure says what to choose: block, setting, species, d_min). */
  async run(s: LoadedStructure, p: CalcParams): Promise<CalcResult> {
    const input: CalcInput = {
      cifText: s.cifText,
      fileName: s.fileName,
      ...(s.choices.blockName ? { blockName: s.choices.blockName } : {}),
      ...(s.choices.chosenSetting ? { chosenSetting: s.choices.chosenSetting } : {}),
      ...(s.choices.speciesOverrides && Object.keys(s.choices.speciesOverrides).length ? { speciesOverrides: s.choices.speciesOverrides } : {}),
      ...(s.choices.xrayIons && Object.keys(s.choices.xrayIons).length ? { xrayIons: s.choices.xrayIons } : {}),
      radiation: p.radiation,
      wavelength: p.wavelength,
      dMin: p.dMin,
      polarization: p.polarization ?? { kind: "unpolarized" },
      profile: p.profile ?? { axis: "twoTheta", fwhm: 0.1, eta: 0.5 },
      neutronMode: p.neutronMode ?? "cw",
      tof: p.tof ?? DEFAULT_TOF,
    };
    const { cifText: _text, ...settings } = input;
    const key = `${s.id}#${s.version}|${JSON.stringify(settings)}`;
    const hit = this.cache.get(key);
    if (hit) {
      // Most recently used last.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const result = await runCalculation(input);
    if (result.ok) {
      this.cache.set(key, result);
      while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value!);
    }
    return result;
  }

  /** Records the notes reported with a structure, so that newNotes leaves them out. */
  markReported(id: string, r: CalcSuccess): void {
    this.reported.set(id, new Set(r.diagnostics.map((d) => d.message)));
  }

  /** The calculation's warnings and assumptions not yet reported for its structure (e.g. d_min raised, resonant b). */
  newNotes(id: string, r: CalcSuccess): string[] {
    const seen = this.reported.get(id);
    return r.diagnostics.filter((d) => d.severity !== "info" && !seen?.has(d.message)).map((d) => d.message);
  }

  /** The calculation for a structure id; a failure becomes a ToolError carrying what the caller must choose. */
  async calculate(id: string, p: CalcParams): Promise<CalcSuccess> {
    const result = await this.run(this.get(id), p);
    if (result.ok) return result;
    throw new ToolError(result.message, failureDetails(result));
  }
}

/** The parts of a failed calculation a caller can act on. */
export function failureDetails(r: Extract<CalcResult, { ok: false }>): Record<string, unknown> {
  return {
    stage: r.stage,
    ...(r.stage === "block" && r.blocks ? { blocks: r.blocks.filter((b) => b.hasStructure).map((b) => ({ name: b.name, ...(b.phaseName ? { phase: b.phaseName } : {}), ...(b.formula ? { formula: b.formula } : {}), ...(b.cellText ? { cell: b.cellText } : {}), sites: b.siteCount })) } : {}),
    ...(r.settingCandidates?.length ? { setting_candidates: r.settingCandidates } : {}),
    ...(r.ambiguousLabels?.length ? { ambiguous_species: r.ambiguousLabels.map((a) => ({ label: a.label, candidates: a.candidates })) } : {}),
    ...(r.suggestedDMin !== undefined ? { suggested_d_min: r.suggestedDMin } : {}),
    ...(r.diagnostics?.length ? { diagnostics: r.diagnostics.filter((d) => d.severity !== "info").map((d) => d.message) } : {}),
  };
}
