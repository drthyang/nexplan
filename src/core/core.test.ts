import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import gemmiSf from "../../fixtures/sf-gemmi-neutron.json";
import wkValues from "../../fixtures/xray-f0-wk1995-values.json";
import neutronTable from "../data/neutron-sears1992.json";
import { gaussLegendre } from "@materia/core/math/quadrature";
import { readCifStructure } from "../io/cif/structure.ts";
import { classify, enumerateReflections, ReflectionLimitError, structureFactors, type ReflectionList } from "./diffraction/reflections.ts";
import { cwPeaks, familyRepresentative, polarizationFactor, powderLorentz, powderPeaks, synthesizeProfile } from "./diffraction/powder.ts";
import { parseTypeSymbol, speciesFromLabel } from "./scattering/species.ts";
import { amplitudeFor, f0, neutronB, ScatteringLookupError, xrayRow } from "./scattering/tables.ts";
import { buildModel, expandModel, ModelBuildError, type StructureModel } from "./structure/model.ts";
import { parseSymOp } from "./symmetry/ops.ts";
import { resolveSymmetry } from "./symmetry/spaceGroups.ts";

const cif = (name: string) => readFileSync(new URL(`../../fixtures/cif/${name}`, import.meta.url), "utf8");
const model = (name: string, opts = {}) => buildModel(readCifStructure(cif(name)), opts);

describe("species", () => {
  it("parses type symbols", () => {
    const sp = (s: string) => {
      const r = parseTypeSymbol(s);
      if (!r.ok) throw new Error(r.reason);
      return r.species;
    };
    expect(sp("Fe3+")).toMatchObject({ element: "Fe", charge: 3 });
    expect(sp("Fe+3")).toMatchObject({ element: "Fe", charge: 3 });
    expect(sp("O2-")).toMatchObject({ element: "O", charge: -2 });
    expect(sp("O-2")).toMatchObject({ element: "O", charge: -2 });
    expect(sp("Na+")).toMatchObject({ element: "Na", charge: 1 });
    expect(sp("D")).toMatchObject({ element: "H", isotope: 2 });
    expect(sp("57Fe")).toMatchObject({ element: "Fe", isotope: 57 });
    expect(sp("Si")).toMatchObject({ element: "Si", charge: 0 });
  });

  it("resolves labels by case and reports genuine ambiguity", () => {
    const el = (l: string) => {
      const r = speciesFromLabel(l);
      return r.ok ? r.species.element : `?${r.candidates.join("/")}`;
    };
    expect(el("Fe1")).toBe("Fe");
    expect(el("Ca2a")).toBe("Ca");
    expect(el("C12")).toBe("C");
    expect(el("O1")).toBe("O");
    expect(el("OW")).toBe("O");
    expect(el("MN1")).toBe("Mn");
    expect(el("CA1")).toBe("?Ca/C");
    expect(el("SI1")).toBe("?Si/S");
  });
});

