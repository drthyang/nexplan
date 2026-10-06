import { describe, expect, it } from "vitest";
import { difcFromGeometry, tofPeaks } from "../diffraction/tof.ts";
import type { DetectorPanel } from "./detectors.ts";
import { focusCells, focusedBank, focusedPeaks, focusedTofBank, recordsD } from "./focus.ts";

/** A w × h panel facing the sample at distance L, its centre at scattering angle 2θ in the horizontal plane. */
function facing(twoThetaDeg: number, L: number, w: number, h: number, name = "p"): DetectorPanel {
  const t = (twoThetaDeg * Math.PI) / 180;
  const u: [number, number, number] = [Math.sin(t), 0, Math.cos(t)];
  return { name, kind: "rectangular", center: [L * u[0], 0, L * u[2]], base: [Math.cos(t), 0, -Math.sin(t)], up: [0, 1, 0], width: w, height: h, nCols: 8, nRows: 8 };
}

const groups = [1.0, 1.5, 2.0, 3.0].map((d, k) => ({ d, sumF2: 10 + k, families: [{ hkl: [k + 1, 0, 0] }], multiplicity: 2 })) as never;

describe("focused-bank cells", () => {
  it("cell solid angles add up to the exact solid angle of a rectangle facing the sample", () => {
    const L = 2;
    const w = 0.8;
    const h = 0.5;
    const exact = 4 * Math.asin((w * h) / Math.sqrt((w * w + 4 * L * L) * (h * h + 4 * L * L)));
    const sum = focusCells([facing(90, L, w, h)], 16, 16).reduce((s, c) => s + c.omega, 0);
    expect(sum / exact).toBeCloseTo(1, 3);
  });

  it("a one-cell bank reproduces the single-bank TOF pattern (same Lorentz factor, DIFC and d range)", () => {
    const panel = facing(90, 1.5, 1e-4, 1e-4);
    const bank = focusedBank("b", [panel], 60, 0.5, 3, { nx: 1, ny: 1 });
    expect(bank.twoThetaDeg).toBeCloseTo(90, 9);
    expect(bank.difc).toBeCloseTo(difcFromGeometry(61.5, 90), 6);
    const single = tofPeaks(groups, { twoThetaDeg: 90, difc: bank.difc, difa: 0, zero: 0, lambdaMin: 0.5, lambdaMax: 3 });
    const focused = focusedPeaks(groups, bank, 0.5, 3);
    expect(focused.map((p) => p.d)).toEqual(single.map((p) => p.d));
    focused.forEach((p, i) => {
      expect(p.intensity).toBeCloseTo(single[i]!.intensity, 9);
      expect(p.tof).toBeCloseTo(single[i]!.tof!, 6);
    });
  });

  it("two panels: a line is in the pattern when either records it, with I = Σ|F|²·d⁴·sin θ_f whichever does", () => {
    // Small panels at 30° and 150°, the second twice the area (twice the solid angle at equal distance).
    const a = facing(30, 1, 0.01, 0.01, "a");
    const b = facing(150, 1, 0.02, 0.01, "b");
    const bank = focusedBank("ab", [a, b], 20, 0.5, 2.5, { nx: 1, ny: 1 });
    const sa = Math.sin((15 * Math.PI) / 180);
    const sb = Math.sin((75 * Math.PI) / 180);
    // d = 1.2 Å: λ = 0.62 Å at 30° and 2.32 Å at 150°, both in the band. d = 3 Å: λ = 1.55 Å at 30°, but 5.8 Å
    // at 150° (outside): only panel a. d = 6 Å: 3.1 Å at 30°, outside: neither.
    expect(recordsD(bank, 1.2, 0.5, 2.5)).toBe(true);
    expect(recordsD(bank, 3, 0.5, 2.5)).toBe(true);
    expect(recordsD(bank, 6, 0.5, 2.5)).toBe(false);
    const sf = Math.sin((bank.twoThetaDeg * Math.PI) / 360);
    const lines = [1.2, 3, 6].map((d, k) => ({ d, sumF2: 5 + k, families: [{ hkl: [k + 1, 0, 0] }], multiplicity: 2 })) as never;
    const peaks = focusedPeaks(lines, bank, 0.5, 2.5);
    expect(peaks.map((p) => p.d)).toEqual([1.2, 3]);
    peaks.forEach((p) => expect(p.intensity).toBeCloseTo(p.sumF2 * p.d ** 4 * sf, 9));
    // The bank records d from λmin/(2 sin 75°) to λmax/(2 sin 15°).
    expect(bank.dMin).toBeCloseTo(0.5 / (2 * sb), 9);
    expect(bank.dMax).toBeCloseTo(2.5 / (2 * sa), 9);
    // Effective 2θ: the solid-angle-weighted mean, unless given.
    expect(bank.twoThetaDeg).toBeCloseTo((30 + 2 * 150) / 3, 6);
    expect(focusedBank("ab", [a, b], 20, 0.5, 2.5, { nx: 1, ny: 1, twoThetaDeg: 90, l2: 1 }).difc).toBeCloseTo(difcFromGeometry(21, 90), 9);
  });

  it("matches focusing and vanadium normalisation done count by count, for any incident spectrum", () => {
    // Independent of the formula: each cell's line counts and its vanadium counts per unit d, from the incident
    // spectrum, summed over the cells (focusing) and divided. Cell c records a line at λ_c = 2d sin θ_c with
    // N_c ∝ φ(λ_c)·λ_c⁴·Ω_c·Σ|F|²/sin³θ_c (per unit solid angle, powderRings.ts); vanadium gives φ(λ)·Ω_c per unit λ,
    // i.e. φ(λ_c)·Ω_c·2 sin θ_c per unit d.
    const phi = (l: number) => l ** -4 * Math.exp(-((1.1 / l) ** 2)) + 0.3; // Maxwellian-like, arbitrary
    const bank = focusedBank("w", [facing(20, 1, 0.01, 0.01, "a"), facing(60, 1.3, 0.03, 0.02, "b"), facing(140, 0.8, 0.01, 0.04, "c")], 20, 0.3, 3, { nx: 1, ny: 1 });
    const lines = [0.6, 0.9, 1.4, 2.1, 3.5, 5].map((d, k) => ({ d, sumF2: 1 + k, families: [{ hkl: [k + 1, 0, 0] }], multiplicity: 2 })) as never;
    const normalised = (d: number, f2: number) => {
      let sample = 0;
      let vanadium = 0;
      for (const c of bank.cells) {
        const s = Math.sin((c.twoTheta * Math.PI) / 360);
        const l = 2 * d * s;
        if (l < 0.3 || l > 3) continue;
        sample += (phi(l) * l ** 4 * c.omega * f2) / s ** 3;
        vanadium += phi(l) * c.omega * 2 * s;
      }
      return sample / vanadium; // line area in d of the focused, normalised data
    };
    const peaks = focusedPeaks(lines, bank, 0.3, 3);
    expect(peaks.length).toBeGreaterThan(4);
    // On the focused TOF axis the area is DIFC_f times the area in d; DIFC_f ∝ sin θ_f, so I/(area in d) is constant.
    const ratios = peaks.map((p) => p.intensity / normalised(p.d, p.sumF2));
    for (const r of ratios) expect(r / ratios[0]!).toBeCloseTo(1, 12);
  });

  it("the drawing bank spans the focused d range on the focused DIFC", () => {
    const bank = focusedBank("b", [facing(60, 1.2, 0.3, 0.6), facing(80, 1.2, 0.3, 0.6)], 19.5, 0.1, 3);
    const tb = focusedTofBank(bank);
    const s = Math.sin((tb.twoThetaDeg * Math.PI) / 360);
    expect(tb.lambdaMin / (2 * s)).toBeCloseTo(bank.dMin, 12);
    expect(tb.lambdaMax / (2 * s)).toBeCloseTo(bank.dMax, 12);
    expect(tb.difc).toBe(bank.difc);
    // Ended early at a given d (never below the bank's d minimum).
    const short = focusedTofBank(bank, { dMax: 2 });
    expect(short.lambdaMax / (2 * s)).toBeCloseTo(Math.min(2, bank.dMax), 12);
    expect(focusedTofBank(bank, { dMax: 1e-3 }).lambdaMax / (2 * s)).toBeCloseTo(bank.dMin, 12);
  });
});
