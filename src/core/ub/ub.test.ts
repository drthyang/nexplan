import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { determinant, inverse, mulMat, mulVec, transpose } from "@materia/core/math/mat3";
import { metricTensor } from "@materia/core/crystal/unitCell";
import { formatIsawUB, parseIsawUB } from "../../io/isaw.ts";
import { laueRotations } from "../symmetry/ops.ts";
import { findByHM, settingOps } from "../symmetry/spaceGroups.ts";
import { supercell } from "./basis.ts";
import { axisAngle, bMatrix, directBasisInSample, findBasisMatch, findCellMatches, latticeFromUB, nearestIndices, orientationFromUB, transformUB, ubFromU, type BasisMatch } from "./ub.ts";

/** Rotation about a unit axis by an angle (Rodrigues). */
function rot(axis: Vec3, deg: number): Mat3 {
  const n = Math.hypot(...axis);
  const [x, y, z] = [axis[0] / n, axis[1] / n, axis[2] / n];
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const C = 1 - c;
  return [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ];
}

const maxAbs = (A: Mat3, B: Mat3) => Math.max(...A.flatMap((r, i) => r.map((v, j) => Math.abs(v - B[i]![j]!))));
const tri = { a: 5.13, b: 7.42, c: 9.86, alpha: 71.3, beta: 104.7, gamma: 96.1 };

describe("Busing–Levy B and the UB split", () => {
  it("BᵀB is the reciprocal metric G*; B is upper triangular with a* along x", () => {
    for (const cell of [{ a: 5, b: 5, c: 5, alpha: 90, beta: 90, gamma: 90 }, { a: 4.9, b: 4.9, c: 5.4, alpha: 90, beta: 90, gamma: 120 }, tri]) {
      const B = bMatrix(cell);
      expect(maxAbs(mulMat(transpose(B), B), inverse(metricTensor(cell)))).toBeLessThan(1e-14);
      expect(B[1][0]).toBe(0);
      expect(B[2][0]).toBe(0);
      expect(B[2][1]).toBe(0);
      expect(B[2][2]).toBeCloseTo(1 / cell.c, 15);
    }
    expect(bMatrix({ a: 5, b: 5, c: 5, alpha: 90, beta: 90, gamma: 90 })[0][0]).toBeCloseTo(0.2, 15);
  });

  it("recovers lattice and U from UB = U·B for random orientations", () => {
    for (const [axis, deg] of [[[1, 2, 3], 37], [[-0.3, 0.2, 1], 211], [[0, 1, 0], 90]] as [Vec3, number][]) {
      const U = rot(axis, deg);
      const UB = ubFromU(U, tri);
      const o = orientationFromUB(UB);
      for (const k of ["a", "b", "c", "alpha", "beta", "gamma"] as const) expect(Math.abs(o.cell[k] - tri[k])).toBeLessThan(1e-11);
      expect(maxAbs(o.U, U)).toBeLessThan(1e-13);
      expect(o.orthogonalityError).toBeLessThan(1e-13);
      expect(o.detU).toBeCloseTo(1, 13);
      const aa = axisAngle(U);
      expect(aa.angleDeg).toBeCloseTo(deg > 180 ? 360 - deg : deg, 9);
    }
  });

  it("axis and angle of a rotation, 180° included (the axis up to its sign)", () => {
    for (const axis of [[0, 1, 1], [0, 1, -1], [1, -2, 0.5], [0, 0, 1], [-1, 1, 1]] as Vec3[]) {
      const n = Math.hypot(...axis);
      const unitAxis = axis.map((v) => v / n);
      for (const deg of [180, 179.9999999, 120]) {
        const aa = axisAngle(rot(axis, deg));
        expect(aa.angleDeg).toBeCloseTo(deg, 5);
        const cos = aa.axis.reduce((s, v, i) => s + v * unitAxis[i]!, 0);
        expect(deg === 120 ? cos : Math.abs(cos)).toBeCloseTo(1, 6);
      }
    }
  });

  it("basis change keeps the physical vector: UB′·(Pᵀh) = UB·h, and handles supercells", () => {
    const UB = ubFromU(rot([1, 1, 0.3], 23), tri);
    const P: Mat3 = [
      [1, 1, 0],
      [-1, 1, 0],
      [0, 0, 2],
    ]; // det 4: a′ = a − b, b′ = a + b, c′ = 2c
    const UB2 = transformUB(UB, P);
    for (const h of [[1, 0, 0], [2, -1, 3], [0, 0, 1]] as Vec3[]) {
      const q1 = mulVec(UB, h);
      const q2 = mulVec(UB2, mulVec(transpose(P), h));
      expect(Math.hypot(q1[0] - q2[0], q1[1] - q2[1], q1[2] - q2[2])).toBeLessThan(1e-14);
    }
    expect(latticeFromUB(UB2).volume / latticeFromUB(UB).volume).toBeCloseTo(4, 10);
    expect(() => transformUB(UB, [[1, 0, 0], [2, 0, 0], [0, 0, 1]])).toThrow(/singular/);
  });

  it("direct basis in the sample frame is (UB)⁻ᵀ: a·a* = 1, a·b* = 0", () => {
    const UB = ubFromU(rot([0.2, -1, 0.5], 64), tri);
    const A = directBasisInSample(UB);
    const prod = mulMat(transpose(A), UB);
    expect(maxAbs(prod, [[1, 0, 0], [0, 1, 0], [0, 0, 1]])).toBeLessThan(1e-13);
  });

  it("nearestIndices finds the low-index direction", () => {
    const UB = ubFromU(rot([0, 0, 1], 0), { a: 4, b: 4, c: 4, alpha: 90, beta: 90, gamma: 90 });
    expect(nearestIndices(UB, [1, 1, 0]).indices).toEqual([1, 1, 0]);
    expect(nearestIndices(UB, [0, 0, 3]).indices).toEqual([0, 0, 1]);
  });
});

