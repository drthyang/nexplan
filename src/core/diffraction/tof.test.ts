import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readCifStructure } from "../../io/cif/structure.ts";
import { buildModel, expandModel } from "../structure/model.ts";
import { cwPeaks, groupByD } from "./powder.ts";
import { enumerateReflections, structureFactors } from "./reflections.ts";
import { bankDRange, dFromTof, difcFromGeometry, NEUTRON_MASS_OVER_H, synthesizeTof, tofFromD, tofFromWavelength, tofLorentz, tofPeaks, trapezoid, type TofBank, type TofShape } from "./tof.ts";

describe("TOF conversion", () => {
  it("flight time from wavelength agrees with DIFC·d when λ = 2d sinθ", () => {
    for (const [L, tt, d] of [
      [18.457, 52.3, 1.98],
      [20, 90, 1],
      [63.2, 150, 0.6],
    ] as const) {
      const lambda = 2 * d * Math.sin((tt * Math.PI) / 360);
      expect(tofFromWavelength(L, lambda)).toBeCloseTo(tofFromD({ difc: difcFromGeometry(L, tt), difa: 0, zero: 0 }, d), 9);
    }
    // 1 Å over 10 m takes 2527.78 µs (v = h/(m_n·λ) = 3956 m/s).
    expect(tofFromWavelength(10, 1)).toBeCloseTo(2527.78, 2);
  });

  it("m_n/h agrees with Mantid's constant (CODATA 2006) to 1e-8", () => {
    const mantid = (1.674927211e-27 * 1e6) / (6.62606896e-34 * 1e10); // Mantid Unit.cpp NEUTRON_MASS_OVER_H
    expect(Math.abs(NEUTRON_MASS_OVER_H / mantid - 1)).toBeLessThan(1e-8);
    expect(NEUTRON_MASS_OVER_H).toBeCloseTo(252.7784, 4);
  });

  it("DIFC = (m_n/h)·L·2 sinθ; t = λ·L·(m_n/h) for an elastic neutron", () => {
    const difc = difcFromGeometry(20, 90);
    expect(difc).toBeCloseTo(252.77841316545678 * 20 * 2 * Math.SQRT1_2, 9);
    // de Broglie: a 1.798 Å neutron (2200 m/s) takes L/v to fly 20 m.
    const d = 1.798 / (2 * Math.SQRT1_2);
    const v = 6.62607015e-34 / (1.67492749804e-27 * 1.798e-10);
    expect(tofFromD({ difc, difa: 0, zero: 0 }, d)).toBeCloseTo((20 / v) * 1e6, 6);
  });

  it("dFromTof inverts tofFromD, with DIFA and ZERO", () => {
    for (const bank of [
      { difc: 7149.6, difa: 0, zero: 0 },
      { difc: 22585.3, difa: -6.2, zero: 4.1 },
      { difc: 3200, difa: 1.5, zero: -12 },
    ]) {
      for (const d of [0.3, 0.9, 2.5, 7]) expect(Math.abs(dFromTof(bank, tofFromD(bank, d)) - d) / d).toBeLessThan(1e-13);
    }
  });

  it("uses the GSAS-II TOF Lorentz factor sinθ·d⁴", () => {
    expect(tofLorentz(90, 2)).toBeCloseTo(Math.SQRT1_2 * 16, 12);
  });
});

describe("TOF powder pattern", () => {
  const cif = readFileSync(new URL("../../../fixtures/cif/cod-9001364.cif", import.meta.url), "utf8");
  const model = buildModel(readCifStructure(cif));
  const refl = enumerateReflections(model.cell, model.symmetry.ops, 0.4);
  const sf = structureFactors(model, expandModel(model), refl, { kind: "neutron" });
  const groups = groupByD(refl, sf, model.symmetry.ops, { friedel: true });
  const bank: TofBank = { twoThetaDeg: 90, difc: difcFromGeometry(20, 90), difa: 0, zero: 0, lambdaMin: 0.6, lambdaMax: 3.5 };

  it("keeps exactly the reflections inside the bank's wavelength band", () => {
    const peaks = tofPeaks(groups, bank);
    const { dMin, dMax } = bankDRange(bank);
    expect(peaks.length).toBe(groups.filter((g) => g.d >= dMin && g.d <= dMax).length);
    for (const p of peaks) {
      expect(p.lambda).toBeGreaterThanOrEqual(bank.lambdaMin - 1e-12);
      expect(p.lambda).toBeLessThanOrEqual(bank.lambdaMax + 1e-12);
      expect(p.intensity).toBeCloseTo(p.sumF2 * Math.SQRT1_2 * p.d ** 4, 8);
      expect(p.twoTheta).toBeUndefined();
    }
  });

  it("same Σ|F|² as CW for every peak; only the correction factor differs", () => {
    const cw = new Map(cwPeaks(groups, { wavelength: 0.5, lorentz: true, polarization: { kind: "none" } }).map((p) => [p.d, p.sumF2]));
    for (const p of tofPeaks(groups, bank)) if (cw.has(p.d)) expect(p.sumF2).toBe(cw.get(p.d));
  });

  const shapes: TofShape[] = [
    { kind: "gaussian", dOverD: 0.003 },
    // Typical GSAS-II back-to-back values for a ~20 m, 90° bank (µs units).
    { kind: "backToBack", alpha1: 1.0, beta0: 0.03, beta1: 0.007, sig0: 0, sig1: 60, sig2: 0 },
  ];

  for (const shape of shapes) {
    it(`profile area equals Σ intensity on TOF, d and Q axes (${shape.kind})`, () => {
      const peaks = tofPeaks(groups, bank);
      const expected = peaks.reduce((s, p) => s + p.intensity, 0);
      for (const axis of ["tof", "d", "q"] as const) {
        const { x, y } = synthesizeTof(peaks, bank, shape, axis);
        expect(Math.abs(trapezoid(x, y) - expected) / expected, axis).toBeLessThan(2e-3);
        for (let i = 1; i < x.length; i++) expect(x[i]!).toBeGreaterThan(x[i - 1]!);
      }
    });
  }

  it("the strongest profile maximum sits at the strongest peak's position", () => {
    const peaks = tofPeaks(groups, bank);
    const { x, y } = synthesizeTof(peaks, bank, { kind: "gaussian", dOverD: 0.001 }, "d");
    let iMax = 0;
    for (let i = 1; i < y.length; i++) if (y[i]! > y[iMax]!) iMax = i;
    const strongest = peaks.reduce((a, b) => (b.intensity / b.d > a.intensity / a.d ? b : a));
    expect(Math.abs(x[iMax]! - strongest.d) / strongest.d).toBeLessThan(5e-4);
  });
});
