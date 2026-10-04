import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runCalculation, type CalcInput, type CalcSuccess } from "../app/compute.ts";
import { hklMiss, presentAfter, presentReflections } from "./ubShared.ts";

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

describe("hklMiss: why a typed hkl is not among the simulated reflections", () => {
  it("names systematic absences of Fd-3m spinel (F-centring; h00 needs h = 4n)", async () => {
    const spinel = await neutron("cod-9001364.cif");
    for (const t of ["1 0 0", "2 0 0", "0 0 6"]) {
      const m = hklMiss(spinel, t);
      expect(m.kind, t).toBe("systematic");
      expect(m.message, t).toMatch(/systematically absent/);
      expect(m.d, t).toBeUndefined();
    }
  });

  it("names an accidental absence: Si (2 2 2) is allowed by Fd-3m, cancelled by the 8a site", async () => {
    const si = await neutron("cod-2104737.cif");
    const m = hklMiss(si, "2 2 2");
    expect(m.kind).toBe("accidental");
    expect(m.message).toMatch(/accidental absence/);
  });

  it("gives d below d_min, so a page can offer the d_min that includes it", async () => {
    const spinel = await neutron("cod-9001364.cif");
    const m = hklMiss(spinel, "12 12 12");
    const d = spinel.structure.cell.a / Math.sqrt(3 * 144);
    expect(m.d).toBeCloseTo(d, 10);
    expect(m.kind).toBe("dmin");
    expect(m.d!).toBeLessThan(spinel.provenance.dMin);
    expect(m.message).toMatch(/below d_min = 0\.8 Å/);
  });

  it("estimates the list after lowering d_min (1/d³) within 10 %, on the low side", async () => {
    const spinel = await neutron("cod-9001364.cif");
    const lower = await neutron("cod-9001364.cif", 0.38);
    const actual = lower.reflections.cls.reduce((n, c) => n + (c === 0 ? 1 : 0), 0);
    const estimate = presentAfter(hklMiss(spinel, "12 12 12", 6000), 0.38)!;
    // 8,883 for 9,570: the first list (952 at 0.8 Å) has not reached the asymptotic count, hence the notice's margin.
    expect(estimate).toBeLessThan(actual);
    expect((actual - estimate) / actual).toBeLessThan(0.1);
    expect(actual).toBeGreaterThan(6000);
  });

  it("says when a present reflection is past the simulated cap, and only then", async () => {
    const spinel = await neutron("cod-9001364.cif");
    const weakest = presentReflections(spinel).at(-1)!;
    const t = weakest.h.join(" ");
    expect(hklMiss(spinel, t, 10)).toMatchObject({ kind: "cap", message: expect.stringMatching(/weaker than the 10 strongest/) });
    expect(hklMiss(spinel, t)).toMatchObject({ kind: "weak", message: expect.stringMatching(/too weak to draw/) });
  });

  it("answers malformed input and (0 0 0) without looking anything up", async () => {
    const spinel = await neutron("cod-9001364.cif");
    for (const t of ["1 1", "1 1 1 1", "1.5 0 0", "abc"]) expect(hklMiss(spinel, t), t).toMatchObject({ kind: "input", message: expect.stringMatching(/three integers/) });
    expect(hklMiss(spinel, "0 0 0")).toMatchObject({ kind: "origin", message: expect.stringMatching(/direct beam/) });
  });
});