describe("ISAW UB files (Mantid LoadIsawUB / SaveIsawUB layout)", () => {
  it("writes the transpose in IPNS column order and reads it back", () => {
    const UB = ubFromU(rot([0.4, 1, -0.2], 47), tri);
    const text = formatIsawUB(UB);
    const lines = text.split("\n");
    // Line 1 = (UB[z][0], UB[x][0], UB[y][0]) to 8 decimals, widths 11/12/12.
    expect(lines[0]).toBe(`${UB[2][0].toFixed(8).padStart(11)}${UB[0][0].toFixed(8).padStart(12)}${UB[1][0].toFixed(8).padStart(12)} `);
    const back = parseIsawUB(text);
    expect(maxAbs(back.UB, UB)).toBeLessThan(5e-9);
    expect(back.warnings).toEqual([]);
    expect(formatIsawUB(back.UB).split("\n").slice(0, 3)).toEqual(lines.slice(0, 3));
    expect(determinant(back.UB)).toBeGreaterThan(0);
  });

  it("rejects malformed files and warns about lattice mismatches", () => {
    expect(() => parseIsawUB("1 2 3\nnot a row\n")).toThrow(/three numbers/);
    const UB = ubFromU(rot([1, 0, 0], 10), tri);
    const tampered = formatIsawUB(UB).replace(/^(.*\n.*\n.*\n)\s*[\d.]+/, (_m, head: string) => `${head}    99.0000`);
    expect(parseIsawUB(tampered).warnings.join(" ")).toMatch(/differs/);
  });

  const local = "/Users/thyang/GitHub/web-refinement/data/absorption_vision/1p5K_UB_isaw.mat";
  it.skipIf(!existsSync(local))("reads a real ISAW file (local data, not committed)", () => {
    const f = parseIsawUB(readFileSync(local, "utf8"));
    const lat = latticeFromUB(f.UB);
    expect(Math.abs(lat.a - f.latticeLine![0]!)).toBeLessThan(1e-3);
    expect(Math.abs(lat.b - f.latticeLine![1]!)).toBeLessThan(1e-3);
    expect(Math.abs(lat.c - f.latticeLine![2]!)).toBeLessThan(1e-3);
    expect(Math.abs(lat.volume - f.latticeLine![6]!)).toBeLessThan(0.05);
    const o = orientationFromUB(f.UB);
    expect(o.orthogonalityError).toBeLessThan(1e-4);
    expect(o.detU).toBeCloseTo(1, 4);
  });
});