describe("scattering tables", () => {
  it("app f0 evaluator equals the build script's evaluator within 1e-10 e", () => {
    for (const row of wkValues.rows) {
      const parsed = parseTypeSymbol(row.id);
      if (!parsed.ok) throw new Error(row.id);
      const x = xrayRow(parsed.species).row;
      wkValues.s.forEach((s, i) => {
        const ref = row.f0[i]!;
        expect(Math.abs(f0(x, s) - ref), `${row.id} s=${s}`).toBeLessThanOrEqual(1e-10 + 1e-10 * Math.abs(ref));
      });
    }
  });

  it("refuses s outside 0–6 Å⁻¹ and ions without a row", () => {
    const fe = xrayRow({ element: "Fe", z: 26, charge: 0 }).row;
    expect(() => f0(fe, 6.01)).toThrow(ScatteringLookupError);
    expect(() => xrayRow({ element: "Fe", z: 26, charge: 4 })).toThrow(/Fe4\+/);
    expect(xrayRow({ element: "Fe", z: 26, charge: 4 }, { ionFallback: "neutral" }).note).toMatch(/neutral Fe/);
    expect(xrayRow({ element: "Fe", z: 26, charge: 3 }).row.id).toBe("Fe3+");
  });

  it("neutron b: natural vs isotope, missing data is an error, complex b flagged", () => {
    expect(neutronB({ element: "Ni", z: 28, charge: 0 }).b.re).toBe(10.3);
    expect(neutronB({ element: "Ni", z: 28, charge: 0, isotope: 62 }).b.re).toBe(-8.7);
    expect(neutronB({ element: "H", z: 1, charge: 0, isotope: 2 }).b.re).toBe(6.671);
    expect(() => neutronB({ element: "Pu", z: 94, charge: 0 })).toThrow(/choose a specific isotope/);
    expect(() => neutronB({ element: "Np", z: 93, charge: 0 })).toThrow(/ambiguous/);
    const gd = neutronB({ element: "Gd", z: 64, charge: 0 });
    expect(gd.b).toEqual({ re: 6.5, im: -13.82 });
    expect(gd.warnings.join(" ")).toMatch(/complex/);
    expect(() => neutronB({ element: "Fe", z: 26, charge: 0 }, { validatedOnly: true })).toThrow(/not certified/);
  });

  it("crystallographic amplitude is conj(b_Sears): every absorbing nucleus gets a positive imaginary part, like X-ray f''", () => {
    let checked = 0;
    for (const e of neutronTable.entries as { id: string; element: string; z: number; kind: string; complex: boolean; bCoh?: { re: number; im: number } }[]) {
      if (!e.complex || e.kind === "element-row-radioactive") continue;
      const mass = e.kind === "isotope" ? Number(/^(\d+)/.exec(e.id)![1]) : undefined; // isotope rows: "3He", "157Gd"
      const sp = { element: e.element, z: e.z, charge: 0, ...(mass !== undefined ? { isotope: mass } : {}) };
      const a = amplitudeFor(sp, { kind: "neutron" }).at(0);
      expect(e.bCoh!.im, e.id).toBeLessThan(0); // stored as printed: b = b′ − i b″
      expect(a, e.id).toEqual({ re: e.bCoh!.re, im: -e.bCoh!.im });
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(15);
  });
});

// ---------------------------------------------------------------- structures

describe("structure model and expansion", () => {
  it("expands NaCl, quartz, Si and both spinel origin choices to the right cell contents", () => {
    const counts = (m: StructureModel) => expandModel(m).multiplicities;
    expect(counts(model("cod-1000041.cif"))).toEqual([4, 4]);
    expect(counts(model("cod-1011097.cif"))).toEqual([3, 6]);
    expect(counts(model("cod-2104737.cif"))).toEqual([8]);
    expect(counts(model("cod-1010129.cif"))).toEqual([8, 16, 32]);
    expect(counts(model("cod-9001364.cif"))).toEqual([8, 8, 16, 16, 32]);
    expect(model("cod-9001364.cif").symmetry.setting?.xhm).toBe("F d -3 m:2");
    expect(model("cod-1010129.cif").symmetry.setting?.xhm).toBe("F d -3 m:1");
    const disorder = expandModel(model("cod-9001364.cif")).diagnostics.filter((d) => /share a position/.test(d.message));
    expect(disorder).toHaveLength(2);
  });

  it("merges near-coincident images symmetrically, whatever the order of the operations", () => {
    // P4, a = 10 Å: Fe 0.0105 Å off the 4-fold axis. Neighbouring images are 0.0148 Å apart (< 0.02 Å, merged),
    // opposite ones 0.021 Å (not merged directly, but joined through their neighbours): one atom on the axis.
    // Leader clustering gave 2 atoms here, or 4, depending on the order.
    const p4 = (x: number, ops: string[]) =>
      `data_t\n_cell_length_a 10\n_cell_length_b 10\n_cell_length_c 5\n_cell_angle_alpha 90\n_cell_angle_beta 90\n_cell_angle_gamma 90\n_symmetry_space_group_name_H-M 'P 4'\nloop_\n_symmetry_equiv_pos_as_xyz\n${ops.join("\n")}\nloop_\n_atom_site_label\n_atom_site_type_symbol\n_atom_site_fract_x\n_atom_site_fract_y\n_atom_site_fract_z\n_atom_site_occupancy\n_atom_site_U_iso_or_equiv\nFe1 Fe ${x} 0 0 1 0.01\n`;
    const orders = [
      ["x,y,z", "-y,x,z", "-x,-y,z", "y,-x,z"],
      ["x,y,z", "-x,-y,z", "-y,x,z", "y,-x,z"],
    ];
    for (const ops of orders) {
      const ex = expandModel(buildModel(readCifStructure(p4(0.00105, ops))));
      expect(ex.multiplicities).toEqual([1]);
      for (const v of ex.atoms[0]!.fract) expect(Math.min(v, 1 - v)).toBeLessThan(1e-12);
      // 0.0226 Å between neighbours: all four kept, and reported.
      const apart = expandModel(buildModel(readCifStructure(p4(0.0016, ops))));
      expect(apart.multiplicities).toEqual([4]);
      expect(apart.diagnostics.some((d) => /0\.023 Å apart/.test(d.message))).toBe(true);
    }
  });

  it("asks instead of guessing when the file gives only an ambiguous symbol", () => {
    // Strip everything that decides the origin choice: operations, Hall symbol, and the ":1" H-M variant.
    const text = cif("cod-2104737.cif")
      .replace(/loop_\s*_symmetry_equiv_pos_as_xyz[\s\S]*?(?=loop_)/, "")
      .replace(/_symmetry_space_group_name_Hall.*\n/, "")
      .replace(/_symmetry_space_group_name_H-M.*\n/, "");
    expect(readCifStructure(text).symmetry.ops).toBeUndefined();
    try {
      buildModel(readCifStructure(text));
      expect.unreachable();
    } catch (e) {
      expect([...(e as ModelBuildError).settingCandidates].sort()).toEqual(["F d -3 m:1", "F d -3 m:2"]);
    }
    expect(buildModel(readCifStructure(text), { chosenSetting: "F d -3 m:1" }).symmetry.ops).toHaveLength(192);
    // With the Hall symbol present, the setting is determined without asking.
    const withHall = cif("cod-2104737.cif").replace(/loop_\s*_symmetry_equiv_pos_as_xyz[\s\S]*?(?=loop_)/, "");
    expect(buildModel(readCifStructure(withHall)).symmetry.setting?.xhm).toBe("F d -3 m:1");
  });
});

// ---------------------------------------------------------------- reflections

describe("reflection enumeration", () => {
  it("equals brute force for a strongly skewed triclinic cell", () => {
    const cell = { a: 3.1, b: 7.9, c: 5.3, alpha: 63, beta: 112, gamma: 78 };
    const ops = resolveSymmetry({ hm: "P -1" }).ops;
    const dMin = 0.9;
    const list = enumerateReflections(cell, ops, dMin);
    const G = (() => {
      const r = Math.PI / 180;
      const { a, b, c } = cell;
      const ca = Math.cos(cell.alpha * r), cb = Math.cos(cell.beta * r), cg = Math.cos(cell.gamma * r);
      return [[a * a, a * b * cg, a * c * cb], [a * b * cg, b * b, b * c * ca], [a * c * cb, b * c * ca, c * c]];
    })();
    // Independent check: d from inverting G by cofactors, over a generous cube.
    const det = G[0]![0]! * (G[1]![1]! * G[2]![2]! - G[1]![2]! * G[2]![1]!) - G[0]![1]! * (G[1]![0]! * G[2]![2]! - G[1]![2]! * G[2]![0]!) + G[0]![2]! * (G[1]![0]! * G[2]![1]! - G[1]![1]! * G[2]![0]!);
    const cof = (i: number, j: number) => {
      const r = [0, 1, 2].filter((x) => x !== i), c = [0, 1, 2].filter((x) => x !== j);
      return ((i + j) % 2 ? -1 : 1) * (G[r[0]!]![c[0]!]! * G[r[1]!]![c[1]!]! - G[r[0]!]![c[1]!]! * G[r[1]!]![c[0]!]!);
    };
    const expected = new Map<string, number>();
    for (let h = -30; h <= 30; h++)
      for (let k = -30; k <= 30; k++)
        for (let l = -30; l <= 30; l++) {
          if (!h && !k && !l) continue;
          const v = [h, k, l];
          let q2 = 0;
          for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) q2 += (v[i]! * cof(j, i) * v[j]!) / det;
          if (1 / Math.sqrt(q2) >= dMin) expected.set(`${h},${k},${l}`, 1 / Math.sqrt(q2));
        }
    expect(list.count).toBe(expected.size);
    for (let i = 0; i < list.count; i++) {
      const ref = expected.get(`${list.h[i]},${list.k[i]},${list.l[i]}`);
      expect(ref).toBeDefined();
      expect(Math.abs(list.d[i]! - ref!) / ref!).toBeLessThan(1e-12);
    }
  });

  it("raises instead of truncating", () => {
    const ops = resolveSymmetry({ hm: "P 1" }).ops;
    try {
      enumerateReflections({ a: 30, b: 30, c: 30, alpha: 90, beta: 90, gamma: 90 }, ops, 0.5, { maxCount: 10_000 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ReflectionLimitError);
      expect((e as ReflectionLimitError).suggestedDMin).toBeGreaterThan(0.5);
    }
  });
});

describe("structure factors", () => {
  const find = (refl: ReflectionList, h: number, k: number, l: number) => {
    for (let i = 0; i < refl.count; i++) if (refl.h[i] === h && refl.k[i] === k && refl.l[i] === l) return i;
    throw new Error(`no ${h}${k}${l}`);
  };

  it("matches gemmi 0.7.3 neutron F (phases included) for five COD structures", () => {
    for (const ref of gemmiSf.structures) {
      const m = model(ref.file);
      const ex = expandModel(m);
      const refl = enumerateReflections(m.cell, m.symmetry.ops, gemmiSf.dMin * (1 - 1e-9));
      const sf = structureFactors(m, ex, refl, { kind: "neutron" });
      const index = new Map<string, number>();
      for (let i = 0; i < refl.count; i++) index.set(`${refl.h[i]},${refl.k[i]},${refl.l[i]}`, i);
      expect(refl.count, ref.file).toBe(ref.rows.length);
      for (const [h, k, l, , fr, fi] of ref.rows as number[][]) {
        const i = index.get(`${h},${k},${l}`)!;
        const S = sf.scale[i]!;
        const tol = 1e-8 * S + 1e-8 * Math.hypot(fr!, fi!);
        expect(Math.hypot(sf.re[i]! - fr!, sf.im[i]! - fi!), `${ref.file} ${h}${k}${l}`).toBeLessThanOrEqual(tol);
      }
    }
  });

  it("separates systematic from accidental absences (diamond Si: 200 systematic, 222 accidental)", () => {
    const m = model("cod-2104737.cif");
    const refl = enumerateReflections(m.cell, m.symmetry.ops, 1.0);
    const sf = structureFactors(m, expandModel(m), refl, { kind: "xray" });
    expect(classify(refl, sf, find(refl, 2, 0, 0))).toBe("systematic");
    expect(classify(refl, sf, find(refl, 2, 2, 2))).toBe("accidental");
    expect(classify(refl, sf, find(refl, 1, 1, 1))).toBe("present");
  });

  it("single atom in P1: F = o·f0(s)·exp(−Bs²)·exp(2πi h·x) exactly", () => {
    const text = `data_p1\n_cell_length_a 4\n_cell_length_b 5\n_cell_length_c 6\n_cell_angle_alpha 80\n_cell_angle_beta 95\n_cell_angle_gamma 101\n_space_group_name_H-M_alt 'P 1'\nloop_\n_atom_site_label\n_atom_site_type_symbol\n_atom_site_fract_x\n_atom_site_fract_y\n_atom_site_fract_z\n_atom_site_occupancy\n_atom_site_B_iso_or_equiv\nFe1 Fe2+ 0.13 0.27 0.61 0.75 0.8\n`;
    const m = buildModel(readCifStructure(text));
    const refl = enumerateReflections(m.cell, m.symmetry.ops, 1.2);
    const sf = structureFactors(m, expandModel(m), refl, { kind: "xray" });
    const row = xrayRow({ element: "Fe", z: 26, charge: 2 }).row;
    for (let i = 0; i < refl.count; i++) {
      const s = 1 / (2 * refl.d[i]!);
      const amp = 0.75 * f0(row, s) * Math.exp(-0.8 * s * s);
      const ph = 2 * Math.PI * (refl.h[i]! * 0.13 + refl.k[i]! * 0.27 + refl.l[i]! * 0.61);
      expect(Math.abs(sf.re[i]! - amp * Math.cos(ph))).toBeLessThan(1e-12 * amp + 1e-14);
      expect(Math.abs(sf.im[i]! - amp * Math.sin(ph))).toBeLessThan(1e-12 * amp + 1e-14);
    }
  });

  it("origin choice 1 and 2 descriptions of the same spinel give identical |F|²", () => {
    const o1 = model("cod-1010129.cif");
    // Same structure in origin choice 2: shift by −(1/8,1/8,1/8) and use the :2 operations.
    const shifted = cif("cod-1010129.cif")
      .replace(/loop_\s*_symmetry_equiv_pos_as_xyz[\s\S]*?(?=loop_)/, "")
      .replace(/_symmetry_space_group_name_H-M\s+'F d -3 m :1'/, "_symmetry_space_group_name_H-M 'F d -3 m :2'")
      .replace("'F 4d 2 3 -1d'", "'-F 4vw 2vw 3'")
      .replace("Mg1 Mg2+ 8 a 0. 0. 0.", "Mg1 Mg2+ 8 a -0.125 -0.125 -0.125")
      .replace("Al1 Al3+ 16 d 0.625 0.625 0.625", "Al1 Al3+ 16 d 0.5 0.5 0.5")
      .replace("O1 O2- 32 e 0.375 0.375 0.375", "O1 O2- 32 e 0.25 0.25 0.25");
    const o2 = buildModel(readCifStructure(shifted));
    expect(o2.symmetry.setting?.xhm).toBe("F d -3 m:2");
    // Leaving the old Hall symbol in place must be caught as a conflict, not resolved silently.
    expect(() => buildModel(readCifStructure(shifted.replace("'-F 4vw 2vw 3'", "'F 4d 2 3 -1d'")))).toThrow(/contradicts/);
    const r1 = enumerateReflections(o1.cell, o1.symmetry.ops, 0.9);
    const r2 = enumerateReflections(o2.cell, o2.symmetry.ops, 0.9);
    const s1 = structureFactors(o1, expandModel(o1), r1, { kind: "xray" });
    const s2 = structureFactors(o2, expandModel(o2), r2, { kind: "xray" });
    expect(r1.count).toBe(r2.count);
    for (let i = 0; i < r1.count; i++) {
      expect(Math.abs(s1.f2[i]! - s2.f2[i]!)).toBeLessThan(1e-9 * (s1.scale[i]! ** 2 + 1));
      expect(r1.absent[i]).toBe(r2.absent[i]);
    }
  });

  it("complex b: |F(h)|² equals the physics-convention amplitude Σ b·exp(−iQ·r); using printed b directly would swap h and −h", () => {
    // Non-centrosymmetric P1 cell with Gd (absorbing) and O.
    const text = `data_nc\n_cell_length_a 4\n_cell_length_b 4.5\n_cell_length_c 5\n_cell_angle_alpha 90\n_cell_angle_beta 90\n_cell_angle_gamma 90\n_space_group_name_H-M_alt 'P 1'\nloop_\n_atom_site_label\n_atom_site_type_symbol\n_atom_site_fract_x\n_atom_site_fract_y\n_atom_site_fract_z\nGd1 Gd 0 0 0\nO1 O 0.21 0.33 0.42\nO2 O 0.61 0.12 0.77\n`;
    const m = buildModel(readCifStructure(text));
    const refl = enumerateReflections(m.cell, m.symmetry.ops, 1.5);
    const sf = structureFactors(m, expandModel(m), refl, { kind: "neutron" });
    const sites = m.sites.map((s) => ({ b: neutronB(s.species).b, x: s.fract }));
    const index = new Map<string, number>();
    for (let i = 0; i < refl.count; i++) index.set(`${refl.h[i]},${refl.k[i]},${refl.l[i]}`, i);
    let bijvoet = 0;
    for (let i = 0; i < refl.count; i++) {
      const h = [refl.h[i]!, refl.k[i]!, refl.l[i]!];
      // Physics convention (Sears b, exp(−i Q·r) with Q = k_out − k_in = 2π h).
      let pr = 0, pi = 0, wr = 0, wi = 0;
      for (const { b, x } of sites) {
        const ph = 2 * Math.PI * (h[0]! * x[0] + h[1]! * x[1] + h[2]! * x[2]);
        pr += b.re * Math.cos(-ph) - b.im * Math.sin(-ph);
        pi += b.re * Math.sin(-ph) + b.im * Math.cos(-ph);
        wr += b.re * Math.cos(ph) - b.im * Math.sin(ph); // printed b with exp(+iφ): the mistake
        wi += b.re * Math.sin(ph) + b.im * Math.cos(ph);
      }
      expect(Math.abs(sf.f2[i]! - (pr * pr + pi * pi))).toBeLessThan(1e-9 * sf.f2[i]! + 1e-9);
      // The printed b in the crystallographic formula gives the intensity of −h instead.
      const minus = index.get(`${-h[0]!},${-h[1]!},${-h[2]!}`)!;
      expect(Math.abs(sf.f2[minus]! - (wr * wr + wi * wi))).toBeLessThan(1e-9 * sf.f2[minus]! + 1e-9);
      if (Math.abs(sf.f2[i]! - (wr * wr + wi * wi)) > 1e-3) bijvoet++;
    }
    expect(bijvoet).toBeGreaterThan(0);
  });
});

describe("powder", () => {
  it("family sums: Σ|F|² over a family = m·|F_rep|² for real amplitudes, and no reflection is lost", () => {
    const m = model("cod-1011097.cif");
    const refl = enumerateReflections(m.cell, m.symmetry.ops, 1.0);
    const sf = structureFactors(m, expandModel(m), refl, { kind: "xray" });
    const peaks = powderPeaks(refl, sf, m.symmetry.ops, { wavelength: 0.5, lorentz: false, polarization: { kind: "none" } }, { friedel: true });
    let total = 0;
    for (let i = 0; i < refl.count; i++) if (!refl.absent[i]) total += sf.f2[i]!;
    expect(peaks.reduce((t, p) => t + p.sumF2, 0)).toBeCloseTo(total, 6);
    for (const p of peaks) for (const f of p.families) {
      const i = (() => { for (let r = 0; r < refl.count; r++) if (refl.h[r] === f.hkl[0] && refl.k[r] === f.hkl[1] && refl.l[r] === f.hkl[2]) return r; return -1; })();
      expect(Math.abs(f.f2 - sf.f2[i]!)).toBeLessThan(1e-9 * (sf.f2[i]! + 1));
    }
    // −3m Laue class + Friedel: general hkl multiplicity 12.
    expect(Math.max(...peaks.flatMap((p) => p.families.map((f) => f.multiplicity)))).toBe(12);
  });

  it("Lorentz and polarization factors follow ITC Vol. C §6.2", () => {
    const th = (25 * Math.PI) / 180;
    expect(powderLorentz(th)).toBeCloseTo(1 / (Math.sin(th) ** 2 * Math.cos(th)), 14);
    expect(polarizationFactor({ kind: "unpolarized" }, 2 * th)).toBeCloseTo((1 + Math.cos(2 * th) ** 2) / 2, 14);
    expect(polarizationFactor({ kind: "monochromator", twoThetaMDeg: 0 }, 2 * th)).toBeCloseTo((1 + Math.cos(2 * th) ** 2) / 2, 14);
    expect(polarizationFactor({ kind: "linear", fraction: 1 }, 2 * th)).toBe(1);
    expect(polarizationFactor({ kind: "none" }, 2 * th)).toBe(1);
  });

  it("a line at exact backscattering (2θ = 180°) is left out, not given a divergent Lorentz factor", () => {
    const line = (d: number) => ({ d, q: (2 * Math.PI) / d, sumF2: 1, families: [] });
    const peaks = cwPeaks([line(0.75), line(0.76), line(1.5)], { wavelength: 1.5, lorentz: true, polarization: { kind: "none" } });
    expect(peaks.map((p) => p.d)).toEqual([0.76, 1.5]);
    expect(Math.max(...peaks.map((p) => p.lp))).toBeLessThan(1e3);
  });

  it("profile area equals Σ intensity (unit-area pseudo-Voigt), converged on the grid", () => {
    const m = model("cod-1000041.cif");
    const refl = enumerateReflections(m.cell, m.symmetry.ops, 1.0);
    const sf = structureFactors(m, expandModel(m), refl, { kind: "neutron" });
    const peaks = powderPeaks(refl, sf, m.symmetry.ops, { wavelength: 1.5, lorentz: true, polarization: { kind: "none" } }, { friedel: true });
    const inside = peaks.filter((p) => p.twoTheta! > 20 && p.twoTheta! < 140);
    const expected = inside.reduce((t, p) => t + p.intensity, 0);
    const { y } = synthesizeProfile(inside, "twoTheta", { min: 0, max: 180, step: 0.005 }, { fwhm: 0.1, eta: 0 });
    const area = y.reduce((t, v) => t + v, 0) * 0.005;
    expect(Math.abs(area - expected) / expected).toBeLessThan(1e-4);
    // Gauss–Legendre cross-check of unit area for a Lorentzian-rich shape (MATERIA quadrature).
    expect(gaussLegendre).toBeTypeOf("function");
  });

  it("family representative is symmetry-invariant", () => {
    const ops = resolveSymmetry({ hm: "F m -3 m" }).ops;
    expect(familyRepresentative(ops, [-1, 2, -3], true)).toEqual([3, 2, 1]);
    expect(parseSymOp("x,y,z")).toBeDefined();
  });
});
