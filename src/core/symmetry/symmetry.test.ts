import { describe, expect, it } from "vitest";
import fixture from "../../../fixtures/absences-gemmi.json";
import { isReflectionAbsent } from "@materia/core/crystal/symmetry";
import type { SymmetryOperation } from "@materia/core/crystal/types";
import { closeGroup, formatSymOp, isSystematicallyAbsent, parseSymOp, SymOpParseError, TDEN, type IntVec3, type SymOp } from "./ops.ts";
import { findByHM, resolveSymmetry, SETTINGS, settingOps, splitHMSuffix, SymmetryResolutionError } from "./spaceGroups.ts";

describe("parseSymOp", () => {
  it("parses common triplet spellings exactly", () => {
    const op = parseSymOp("-x+1/2, y, z+1/4");
    expect(op.R).toEqual([
      [-1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    expect(op.t).toEqual([12, 0, 6]);
    expect(parseSymOp("1/2+X,1/2-Y,-Z").t).toEqual([12, 12, 0]);
    expect(parseSymOp("'x-y,x,z+1/6'").R[0]).toEqual([1, -1, 0]);
    expect(parseSymOp("x+0.5,-y,z").t).toEqual([12, 0, 0]);
    expect(parseSymOp("x,y,z+0.3333").t).toEqual([0, 0, 8]);
    expect(parseSymOp("-x,-y,z-1/2").t).toEqual([0, 0, 12]);
    expect(formatSymOp(parseSymOp("1/2+X,1/2-Y,-Z"))).toBe("x+1/2,-y+1/2,-z");
  });

  it("rejects anything that is not a strict affine triplet", () => {
    for (const bad of ["x,y", "x,y,z,1", "x,y,w", "x,y,z+1/5", "x,y,z+0.3", "x,y,alert(1)", "x+-y,y,z", "x,x,z", ""]) {
      expect(() => parseSymOp(bad), bad).toThrow(SymOpParseError);
    }
  });
});

describe("space-group table (gemmi 0.7.3, all settings)", () => {
  it("has 564 settings, each a closed group with unique operations", () => {
    expect(SETTINGS).toHaveLength(564);
    for (const s of SETTINGS) {
      const ops = settingOps(s);
      expect(closeGroup(ops).length, s.xhm).toBe(ops.length);
    }
  });

  it("op-derived absences equal gemmi is_systematically_absent for |h|,|k|,|l| ≤ 4 in every setting", () => {
    const R = fixture.range;
    const hkl: IntVec3[] = [];
    for (let h = -R; h <= R; h++) for (let k = -R; k <= R; k++) for (let l = -R; l <= R; l++) hkl.push([h, k, l]);
    const byXhm = new Map(SETTINGS.map((s) => [s.xhm, s]));
    let compared = 0;
    for (const entry of fixture.settings) {
      const s = byXhm.get(entry.xhm)!;
      const bits = Uint8Array.from(atob(entry.absent), (c) => c.charCodeAt(0));
      const ops = settingOps(s);
      hkl.forEach((h, i) => {
        const gemmiAbsent = ((bits[i >> 3]! >> (i & 7)) & 1) === 1;
        if (h[0] === 0 && h[1] === 0 && h[2] === 0) return;
        expect(isSystematicallyAbsent(ops, h), `${s.xhm} ${h}`).toBe(gemmiAbsent);
        compared++;
      });
    }
    expect(compared).toBe(564 * (hkl.length - 1));
  });

  it("agrees with MATERIA's floating-point isReflectionAbsent (an independent implementation)", () => {
    const toMateria = (op: SymOp): SymmetryOperation =>
      ({
        rotation: op.R.map((r) => [...r]),
        translation: op.t.map((n) => n / TDEN),
        xyz: formatSymOp(op),
      }) as unknown as SymmetryOperation;
    for (const s of SETTINGS.filter((x) => x.isReference)) {
      const ops = settingOps(s);
      const mOps = ops.map(toMateria);
      for (let h = -3; h <= 3; h++)
        for (let k = -3; k <= 3; k++)
          for (let l = -3; l <= 3; l++) {
            if (!h && !k && !l) continue;
            expect(isReflectionAbsent(mOps, h, k, l), `${s.xhm} ${h}${k}${l}`).toBe(isSystematicallyAbsent(ops, [h, k, l]));
          }
    }
  });
});

describe("resolveSymmetry", () => {
  const cubic = { a: 10, b: 10, c: 10, alpha: 90, beta: 90, gamma: 90 };

  it("refuses to guess the origin choice of F d -3 m without operations", () => {
    try {
      resolveSymmetry({ hm: "F d -3 m", cell: cubic });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SymmetryResolutionError);
      expect((e as SymmetryResolutionError).candidates.map((c) => c.xhm).sort()).toEqual(["F d -3 m:1", "F d -3 m:2"]);
    }
    expect(resolveSymmetry({ hm: "F d -3 m:2" }).setting?.hall).toBe("-F 4vw 2vw 3");
    expect(resolveSymmetry({ hm: "F d -3 m Z" }).setting?.xhm).toBe("F d -3 m:2");
    expect(resolveSymmetry({ hm: "Fd-3m (origin choice 1)" }).setting?.xhm).toBe("F d -3 m:1");
  });

  it("identifies the setting from explicit operations and checks them against the symbol", () => {
    const fd3m2 = SETTINGS.find((s) => s.xhm === "F d -3 m:2")!;
    const r = resolveSymmetry({ ops: fd3m2.ops, hm: "F d -3 m" });
    expect(r.setting?.xhm).toBe("F d -3 m:2");
    expect(r.source).toBe("ops");
    const pnma = SETTINGS.find((s) => s.xhm === "P n m a")!;
    expect(() => resolveSymmetry({ ops: pnma.ops, hm: "P b n m" })).toThrow(SymmetryResolutionError);
    expect(() => resolveSymmetry({ ops: pnma.ops, number: 14 })).toThrow(SymmetryResolutionError);
  });

  it("completes centring when a CIF lists only coset representatives", () => {
    const i4mmm = SETTINGS.find((s) => s.xhm === "I 4/m m m")!;
    const reps = i4mmm.ops.filter((t) => !/1\/2/.test(t));
    expect(reps).toHaveLength(16);
    const r = resolveSymmetry({ ops: reps, hm: "I 4/m m m" });
    expect(r.source).toBe("ops+centring");
    expect(r.ops).toHaveLength(32);
    expect(r.setting?.xhm).toBe("I 4/m m m");
    expect(r.assumptions[0]).toMatch(/centring/);
  });

  it("does not add a second centring to a list that has its own (R 3, reverse setting, hexagonal axes)", () => {
    // Reverse centring (1/3, 2/3, 1/3), (2/3, 1/3, 2/3); the letter R alone would add the obverse one.
    const rot = ["x,y,z", "-y,x-y,z", "-x+y,-x,z"];
    const shift = (t: string, a: string, b: string, c: string) => t.split(",").map((p, i) => `${p}+${[a, b, c][i]}`).join(",");
    const ops = rot.flatMap((t) => [t, shift(t, "1/3", "2/3", "1/3"), shift(t, "2/3", "1/3", "2/3")]);
    const r = resolveSymmetry({ ops, hm: "R 3", cell: { a: 6, b: 6, c: 14, alpha: 90, beta: 90, gamma: 120 } });
    expect(r.ops).toHaveLength(9);
    expect(r.source).toBe("ops");
    // Reverse condition h − k + l = 3n (ITA Table 2.2.13.1): (1 0 2) and (−1 0 1) present, (1 0 1) absent.
    expect(isSystematicallyAbsent(r.ops, [1, 0, 2])).toBe(false);
    expect(isSystematicallyAbsent(r.ops, [-1, 0, 1])).toBe(false);
    expect(isSystematicallyAbsent(r.ops, [1, 0, 1])).toBe(true);
  });

  it("rejects an incomplete non-centred operation list", () => {
    expect(() => resolveSymmetry({ ops: ["x,y,z", "-y,x,z"], hm: "P 4" })).toThrow(/not closed/);
  });

  it("chooses hexagonal vs rhombohedral axes for R groups from the cell", () => {
    expect(resolveSymmetry({ hm: "R -3 m", cell: { a: 5, b: 5, c: 14, alpha: 90, beta: 90, gamma: 120 } }).setting?.xhm).toBe("R -3 m:H");
    expect(resolveSymmetry({ hm: "R -3 m", cell: { a: 5, b: 5, c: 5, alpha: 60, beta: 60, gamma: 60 } }).setting?.xhm).toBe("R -3 m:R");
  });

  it("never falls back to P1", () => {
    expect(() => resolveSymmetry({ hm: "P 9 z z" })).toThrow(SymmetryResolutionError);
    expect(() => resolveSymmetry({})).toThrow(SymmetryResolutionError);
    expect(() => resolveSymmetry({ number: 14 })).toThrow(/settings/);
    expect(resolveSymmetry({ number: 225 }).setting?.xhm).toBe("F m -3 m");
  });

  it("parses setting suffixes", () => {
    expect(splitHMSuffix("R -3 m:H")).toEqual({ base: "R -3 m", ext: "H" });
    expect(splitHMSuffix("P n m a")).toEqual({ base: "P n m a" });
    expect(findByHM("P 21/c").map((s) => s.xhm)).toEqual(["P 1 21/c 1"]);
  });
});
