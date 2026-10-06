/**
 * Neutron scattering power of a material, per unit volume, for comparing a
 * sample with a reference (no instrument, flux or counting-time assumptions).
 *
 *  - Macroscopic cross-sections Σ = (1/v_c)·Σ_sites m·o·σ (coherent,
 *    incoherent, absorption), Sears (1992) values in barn. With v_c in Å³,
 *    1 b/Å³ = 10⁻²⁴ cm² / 10⁻²⁴ cm³ = 1 cm⁻¹. Absorption follows the 1/v law,
 *    σ_abs(λ) = σ_abs(2200 m/s)·λ/1.798 Å, except for resonant absorbers.
 *  - Bragg line strength j|F|²/v_c² (fm²/Å⁶): the sample-dependent factor of a
 *    line's integrated intensity per unit sample volume. Lorentz, flux and
 *    detector factors depend only on d (and the instrument), so at similar d
 *    the ratio of strengths is the ratio of line intensities for equal volumes.
 *  - TOF weighting j|F|²d⁴/v_c² (fm²/Å²): at a fixed detector angle the TOF
 *    Lorentz factor λ⁴/sin³θ = 16·d⁴·sinθ ∝ d⁴ (per unit solid angle, powderRings.ts), so ranking lines by it
 *    matches a measured TOF pattern apart from the source spectrum.
 */

/** λ (Å) of the Sears absorption cross-sections: 2200 m/s. */
export const LAMBDA_2200 = 1.798;

export interface PowerSite {
  readonly label: string;
  readonly multiplicity: number;
  readonly occupancy: number;
  readonly xs: { readonly coh?: number; readonly inc?: number; readonly abs2200?: number; readonly resonant?: boolean };
}

export interface ScatteringPower {
  /** Coherent, incoherent and absorption (at λ) macroscopic cross-sections, cm⁻¹. */
  readonly coh: number;
  readonly inc: number;
  readonly abs: number;
  /** Total attenuation coefficient Σ_coh + Σ_inc + Σ_abs (cm⁻¹) and its 1/e length (cm). */
  readonly total: number;
  readonly attenuationLength: number;
  /** Atoms per Å³ (number density). */
  readonly density: number;
  /** Site labels missing a tabulated cross-section (their contribution is left out). */
  readonly missing: readonly string[];
  /** Site labels with resonant absorbers, where the 1/v scaling of absorption does not hold. */
  readonly resonant: readonly string[];
}

export function scatteringPower(sites: readonly PowerSite[], cellVolume: number, lambda = LAMBDA_2200): ScatteringPower {
  let coh = 0;
  let inc = 0;
  let abs = 0;
  let atoms = 0;
  const missing: string[] = [];
  const resonant: string[] = [];
  for (const s of sites) {
    const n = s.multiplicity * s.occupancy;
    atoms += n;
    if (s.xs.coh === undefined || s.xs.inc === undefined || s.xs.abs2200 === undefined) missing.push(s.label);
    coh += n * (s.xs.coh ?? 0);
    inc += n * (s.xs.inc ?? 0);
    abs += n * (s.xs.abs2200 ?? 0) * (lambda / LAMBDA_2200);
    if (s.xs.resonant) resonant.push(s.label);
  }
  const k = 1 / cellVolume;
  const total = (coh + inc + abs) * k;
  return { coh: coh * k, inc: inc * k, abs: abs * k, total, attenuationLength: total > 0 ? 1 / total : Infinity, density: atoms * k, missing, resonant };
}

export interface BraggLine {
  readonly d: number;
  /** Σ|F|² over the line's signed hkl (= j|F|² summed over overlapping families), fm². */
  readonly sumF2: number;
  /** sumF2 / v_c², fm²/Å⁶. */
  readonly strength: number;
  /** strength · d⁴, fm²/Å²: TOF line strength at a fixed detector angle. */
  readonly tof: number;
  readonly label: string;
}

export function braggStrengths(groups: readonly { readonly d: number; readonly sumF2: number; readonly families: readonly { readonly hkl: readonly number[] }[] }[], cellVolume: number): BraggLine[] {
  const v2 = cellVolume * cellVolume;
  return groups.map((g) => ({ d: g.d, sumF2: g.sumF2, strength: g.sumF2 / v2, tof: (g.sumF2 / v2) * g.d ** 4, label: g.families.map((f) => `(${f.hkl.join(" ")})`).join(" + ") }));
}

export type BraggWeight = "strength" | "tof";

/** Strongest line and summed weight (plain or TOF) of the lines with dMin ≤ d ≤ dMax. */
export function braggSummary(lines: readonly BraggLine[], dMin: number, dMax: number, weight: BraggWeight = "strength"): { strongest?: BraggLine; sum: number; count: number } {
  let strongest: BraggLine | undefined;
  let sum = 0;
  let count = 0;
  for (const l of lines) {
    if (l.d < dMin || l.d > dMax) continue;
    sum += l[weight];
    count++;
    if (!strongest || l[weight] > strongest[weight]) strongest = l;
  }
  return { ...(strongest ? { strongest } : {}), sum, count };
}
