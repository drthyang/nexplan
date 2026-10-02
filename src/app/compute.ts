/**
 * One calculation request → one serializable result. Pure: runs in the worker
 * and in tests. Every failure carries what the UI needs to let the user resolve
 * it (block choice, setting choice, species choice).
 */
import manifest from "../data/manifest.json";
import { classify, enumerateReflections, hasComplexAmplitudes, ReflectionLimitError, structureFactors } from "../core/diffraction/reflections.ts";
import { cwPeaks, familyRepresentative, groupByD, synthesizeProfile, type Polarization, type PowderAxis, type PowderPeak } from "../core/diffraction/powder.ts";
import { bankDRange, difcFromGeometry, synthesizeTof, tofPeaks, type TofBank, type TofShape } from "../core/diffraction/tof.ts";
import { parseTypeSymbol, speciesKey } from "../core/scattering/species.ts";
import { NEUTRON_DATASET, ScatteringLookupError, XRAY_DATASET, xrayIonsFor, type Tier } from "../core/scattering/tables.ts";
import { buildModel, cellContent, expandModel, ModelBuildError } from "../core/structure/model.ts";
import { formatSymOp } from "../core/symmetry/ops.ts";
import { CifStructureError, readCifStructure, summarizeBlocks, type CifBlockSummary, type Diagnostic } from "../io/cif/structure.ts";
import { CifSyntaxError } from "../io/cif/tokenizer.ts";

import { APP_VERSION } from "./version.ts";
export { APP_VERSION };

export interface CalcInput {
  readonly cifText: string;
  readonly fileName: string;
  readonly blockName?: string;
  readonly chosenSetting?: string;
  readonly speciesOverrides?: Readonly<Record<string, string>>;
  readonly radiation: "xray" | "neutron";
  readonly wavelength: number;
  readonly dMin: number;
  readonly polarization: Polarization;
  /**
   * X-ray only: site label → tabulated ion (e.g. "Fe3+") whose ionic f0 the user chose.
   * Every other site uses the neutral-atom f0, whatever charge its type symbol gives.
   */
  readonly xrayIons?: Readonly<Record<string, string>>;
  readonly profile: { readonly axis: PowderAxis; readonly fwhm: number; readonly eta: number };
  /** Neutron powder mode: constant wavelength or time-of-flight at one bank. */
  readonly neutronMode: "cw" | "tof";
  readonly tof: TofInput;
}

export interface TofInput {
  readonly twoThetaDeg: number;
  /** Total flight path L1 + L2 (m); DIFC is computed from it unless difcOverride is set. */
  readonly flightPathM: number;
  readonly difcOverride?: number;
  readonly difa: number;
  readonly zero: number;
  readonly lambdaMin: number;
  readonly lambdaMax: number;
  readonly shape: TofShape;
}

export interface SiteRow {
  readonly label: string;
  /** Element symbol (no charge, no isotope prefix). */
  readonly element: string;
  readonly species: string;
  readonly typeSymbol?: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly occupancy: number;
  readonly bIso: number;
  readonly multiplicity: number;
  readonly amplitudeSource: string;
  readonly tier: Tier;
  /** Charge from the CIF type symbol (0 when none). */
  readonly cifCharge: number;
  /** Waasmaier–Kirfel rows available for this element: the neutral atom first, then its ions. */
  readonly xrayOptions: readonly string[];
  /** The X-ray f0 row this site uses (neutral unless chosen otherwise). */
  readonly xrayFormFactor: string;
}

