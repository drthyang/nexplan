import { describe, expect, it } from "vitest";
import { SNS_INSTRUMENTS } from "../ub/instrumentsSns.ts";
import { backToBackAt, backToBackFwhm, backToBackValidFrom, difcFromGeometry, type TofShape } from "./tof.ts";

const ins = (id: string) => SNS_INSTRUMENTS.find((i) => i.id === id)!;

// GSAS-II GSASIIpwd.py getFWHM (TOF, no Lorentzian), transcribed independently:
// σ = √(S0 + S1 d² + S2 d⁴ + Sq d), α = alpha/d, β = β0 + β1/d⁴ + βq/d², FWHM = 2.35482σ + ln2(α + β)/(αβ).
function gsasFwhm(p: { alpha: number; beta0: number; beta1: number; betaq: number; sig0: number; sig1: number; sig2: number; sigq: number }, d: number): number {
  const s = Math.sqrt(p.sig0 + p.sig1 * d ** 2 + p.sig2 * d ** 4 + p.sigq * d);
  const a = p.alpha / d;
  const b = p.beta0 + p.beta1 / d ** 4 + p.betaq / d ** 2;
  return 2.35482 * s + (Math.log(2) * (a + b)) / (a * b);
}

const shapeOf = (p: NonNullable<ReturnType<typeof ins>["frames"]>["list"][number]["profile"] & object): Extract<TofShape, { kind: "backToBack" }> => ({
  kind: "backToBack",
  alpha1: p.alpha,
  beta0: p.beta0,
  beta1: p.beta1,
  betaq: p.betaq,
  sig0: p.sig0,
  sig1: p.sig1,
  sig2: p.sig2,
  sigq: p.sigq,
});

describe("POWGEN frame profiles (ORNL GSAS-II 2026B)", () => {
  const frame = (c: number) => ins("powgen").frames!.list.find((f) => f.hz === 60 && f.centre === c)!;
  const difc = 22598.56; // the 0.8 Å file's difC

  it("FWHM equals GSAS-II's getFWHM, and the shape's σ and β include sig-q and beta-q", () => {
    const p = frame(0.8).profile!;
    const shape = shapeOf(p);
    for (const d of [0.5, 1, 2, 3, 4]) {
      expect(backToBackFwhm(shape, d)).toBeCloseTo(gsasFwhm(p, d), 9);
      const b = backToBackAt(shape, d);
      expect(b.sigma ** 2).toBeCloseTo(p.sig0 + p.sig1 * d * d + p.sig2 * d ** 4 + p.sigq * d, 6);
      expect(b.beta).toBeCloseTo(p.beta0 + p.beta1 / d ** 4 + p.betaq / d ** 2, 12);
    }
  });

  it("0.8 Å frame: Δd/d ≈ 0.22 % at 1 Å rising to ≈ 1 % at 4 Å, within 25 % of the LaB6 resolution measured by Huq et al. (2019), Fig. 6", () => {
    const shape = shapeOf(frame(0.8).profile!);
    const rel = (d: number) => backToBackFwhm(shape, d) / (difc * d);
    // Huq et al., J. Appl. Cryst. 52, 1189 (2019), Fig. 6, high-resolution guide, CWL 0.8 Å (digitised, ×10⁻³).
    for (const [d, measured] of [
      [1.0, 2.4],
      [1.39, 3.6],
      [2.08, 5.7],
      [2.94, 8.2],
      [4.15, 11.7],
    ] as const)
      expect(Math.abs(rel(d) / (measured * 1e-3) - 1)).toBeLessThan(0.25);
    expect(rel(1)).toBeCloseTo(0.0022, 3);
    expect(rel(4)).toBeGreaterThan(rel(1));
  });

  it("each frame's fitted parameters are physical from a short d upward; below it the shape holds the values at validFrom", () => {
    for (const c of [0.8, 1.5, 2.665]) {
      const shape = shapeOf(frame(c).profile!);
      const from = backToBackValidFrom(shape)!;
      expect(from).toBeGreaterThan(0.1);
      expect(from).toBeLessThan(frame(c).dMin + 0.5);
      const held = { ...shape, validFrom: from };
      expect(backToBackAt(held, from / 2)).toEqual(backToBackAt(held, from));
      expect(Number.isFinite(backToBackFwhm(held, from / 2))).toBe(true);
    }
  });
});

describe("NOMAD banks (ORNL 2023A GSAS-II file, ORNL measured resolution)", () => {
  const nomad = ins("nomad");
  it("every bank has a measured Δd/d, from 3.9 % (7°) down to 0.36 % (backscattering)", () => {
    expect(nomad.banks!.list.map((b) => b.dOverD)).toEqual([0.029, 0.019, 0.0137, 0.0069, 0.0036, 0.039]);
  });

  it("the calibrated DIFC of banks 2–5 agrees with the file's own 2θ and flight path within 0.5 %", () => {
    for (const b of nomad.banks!.list.slice(1, 5)) {
      const geometric = difcFromGeometry(nomad.l1! + b.l2!, b.twoThetaDeg!);
      expect(Math.abs(b.difc! / geometric - 1)).toBeLessThan(0.005);
    }
  });
});