describe("matching a UB's cell to the CIF setting", () => {
  const ortho = { a: 5.4, b: 7.6, c: 5.5, alpha: 90, beta: 90, gamma: 90 };
  it("returns the identity when the cells already agree", () => {
    const UB = ubFromU(rot([0.3, 1, 0.2], 40), ortho);
    const m = findBasisMatch(ortho, UB)!;
    expect(m.P).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  });

  it("finds an axis permutation (e.g. Pnma vs Pbnm) and maps CIF indices to the same q", () => {
    // The UB was determined in a cell (b, c, a): P has det +1.
    const P: Mat3 = [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ];
    const UBfile = transformUB(ubFromU(rot([1, -0.4, 0.6], 75), ortho), P);
    const m = findBasisMatch(ortho, UBfile)!;
    expect(m).toBeDefined();
    expect(m.misfit).toBeLessThan(1e-12);
    for (const h of [[1, 0, 0], [0, 2, 1], [3, -1, 2]] as Vec3[]) {
      const q1 = mulVec(m.ubForCif, h);
      const q2 = mulVec(UBfile, mulVec(transpose(m.P), h));
      expect(Math.hypot(q1[0] - q2[0], q1[1] - q2[1], q1[2] - q2[2])).toBeLessThan(1e-14);
    }
    const lat = latticeFromUB(m.ubForCif);
    expect(lat.a).toBeCloseTo(5.4, 10);
    expect(lat.b).toBeCloseTo(7.6, 10);
  });

  it("returns undefined for an unrelated cell", () => {
    const UB = ubFromU(rot([0, 0, 1], 10), { a: 9, b: 11, c: 13, alpha: 90, beta: 90, gamma: 90 });
    expect(findBasisMatch(ortho, UB)).toBeUndefined();
  });
});