export interface CalcSuccess {
  readonly ok: true;
  readonly blocks: readonly CifBlockSummary[];
  readonly blockName: string;
  readonly structure: {
    readonly name: string;
    readonly formula?: string;
    readonly cell: { a: number; b: number; c: number; alpha: number; beta: number; gamma: number };
    readonly cellSu: Readonly<Record<string, number | undefined>>;
    readonly volume: number;
    readonly setting?: string;
    readonly settingNumber?: number;
    readonly hall?: string;
    readonly symmetrySource: string;
    readonly opCount: number;
    readonly ops: readonly string[];
    readonly sites: readonly SiteRow[];
    readonly content: readonly [string, number][];
    readonly codId?: string;
    readonly doi?: string;
    readonly temperatureK?: number;
  };
  readonly reflections: {
    readonly h: Int32Array;
    readonly k: Int32Array;
    readonly l: Int32Array;
    readonly d: Float64Array;
    readonly re: Float64Array;
    readonly im: Float64Array;
    readonly f2: Float64Array;
    /** 0 present, 1 systematic, 2 accidental. */
    readonly cls: Uint8Array;
    /** Index of each reflection's symmetry family (point-group orbit; Friedel mates merged only when amplitudes are real). */
    readonly family: Int32Array;
    /** Family representative h,k,l triples (lexicographically largest member), 3 entries per family. */
    readonly familyRep: Int32Array;
  };
  readonly friedelMerged: boolean;
  readonly peaks: readonly PowderPeak[];
  readonly profile: { readonly x: Float64Array; readonly y: Float64Array };
  /** "cw" or "tof"; TOF results carry the bank used. */
  readonly powderMode: "cw" | "tof";
  readonly bank?: TofBank;
  readonly tiers: readonly { readonly source: string; readonly tier: Tier }[];
  readonly diagnostics: readonly Diagnostic[];
  readonly provenance: Provenance;
}

export interface CalcFailure {
  readonly ok: false;
  readonly stage: "cif" | "block" | "symmetry" | "species" | "scattering" | "limit" | "input";
  readonly message: string;
  readonly blocks?: readonly CifBlockSummary[];
  readonly settingCandidates?: readonly string[];
  readonly ambiguousLabels?: readonly { label: string; candidates: readonly string[] }[];
  readonly suggestedDMin?: number;
  readonly diagnostics?: readonly Diagnostic[];
}

export type CalcResult = CalcSuccess | CalcFailure;

