import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runCalculation, type CalcInput, type CalcSuccess } from "../app/compute.ts";
import { familyMembers, hklMiss, presentReflections, simulatable } from "./ubShared.ts";

const cif = (name: string) => readFileSync(new URL(`../../fixtures/cif/${name}`, import.meta.url), "utf8");

async function neutron(name: string, dMin = 0.8): Promise<CalcSuccess> {
  const input: CalcInput = {
    cifText: cif(name),
    fileName: name,
    radiation: "neutron",
    wavelength: 1.5,
    dMin,
    polarization: { kind: "none" },
    profile: { axis: "twoTheta", fwhm: 0.1, eta: 0.5 },
    neutronMode: "cw",
    tof: { twoThetaDeg: 90, flightPathM: 20, difa: 0, zero: 0, lambdaMin: 0.5, lambdaMax: 3.5, shape: { kind: "gaussian", dOverD: 0.003 } },
  };
  const r = await runCalculation(input);
  if (!r.ok) throw new Error(r.message);
  return r;
}

const maxF2 = (r: CalcSuccess) => r.reflections.f2.reduce((m, v) => Math.max(m, v), 0);

describe("hklMiss: what a typed hkl the page does not list is", () => {
  it("calls systematic absences of Fd-3m spinel forbidden (F-centring; h00 needs h = 4n), with d, |F|² = 0 and family", async () => {
    const spinel = await neutron("cod-9001364.cif");
    const a = spinel.structure.cell.a;
    for (const [t, n2] of [["1 0 0", 1], ["2 0 0", 4], ["0 0 6", 36]] as const) {
      const m = hklMiss(spinel, t);
      expect(m.kind, t).toBe("systematic");
      expect(m.message, t).toMatch(/forbidden: systematically absent in F d -3 m/);
      expect(m.d!, t).toBeCloseTo(a / Math.sqrt(n2), 10);
      expect(m.f2!, t).toBeLessThan(1e-12 * maxF2(spinel));
      expect(m.family, t).toBeDefined();
      expect(simulatable(m), t).toBe(true);
    }
  });

  it("lists a forbidden peak's equivalents from the calculation: spinel (2 0 0) is ±(2 0 0), ±(0 2 0), ±(0 0 2)", async () => {
    const spinel = await neutron("cod-9001364.cif");
    const members = familyMembers(spinel, hklMiss(spinel, "2 0 0").family!).map((h) => h.join(" "));
    expect(members.sort()).toEqual(["-2 0 0", "0 -2 0", "0 0 -2", "0 0 2", "0 2 0", "2 0 0"]);
  });

  it("names an accidental absence: Si (2 2 2) is allowed by Fd-3m, cancelled by the 8a site", async () => {
    const si = await neutron("cod-2104737.cif");
    const m = hklMiss(si, "2 2 2");
    expect(m.kind).toBe("accidental");
    expect(m.message).toMatch(/accidental absence/);
    expect(m.f2!).toBeLessThan(1e-12 * maxF2(si));
    expect(simulatable(m)).toBe(true);
  });

  it("gives d below d_min with no |F| (not calculated), so a page can simulate its position and offer the d_min", async () => {
    const spinel = await neutron("cod-9001364.cif");
    const m = hklMiss(spinel, "12 12 12");
    expect(m.kind).toBe("dmin");
    expect(m.d).toBeCloseTo(spinel.structure.cell.a / Math.sqrt(3 * 144), 10);
    expect(m.d!).toBeLessThan(spinel.provenance.dMin);
    expect(m.f2).toBeUndefined();
    expect(m.message).toMatch(/below d_min = 0\.8 Å, so its \|F\| is not calculated/);
    expect(simulatable(m)).toBe(true);
  });

  it("says when a present reflection is past the listed cap, and only then", async () => {
    const spinel = await neutron("cod-9001364.cif");
    const weakest = presentReflections(spinel).at(-1)!;
    const t = weakest.h.join(" ");
    expect(hklMiss(spinel, t, 10)).toMatchObject({ kind: "cap", f2: weakest.f2, message: expect.stringMatching(/weaker than the 10 strongest/) });
    expect(hklMiss(spinel, t)).toMatchObject({ kind: "weak", message: expect.stringMatching(/negligible/) });
  });

  it("answers malformed input and (0 0 0), which are not reflections to simulate", async () => {
    const spinel = await neutron("cod-9001364.cif");
    for (const t of ["1 1", "1 1 1 1", "1.5 0 0", "abc"]) {
      const m = hklMiss(spinel, t);
      expect(m, t).toMatchObject({ kind: "input", message: expect.stringMatching(/three integers/) });
      expect(simulatable(m), t).toBe(false);
    }
    const origin = hklMiss(spinel, "0 0 0");
    expect(origin).toMatchObject({ kind: "origin", message: expect.stringMatching(/direct beam/) });
    expect(simulatable(origin)).toBe(false);
  });
});
