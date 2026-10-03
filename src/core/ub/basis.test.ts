import { describe, expect, it } from "vitest";
import type { Vec3 } from "@materia/core/math/types";
import { determinant, mulVec, transpose } from "@materia/core/math/mat3";
import { BASIS_PRESETS, parseRatio, ratioText, supercell } from "./basis.ts";
import { latticeFromUB, transformUB, ubFromU } from "./ub.ts";

const I: [Vec3, Vec3, Vec3] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const preset = (id: string) => BASIS_PRESETS.find((p) => p.id === id)!.P;

describe("change of basis presets (ITA Vol. A Table 5.1.3.1)", () => {
  it("F-centred cubic → primitive rhombohedral cell: a/√2, 60°, volume ×1/4", () => {
    const UB = ubFromU(I, { a: 4, b: 4, c: 4, alpha: 90, beta: 90, gamma: 90 });
    const l = latticeFromUB(transformUB(UB, preset("F-P")));
    for (const x of [l.a, l.b, l.c]) expect(x).toBeCloseTo(4 / Math.SQRT2, 9);
    for (const x of [l.alpha, l.beta, l.gamma]) expect(x).toBeCloseTo(60, 9);
    expect(determinant(preset("F-P"))).toBeCloseTo(0.25, 12);
    // F-allowed (all even or all odd) indices stay integers: h′ = Pᵀh.
    const hp = mulVec(transpose(preset("F-P")), [1, 1, 1]);
    for (const x of hp) expect(Number.isInteger(Math.round(x * 1e9) / 1e9)).toBe(true);
  });

  it("I-centred cubic → primitive: √3a/2, 109.47°, volume ×1/2", () => {
    const UB = ubFromU(I, { a: 4, b: 4, c: 4, alpha: 90, beta: 90, gamma: 90 });
    const l = latticeFromUB(transformUB(UB, preset("I-P")));
    for (const x of [l.a, l.b, l.c]) expect(x).toBeCloseTo((Math.sqrt(3) * 4) / 2, 9);
    for (const x of [l.alpha, l.beta, l.gamma]) expect(x).toBeCloseTo((Math.acos(-1 / 3) * 180) / Math.PI, 9);
    expect(determinant(preset("I-P"))).toBeCloseTo(0.5, 12);
  });

  it("C-centred → primitive halves the volume; hexagonal R (obverse) → rhombohedral gives the textbook a_r and α_r", () => {
    expect(determinant(preset("C-P"))).toBeCloseTo(0.5, 12);
    const a = 4.9134;
    const c = 13.6;
    const UB = ubFromU(I, { a, b: a, c, alpha: 90, beta: 90, gamma: 120 });
    const l = latticeFromUB(transformUB(UB, preset("R-hex-rh")));
    const ar = Math.sqrt(3 * a * a + c * c) / 3;
    const alpha = (Math.acos((2 * c * c - 3 * a * a) / (2 * c * c + 6 * a * a)) * 180) / Math.PI;
    for (const x of [l.a, l.b, l.c]) expect(x).toBeCloseTo(ar, 9);
    for (const x of [l.alpha, l.beta, l.gamma]) expect(x).toBeCloseTo(alpha, 9);
    expect(determinant(preset("R-hex-rh"))).toBeCloseTo(1 / 3, 12);
  });

  it("any supercell: na × nb × nc multiplies the axes and the volume", () => {
    const UB = ubFromU(I, { a: 3, b: 4, c: 5, alpha: 90, beta: 100, gamma: 90 });
    const l = latticeFromUB(transformUB(UB, supercell(3, 1, 4)));
    expect([l.a, l.b, l.c].map((x) => Number(x.toFixed(9)))).toEqual([9, 4, 20]);
    expect(l.beta).toBeCloseTo(100, 9);
    expect(determinant(supercell(3, 1, 4))).toBe(12);
  });
});

describe("P entries as fractions", () => {
  it("parses integers, decimals and fractions, and rejects partial input", () => {
    expect(parseRatio("2")).toBe(2);
    expect(parseRatio("-1")).toBe(-1);
    expect(parseRatio("0.5")).toBe(0.5);
    expect(parseRatio(".5")).toBe(0.5);
    expect(parseRatio("1/2")).toBe(0.5);
    expect(parseRatio("−1/3")).toBeCloseTo(-1 / 3, 15);
    expect(parseRatio(" 2 / 3 ")).toBeCloseTo(2 / 3, 15);
    for (const bad of ["", "-", "1/", "/2", "1/0", "a", "1/2/3"]) expect(parseRatio(bad)).toBeUndefined();
  });

  it("shows simple fractions as fractions", () => {
    expect(ratioText(0.5)).toBe("1/2");
    expect(ratioText(-1 / 3)).toBe("-1/3");
    expect(ratioText(2 / 3)).toBe("2/3");
    expect(ratioText(4)).toBe("4");
    expect(ratioText(0)).toBe("0");
    expect(ratioText(Math.SQRT2)).toBe("1.41421");
  });
});