describe("a UB for a supercell or a smaller cell of the CIF cell", () => {
  const laue = (hm: string) => laueRotations(settingOps(findByHM(hm)[0]!));
  const U = rot([1, -0.4, 0.6], 75);
  const cubic = (a: number) => ({ a, b: a, c: a, alpha: 90, beta: 90, gamma: 90 });
  const scaled = (M: Mat3, s: number) => M.map((r) => r.map((v) => v * s)) as unknown as Mat3;
  /** The match maps each CIF index to the q the file's UB gives its index in the file's cell, h_UB = Pᵀ·h_CIF. */
  const keepsQ = (m: BasisMatch, UBfile: Mat3) => {
    for (const h of [[1, 0, 0], [0, 2, 1], [3, -1, 2], [1, 1, 1]] as Vec3[]) {
      const q1 = mulVec(m.ubForCif, h);
      const q2 = mulVec(UBfile, mulVec(transpose(m.P), h));
      expect(Math.hypot(q1[0] - q2[0], q1[1] - q2[1], q1[2] - q2[2])).toBeLessThan(1e-12);
    }
  };
  /** A chosen match may differ from the generating one by a symmetry rotation: UB_CIF·Wᵀ for W in the Laue group. */
  const equalUpToSymmetry = (A: Mat3, B: Mat3, rotations: readonly Mat3[]) => rotations.some((W) => maxAbs(A, mulMat(B, transpose(W))) < 1e-12);

  it("finds the 1 × 1 × 1 UB from a 2 × 2 × 2 supercell's (one choice under m-3m)", () => {
    const si = cubic(5.431);
    const UBcif = ubFromU(U, si);
    const UBsuper = transformUB(UBcif, supercell(2, 2, 2));
    // Doubling every axis halves every reciprocal vector.
    expect(maxAbs(UBsuper, scaled(UBcif, 0.5))).toBeLessThan(1e-15);
    const ms = findCellMatches(si, UBsuper, { rotations: laue("F d -3 m") });
    expect(ms).toHaveLength(1);
    expect(ms[0]!.P).toEqual(supercell(2, 2, 2));
    expect(ms[0]!.volumeRatio).toBeCloseTo(8, 12);
    expect(ms[0]!.misfit).toBeLessThan(1e-12);
    expect(maxAbs(ms[0]!.ubForCif, UBcif)).toBeLessThan(1e-15);
    keepsQ(ms[0]!, UBsuper);
    // Without the symmetry, the 24 rotations of the cube are separate choices with the same misfit; the plain one is first.
    const all = findCellMatches(si, UBsuper);
    expect(all).toHaveLength(24);
    expect(all[0]!.P).toEqual(supercell(2, 2, 2));
    expect(findBasisMatch(si, UBsuper)!.P).toEqual(supercell(2, 2, 2));
  });

  it("goes through an ISAW file: the 2 × 2 × 2 file, written back in the CIF cell, holds the 1 × 1 × 1 UB", () => {
    const si = cubic(5.431);
    const UBcif = ubFromU(U, si);
    const file = parseIsawUB(formatIsawUB(transformUB(UBcif, supercell(2, 2, 2))));
    expect(file.latticeLine![0]).toBeCloseTo(10.862, 4);
    const m = findCellMatches(si, file.UB, { rotations: laue("F d -3 m") })[0]!;
    // The file carries 8 decimals of UB/2 ≈ 0.09: a relative 1e-7.
    expect(maxAbs(m.ubForCif, UBcif)).toBeLessThan(2e-8);
    const out = parseIsawUB(formatIsawUB(m.ubForCif));
    expect(out.latticeLine![0]).toBeCloseTo(5.431, 4);
    expect(out.latticeLine![6]).toBeCloseTo(5.431 ** 3, 2);
  });

  it("finds a √2 × √2 × 1 supercell (det 2) and a 2 × 1 × 1 one", () => {
    const tet = { a: 3.9, b: 3.9, c: 6.1, alpha: 90, beta: 90, gamma: 90 };
    const rotations = laue("P 4/m m m");
    const UBcif = ubFromU(U, tet);
    const UBfile = transformUB(UBcif, [[1, -1, 0], [1, 1, 0], [0, 0, 1]]);
    const ms = findCellMatches(tet, UBfile, { rotations });
    expect(ms).toHaveLength(1);
    expect(ms[0]!.volumeRatio).toBeCloseTo(2, 12);
    expect(equalUpToSymmetry(ms[0]!.ubForCif, UBcif, rotations)).toBe(true);
    keepsQ(ms[0]!, UBfile);
    const ortho2 = { a: 4.1, b: 5.3, c: 6.2, alpha: 90, beta: 90, gamma: 90 };
    const m2 = findCellMatches(ortho2, transformUB(ubFromU(U, ortho2), supercell(2, 1, 1)), { rotations: laue("P m m m") });
    expect(m2).toHaveLength(1);
    expect(m2[0]!.P).toEqual(supercell(2, 1, 1));
  });

  it("finds a smaller cell: the primitive cell of an F lattice (P = M⁻¹, volume 1/4)", () => {
    const al = cubic(4.05);
    const rotations = laue("F m -3 m");
    const UBcif = ubFromU(U, al);
    const fToP: Mat3 = [[0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0]];
    const UBprim = transformUB(UBcif, fToP);
    const ms = findCellMatches(al, UBprim, { rotations });
    expect(ms).toHaveLength(1);
    expect(ms[0]!.volumeRatio).toBeCloseTo(0.25, 12);
    expect(ms[0]!.P.flat().every((v) => Number.isInteger(v * 4))).toBe(true);
    expect(equalUpToSymmetry(ms[0]!.ubForCif, UBcif, rotations)).toBe(true);
    keepsQ(ms[0]!, UBprim);
  });

  it("lists the real alternatives of a pseudo-cubic supercell, best first", () => {
    // Tetragonal, c/a = 1.0092: a 2 × 2 × 2 UB could put the CIF's c along any of its axes; only along its c is exact.
    const tet = { a: 5.43, b: 5.43, c: 5.48, alpha: 90, beta: 90, gamma: 90 };
    const UBsuper = transformUB(ubFromU(U, tet), supercell(2, 2, 2));
    const ms = findCellMatches(tet, UBsuper, { rotations: laue("P 4/m m m") });
    // The CIF's c along the UB's c, a or b: the 24 axis choices fall into 24/8 = 3 sets under 4/mmm.
    expect(ms).toHaveLength(3);
    expect(ms[0]!.P).toEqual(supercell(2, 2, 2));
    expect(ms[0]!.misfit).toBeLessThan(1e-12);
    // The others put c along the UB's a or b: metric misfit (c² − a²)/c² of the doubled cell.
    for (const m of ms.slice(1)) expect(m.misfit).toBeCloseTo((5.48 ** 2 - 5.43 ** 2) / 5.48 ** 2, 12);
    expect(ms.slice(1).map((m) => [0, 1].find((j) => Math.abs(m.P[2][j]!) === 2)).sort()).toEqual([0, 1]);
  });

  it("keeps the plain choice for a strained (measured) supercell UB, and rejects an unrelated cell of similar volume", () => {
    const si = cubic(5.431);
    const strain: Mat3 = [[1.003, 0, 0], [0, 0.999, 0], [0, 0, 1.001]];
    const UBsuper = mulMat(strain, transformUB(ubFromU(U, si), supercell(2, 2, 2)));
    const m = findBasisMatch(si, UBsuper)!;
    expect(m.P).toEqual(supercell(2, 2, 2));
    expect(m.misfit).toBeGreaterThan(1e-4);
    expect(m.misfit).toBeLessThan(0.02);
    // 9 × 11 × 13 Å has 8.03 times the volume of Si's cell, but no lattice vectors of those lengths.
    expect(findCellMatches(si, ubFromU(U, { a: 9, b: 11, c: 13, alpha: 90, beta: 90, gamma: 90 }))).toEqual([]);
  });
});
