/**
 * One calculation request → one serializable result. Pure: runs in the worker
 * and in tests. Every failure carries what the UI needs to let the user resolve
 * it (block choice, setting choice, species choice).
 */
import manifest from "../data/manifest.json";
import { classify, enumerateReflections, hasComplexAmplitudes, ReflectionLimitError, structureFactors } from "../core/diffraction/reflections.ts";
import { powderPeaks, synthesizeProfile, type Polarization, type PowderAxis, type PowderPeak } from "../core/diffraction/powder.ts";
import { speciesKey } from "../core/scattering/species.ts";
import { NEUTRON_DATASET, ScatteringLookupError, XRAY_DATASET, type Tier } from "../core/scattering/tables.ts";
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
  readonly ionFallback: "error" | "neutral";
  readonly profile: { readonly axis: PowderAxis; readonly fwhm: number; readonly eta: number };
}

export interface SiteRow {
  readonly label: string;
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
  };
  readonly friedelMerged: boolean;
  readonly peaks: readonly PowderPeak[];
  readonly profile: { readonly x: Float64Array; readonly y: Float64Array };
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
  if (!(input.wavelength > 0) || !(input.dMin > 0)) return { ok: false, stage: "input", message: "Wavelength and d_min must be positive." };
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
    sf = structureFactors(model, expansion, refl, input.radiation === "xray" ? { kind: "xray", ionFallback: input.ionFallback } : { kind: "neutron" });
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

  const polarization: Polarization = input.radiation === "neutron" ? { kind: "none" } : input.polarization;
  const peaks = powderPeaks(refl, sf, model.symmetry.ops, { wavelength: input.wavelength, lorentz: true, polarization }, { friedel: !complex });
  const axis = input.profile.axis;
  const positions = peaks.map((p) => (axis === "twoTheta" ? p.twoTheta : axis === "d" ? p.d : p.q));
  const lo = positions.length ? Math.min(...positions) : 0;
  const hi = positions.length ? Math.max(...positions) : 1;
  const pad = 5 * input.profile.fwhm;
  const span = { min: Math.max(0, lo - pad), max: axis === "twoTheta" ? Math.min(180, hi + pad) : hi + pad };
  const step = Math.max(input.profile.fwhm / 12, (span.max - span.min) / 60000);
  const profile = peaks.length ? synthesizeProfile(peaks, axis, { ...span, step }, { fwhm: input.profile.fwhm, eta: input.profile.eta }) : { x: new Float64Array(), y: new Float64Array() };

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
      })),
      content: [...cellContent(model, expansion)],
      ...(cif.codId ? { codId: cif.codId } : {}),
      ...(cif.doi ? { doi: cif.doi } : {}),
      ...(cif.temperatureK ? { temperatureK: cif.temperatureK.value } : {}),
    },
    reflections: { h: refl.h, k: refl.k, l: refl.l, d: refl.d, re: sf.re, im: sf.im, f2: sf.f2, cls },
    friedelMerged: !complex,
    peaks,
    profile,
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
      radiation: input.radiation === "xray" ? `X-ray, non-resonant f0 (${ds.citation})` : `Neutron, nuclear coherent b (${ds.citation})`,
      wavelength: input.wavelength,
      dMin,
      conventions: "F = Σ o·a(s)·exp(−B s²)·exp(+2πi h·x); s = 1/(2d); neutron a = conj(b_Sears); Q = 2π/d; CW powder L = 1/(sin²θ cosθ). docs/CONVENTIONS.md",
      settings,
    },
  };
}