export interface Provenance {
  readonly app: string;
  readonly inputFile: string;
  readonly inputSha256: string;
  readonly block: string;
  readonly datasets: readonly { dataset: string; version: string; tier: string; sha256: string }[];
  readonly radiation: string;
  readonly wavelength: number;
  readonly dMin: number;
  readonly conventions: string;
  readonly settings: Omit<CalcInput, "cifText">;
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function runCalculation(input: CalcInput): Promise<CalcResult> {
  const isTof = input.radiation === "neutron" && input.neutronMode === "tof";
  if (!(input.dMin > 0)) return { ok: false, stage: "input", message: "d_min must be positive." };
  if (!isTof && !(input.wavelength > 0)) return { ok: false, stage: "input", message: "Wavelength must be positive." };
  if (isTof) {
    const t = input.tof;
    if (!(t.twoThetaDeg > 0 && t.twoThetaDeg < 180)) return { ok: false, stage: "input", message: "Bank 2θ must lie between 0° and 180°." };
    if (!(t.lambdaMin > 0 && t.lambdaMax > t.lambdaMin)) return { ok: false, stage: "input", message: "The wavelength band needs 0 < λmin < λmax." };
    if (!(t.difcOverride ?? t.flightPathM) || (t.difcOverride ?? t.flightPathM) <= 0) return { ok: false, stage: "input", message: "Flight path (or DIFC) must be positive." };
  }
  let blocks: CifBlockSummary[];
  try {
    blocks = summarizeBlocks(input.cifText);
  } catch (e) {
    return { ok: false, stage: "cif", message: (e as Error).message };
  }
  let cif;
  try {
    cif = readCifStructure(input.cifText, input.blockName);
  } catch (e) {
    if (e instanceof CifStructureError) {
      const needsBlock = /choose one/.test(e.message);
      return { ok: false, stage: needsBlock ? "block" : "cif", message: e.message, blocks, diagnostics: e.diagnostics };
    }
    if (e instanceof CifSyntaxError) return { ok: false, stage: "cif", message: e.message, blocks };
    throw e;
  }
  let model;
  try {
    model = buildModel(cif, {
      ...(input.chosenSetting ? { chosenSetting: input.chosenSetting } : {}),
      ...(input.speciesOverrides ? { speciesOverrides: input.speciesOverrides } : {}),
    });
  } catch (e) {
    if (e instanceof ModelBuildError) {
      return {
        ok: false,
        stage: e.ambiguousLabels.length ? "species" : "symmetry",
        message: e.message,
        blocks,
        settingCandidates: e.settingCandidates,
        ambiguousLabels: e.ambiguousLabels,
        diagnostics: e.diagnostics,
      };
    }
    return { ok: false, stage: "symmetry", message: (e as Error).message, blocks };
  }
  const expansion = expandModel(model);
  const diagnostics: Diagnostic[] = [...model.diagnostics, ...expansion.diagnostics];

  // X-ray form factors: neutral atoms unless the user picked a tabulated ion for a site.
  const xrayIons = input.xrayIons ?? {};
  const xrayChoice = new Map<string, string>();
  for (const site of model.sites) {
    const ion = xrayIons[site.label];
    if (ion === undefined) {
      xrayChoice.set(site.label, site.species.element);
      continue;
    }
    const parsed = parseTypeSymbol(ion);
    if (!parsed.ok || parsed.species.element !== site.species.element || !xrayIonsFor(site.species.element).includes(ion)) {
      return { ok: false, stage: "scattering", message: `'${ion}' is not a tabulated X-ray species for site ${site.label} (${site.species.element}).`, blocks };
    }
    xrayChoice.set(site.label, ion);
  }
  const xrayModel = {
    ...model,
    sites: model.sites.map((s) => {
      const parsed = parseTypeSymbol(xrayChoice.get(s.label)!);
      return { ...s, species: { ...s.species, charge: parsed.ok ? parsed.species.charge : 0 } };
    }),
  };
  if (input.radiation === "xray") {
    const charged = model.sites.filter((s) => s.species.charge !== 0 && xrayChoice.get(s.label) === s.species.element);
    if (charged.length) {
      diagnostics.push({
        severity: "info",
        message: `The type symbols give charges (${charged.map((s) => `${s.label} ${speciesKey(s.species)}`).join(", ")}); neutral-atom f0 are used. A site can be switched to a tabulated ion in the atom-site table.`,
      });
    }
    const ionic = model.sites.filter((s) => xrayChoice.get(s.label) !== s.species.element);
    if (ionic.length) diagnostics.push({ severity: "assumption", message: `Ionic X-ray f0 chosen for ${ionic.map((s) => `${s.label} (${xrayChoice.get(s.label)})`).join(", ")}.` });
  }

  // Never ask the X-ray table for s beyond its fitted domain.
  const dFloor = input.radiation === "xray" ? 1 / (2 * XRAY_DATASET.sMax) : 0;
  const dMin = Math.max(input.dMin, dFloor);
  if (dMin > input.dMin) diagnostics.push({ severity: "assumption", message: `d_min raised to ${dMin.toFixed(4)} Å, the Waasmaier–Kirfel limit s = 6 Å⁻¹.` });

  let refl;
  try {
    refl = enumerateReflections(model.cell, model.symmetry.ops, dMin, { maxCount: 400_000 });
  } catch (e) {
    if (e instanceof ReflectionLimitError) return { ok: false, stage: "limit", message: e.message, suggestedDMin: e.suggestedDMin, blocks, diagnostics };
    throw e;
  }

  let sf;
  try {
    sf = structureFactors(input.radiation === "xray" ? xrayModel : model, expansion, refl, input.radiation === "xray" ? { kind: "xray" } : { kind: "neutron" });
  } catch (e) {
    if (e instanceof ScatteringLookupError) return { ok: false, stage: "scattering", message: e.message, blocks, diagnostics };
    throw e;
  }
  for (const a of sf.amplitudes) for (const w of a.warnings) if (!diagnostics.some((d) => d.message === w)) diagnostics.push({ severity: "warning", message: w });

  const cls = new Uint8Array(refl.count);
  for (let i = 0; i < refl.count; i++) {
    const c = classify(refl, sf, i);
    cls[i] = c === "systematic" ? 1 : c === "accidental" ? 2 : 0;
  }
  const complex = hasComplexAmplitudes(sf, model);
  if (complex) diagnostics.push({ severity: "info", message: "Complex scattering amplitudes present: Friedel pairs are kept separate in the reflection list." });

  // Symmetry families for the folded reflection table.
  const familyIndex = new Map<string, number>();
  const familyRep: number[] = [];
  const family = new Int32Array(refl.count);
  for (let i = 0; i < refl.count; i++) {
    const rep = familyRepresentative(model.symmetry.ops, [refl.h[i]!, refl.k[i]!, refl.l[i]!], !complex);
    const key = rep.join(",");
    let id = familyIndex.get(key);
    if (id === undefined) {
      id = familyIndex.size;
      familyIndex.set(key, id);
      familyRep.push(...rep);
    }
    family[i] = id;
  }

  const polarization: Polarization = input.radiation === "neutron" ? { kind: "none" } : input.polarization;
  const groups = groupByD(refl, sf, model.symmetry.ops, { friedel: !complex });
  let peaks: PowderPeak[];
  let profile: { x: Float64Array; y: Float64Array };
  let bank: TofBank | undefined;
  if (isTof) {
    const t = input.tof;
    bank = {
      twoThetaDeg: t.twoThetaDeg,
      difc: t.difcOverride ?? difcFromGeometry(t.flightPathM, t.twoThetaDeg),
      difa: t.difa,
      zero: t.zero,
      lambdaMin: t.lambdaMin,
      lambdaMax: t.lambdaMax,
    };
    const bankDMin = bankDRange(bank).dMin;
    if (bankDMin < dMin) diagnostics.push({ severity: "warning", message: `The bank reaches d = ${bankDMin.toFixed(4)} Å, below d_min = ${dMin} Å; peaks below d_min are not calculated.` });
    peaks = tofPeaks(groups, bank);
    const axis = input.profile.axis === "tof" || input.profile.axis === "d" || input.profile.axis === "q" ? input.profile.axis : "tof";
    profile = synthesizeTof(peaks, bank, t.shape, axis);
    const resonant = sf.amplitudes.filter((a) => a.at(0).im !== 0).map((a) => a.source);
    if (resonant.length) {
      diagnostics.push({
        severity: "warning",
        message: `TOF covers λ = ${t.lambdaMin}–${t.lambdaMax} Å, but the complex b of ${resonant.join(", ")} is tabulated for 2200 m/s (1.798 Å) only; resonant scattering lengths vary with energy, so these intensities are approximate.`,
      });
    }
  } else {
    peaks = cwPeaks(groups, { wavelength: input.wavelength, lorentz: true, polarization });
    const axis = input.profile.axis === "tof" ? "twoTheta" : input.profile.axis;
    profile = synthesizeCw(peaks, axis, input.profile);
  }


  const tiers = new Map<string, Tier>();
  model.sites.forEach((_, j) => tiers.set(sf.amplitudes[j]!.source, sf.amplitudes[j]!.tier));
  const cellSu = { a: cif.cell.a.su, b: cif.cell.b.su, c: cif.cell.c.su, alpha: cif.cell.alpha.su, beta: cif.cell.beta.su, gamma: cif.cell.gamma.su };
  const { cifText, ...settings } = input;
  const ds = input.radiation === "xray" ? XRAY_DATASET : NEUTRON_DATASET;
  return {
    ok: true,
    blocks,
    blockName: cif.blockName,
    structure: {
      name: model.name,
      ...(cif.formula ? { formula: cif.formula } : {}),
      cell: model.cell,
      cellSu,
      volume: model.volume,
      ...(model.symmetry.setting ? { setting: model.symmetry.setting.xhm, settingNumber: model.symmetry.setting.number, hall: model.symmetry.setting.hall } : {}),
      symmetrySource: model.symmetry.source,
      opCount: model.symmetry.ops.length,
      ops: model.symmetry.ops.map(formatSymOp),
      sites: model.sites.map((s, j) => ({
        label: s.label,
        element: s.species.element,
        species: speciesKey(s.species),
        ...(s.typeSymbol ? { typeSymbol: s.typeSymbol } : {}),
        x: s.fract[0],
        y: s.fract[1],
        z: s.fract[2],
        occupancy: s.occupancy,
        bIso: s.bIso,
        multiplicity: expansion.multiplicities[j]!,
        amplitudeSource: sf.amplitudes[j]!.source,
        tier: sf.amplitudes[j]!.tier,
        cifCharge: s.species.charge,
        xrayOptions: xrayIonsFor(s.species.element).sort((a, b) => (a === s.species.element ? -1 : b === s.species.element ? 1 : a.localeCompare(b))),
        xrayFormFactor: xrayChoice.get(s.label)!,
      })),
      content: [...cellContent(model, expansion)],
      ...(cif.codId ? { codId: cif.codId } : {}),
      ...(cif.doi ? { doi: cif.doi } : {}),
      ...(cif.temperatureK ? { temperatureK: cif.temperatureK.value } : {}),
    },
    reflections: { h: refl.h, k: refl.k, l: refl.l, d: refl.d, re: sf.re, im: sf.im, f2: sf.f2, cls, family, familyRep: Int32Array.from(familyRep) },
    friedelMerged: !complex,
    peaks,
    profile,
    powderMode: isTof ? "tof" : "cw",
    ...(bank ? { bank } : {}),
    tiers: [...tiers].map(([source, tier]) => ({ source, tier })),
    diagnostics,
    provenance: {
      app: `ScatterPlan ${APP_VERSION}`,
      inputFile: input.fileName,
      inputSha256: await sha256Hex(cifText),
      block: cif.blockName,
      datasets: manifest.datasets
        .filter((d) => d.dataset === ds.id)
        .map((d) => ({ dataset: d.dataset, version: d.version, tier: d.tier, sha256: d.sha256 })),
      radiation: input.radiation === "xray" ? `X-ray, non-resonant f0 (${ds.citation})` : `Neutron ${isTof ? "TOF" : "CW"}, nuclear coherent b (${ds.citation})`,
      wavelength: input.wavelength,
      dMin,
      conventions: isTof
        ? "F = Σ o·a(s)·exp(−B s²)·exp(+2πi h·x); s = 1/(2d); neutron a = conj(b_Sears); Q = 2π/d; TOF t = ZERO + DIFC·d + DIFA·d², DIFC = (m_n/h)·L·2sinθ; TOF Lorentz sinθ·d⁴ (spectrum-normalized). docs/CONVENTIONS.md"
        : "F = Σ o·a(s)·exp(−B s²)·exp(+2πi h·x); s = 1/(2d); neutron a = conj(b_Sears); Q = 2π/d; CW powder L = 1/(sin²θ cosθ). docs/CONVENTIONS.md",
      settings,
    },
  };
}

/** CW profile on a uniform grid spanning the peaks (2θ capped at 180°). */
function synthesizeCw(peaks: readonly PowderPeak[], axis: "twoTheta" | "d" | "q", p: { fwhm: number; eta: number }) {
  if (!peaks.length) return { x: new Float64Array(), y: new Float64Array() };
  const positions = peaks.map((k) => (axis === "twoTheta" ? k.twoTheta! : axis === "d" ? k.d : k.q));
  const pad = 5 * p.fwhm;
  const lo = Math.max(0, Math.min(...positions) - pad);
  const hi = axis === "twoTheta" ? Math.min(180, Math.max(...positions) + pad) : Math.max(...positions) + pad;
  const step = Math.max(p.fwhm / 12, (hi - lo) / 60000);
  return synthesizeProfile(peaks, axis, { min: lo, max: hi, step }, { fwhm: p.fwhm, eta: p.eta });
}
