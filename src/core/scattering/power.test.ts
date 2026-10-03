import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readCifStructure } from "../../io/cif/structure.ts";
import { groupByD } from "../diffraction/powder.ts";
import { enumerateReflections, structureFactors } from "../diffraction/reflections.ts";
import { buildModel, expandModel } from "../structure/model.ts";
import { braggStrengths, braggSummary, LAMBDA_2200, scatteringPower } from "./power.ts";
import { neutronCrossSections } from "./tables.ts";

const si = { coh: 2.163, inc: 0.004, abs2200: 0.171 }; // Sears (1992), barn

describe("macroscopic cross-sections", () => {
  it("silicon: Σ = 8σ/a³ in cm⁻¹ (1 b/Å³ = 1 cm⁻¹)", () => {
    const a = 5.431;
    const p = scatteringPower([{ label: "Si", multiplicity: 8, occupancy: 1, xs: si }], a ** 3);
    expect(p.coh).toBeCloseTo((8 * 2.163) / a ** 3, 12);
    expect(p.inc).toBeCloseTo((8 * 0.004) / a ** 3, 12);
    expect(p.abs).toBeCloseTo((8 * 0.171) / a ** 3, 12);
    expect(p.coh).toBeCloseTo(0.108, 3);
    expect(p.density).toBeCloseTo(8 / a ** 3, 12);
    expect(p.attenuationLength).toBeCloseTo(1 / p.total, 12);
    expect(p.missing).toEqual([]);
  });

  it("absorption follows the 1/v law: σ_abs ∝ λ", () => {
    const p1 = scatteringPower([{ label: "Si", multiplicity: 8, occupancy: 1, xs: si }], 160, LAMBDA_2200);
    const p2 = scatteringPower([{ label: "Si", multiplicity: 8, occupancy: 1, xs: si }], 160, 2 * LAMBDA_2200);
    expect(p2.abs / p1.abs).toBeCloseTo(2, 12);
    expect(p2.coh).toBe(p1.coh);
  });

  it("hydrogen makes incoherent scattering dominate; occupancy weights each site; untabulated values are reported", () => {
    const H = neutronCrossSections({ element: "H" } as never);
    const D = neutronCrossSections({ element: "H", isotope: 2 } as never);
    expect(H.inc).toBeCloseTo(80.26, 2); // Sears 1992
    expect(D.inc).toBeLessThan(3);
    const p = scatteringPower(
      [
        { label: "H1", multiplicity: 4, occupancy: 0.5, xs: H },
        { label: "X", multiplicity: 2, occupancy: 1, xs: {} },
      ],
      100,
    );
    expect(p.inc).toBeCloseTo((2 * 80.26) / 100, 2);
    expect(p.inc / p.coh).toBeGreaterThan(40);
    expect(p.missing).toEqual(["X"]);
  });
});

describe("Bragg line strength j|F|²/v_c²", () => {
  it("Si (1 1 1): Σ|F|² = 8 signed members × 32 b² × Debye–Waller (diamond structure, neutrons)", () => {
    const cif = readFileSync(new URL("../../../fixtures/cif/cod-2104737.cif", import.meta.url), "utf8");
    const model = buildModel(readCifStructure(cif));
    const refl = enumerateReflections(model.cell, model.symmetry.ops, 0.8);
    const sf = structureFactors(model, expandModel(model), refl, { kind: "neutron" });
    const groups = groupByD(refl, sf, model.symmetry.ops, { friedel: true });
    const v = model.volume;
    const lines = braggStrengths(groups, v);
    const l111 = lines.find((l) => l.label.includes("(1 1 1)"))!;
    const b = 4.1491; // fm, Sears 1992
    const B = model.sites[0]!.bIso;
    const s = 1 / (2 * l111.d);
    expect(l111.sumF2).toBeCloseTo(8 * 32 * b * b * Math.exp(-2 * B * s * s), 6);
    expect(l111.strength).toBeCloseTo(l111.sumF2 / (v * v), 12);
    // (2 0 0) is forbidden in Fd-3m: no such line.
    expect(lines.some((l) => l.label.includes("(2 0 0)"))).toBe(false);
    const sum = braggSummary(lines, 1, 3.5);
    expect(sum.strongest).toBeDefined();
    expect(sum.sum).toBeCloseTo(lines.filter((l) => l.d >= 1 && l.d <= 3.5).reduce((t, l) => t + l.strength, 0), 15);
    // Unweighted, the high-multiplicity (4 2 2) line wins; with the TOF d⁴ factor
    // (1 1 1) is the strongest line, as in a measured silicon pattern.
    expect(sum.strongest!.label).toContain("(4 2 2)");
    const tof = braggSummary(lines, 1, 3.5, "tof");
    expect(tof.strongest!.label).toContain("(1 1 1)");
    expect(l111.tof).toBeCloseTo(l111.strength * l111.d ** 4, 12);
  });
});
