/**
 * End-to-end check of the UB, goniometer and Laue conventions against real
 * TOPAZ data: Mantid's unit-test files TOPAZ_3007.mat and TOPAZ_3007.peaks
 * (43 indexed peaks with χ, φ, ω, 2θ, azimuth and λ). The files are fetched
 * and hash-checked by `npm run data:fetch` (license not stated, so they are
 * never committed); the test is skipped when they are absent.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Vec3 } from "@materia/core/math/types";
import { inverse, mulVec, transpose } from "@materia/core/math/mat3";
import { parseIsawUB } from "../../io/isaw.ts";
import { goniometerMatrix, laueCondition, qLab } from "./goniometer.ts";
import { INSTRUMENTS } from "./instruments.ts";
import { latticeFromUB, orientationFromUB } from "./ub.ts";

const cache = new URL("../../../data-sources/cache/", import.meta.url).pathname;
const matPath = `${cache}mantid-topaz3007-mat/TOPAZ_3007.mat`;
const peaksPath = `${cache}mantid-topaz3007-peaks/TOPAZ_3007.peaks`;
const corelliPath = `${cache}garnet-corelli-yag-ub/corelli_YAG_ub.mat`;

interface PeakRow {
  h: Vec3;
  chi: number;
  phi: number;
  omega: number;
  twoTheta: number; // rad
  az: number; // rad
  wl: number;
}

function readPeaks(text: string): PeakRow[] {
  const rows: PeakRow[] = [];
  let chi = 0;
  let phi = 0;
  let omega = 0;
  for (const line of text.split("\n")) {
    const t = line.trim().split(/\s+/);
    if (t[0] === "1") {
      chi = Number(t[3]);
      phi = Number(t[4]);
      omega = Number(t[5]);
    } else if (t[0] === "3") {
      rows.push({ h: [Number(t[2]), Number(t[3]), Number(t[4])], chi, phi, omega, twoTheta: Number(t[9]), az: Number(t[10]), wl: Number(t[11]) });
    }
  }
  return rows;
}

const universal = INSTRUMENTS.find((i) => i.id === "universal")!.goniometer;

describe.skipIf(!existsSync(matPath) || !existsSync(peaksPath))("TOPAZ_3007 (Mantid test data): UB · goniometer · Laue", () => {
  const ub = parseIsawUB(readFileSync(matPath, "utf8"));
  const peaks = readPeaks(readFileSync(peaksPath, "utf8"));

  it("reads the UB: monoclinic cell matching the file's lattice line, right-handed, U a rotation", () => {
    const lat = latticeFromUB(ub.UB);
    expect(lat.a).toBeCloseTo(14.1526, 3);
    expect(lat.b).toBeCloseTo(19.2903, 3);
    expect(lat.c).toBeCloseTo(8.5813, 3);
    expect(lat.beta).toBeCloseTo(105.0738, 2);
    const o = orientationFromUB(ub.UB);
    expect(o.detUB).toBeGreaterThan(0);
    expect(o.orthogonalityError).toBeLessThan(1e-4);
    expect(peaks).toHaveLength(43);
  });

  it("indexes every observed peak: UB⁻¹·Rᵀ·(k_f − k_i) = +hkl of the file", () => {
    const UBinv = inverse(ub.UB);
    for (const p of peaks) {
      const kf: Vec3 = [Math.sin(p.twoTheta) * Math.cos(p.az), Math.sin(p.twoTheta) * Math.sin(p.az), Math.cos(p.twoTheta)];
      const q: Vec3 = [kf[0] / p.wl, kf[1] / p.wl, (kf[2] - 1) / p.wl]; // crystallographic, 1/Å, no 2π
      const R = goniometerMatrix(universal, [p.omega, p.chi, p.phi]);
      const h = mulVec(UBinv, mulVec(transpose(R), q));
      expect(Math.hypot(h[0] - p.h[0], h[1] - p.h[1], h[2] - p.h[2]), `${p.h}`).toBeLessThan(0.15);
    }
  });

  it("predicts each peak's λ, 2θ and azimuth from hkl, UB and the goniometer", () => {
    let worstL = 0;
    let worst2T = 0;
    for (const p of peaks) {
      const R = goniometerMatrix(universal, [p.omega, p.chi, p.phi]);
      const s = laueCondition(qLab(R, ub.UB, p.h, 1));
      worstL = Math.max(worstL, Math.abs(s.lambda - p.wl) / p.wl);
      worst2T = Math.max(worst2T, Math.abs(s.twoTheta - (p.twoTheta * 180) / Math.PI));
      const dAz = Math.abs(((s.azimuth - (p.az * 180) / Math.PI + 540) % 360) - 180);
      expect(dAz, `${p.h}`).toBeLessThan(0.5);
    }
    // Observed worst cases are 0.73 % in λ, 0.43° in 2θ and 0.38° in azimuth: the residuals of
    // the UB fit to these very peaks (TOF calibration, peak centroids), not convention errors,
    // which would put peaks tens of degrees away or on the wrong side of the beam.
    expect(worstL).toBeLessThan(0.01);
    expect(worst2T).toBeLessThan(0.5);
  });
});

describe.skipIf(!existsSync(corelliPath))("garnet-tools corelli_YAG_ub.mat (BSD-3)", () => {
  it("reads a cubic YAG cell (a ≈ 12.0 Å) with a proper-rotation U", () => {
    const f = parseIsawUB(readFileSync(corelliPath, "utf8"));
    const lat = latticeFromUB(f.UB);
    expect(Math.abs(lat.a - lat.b)).toBeLessThan(0.05);
    expect(Math.abs(lat.a - lat.c)).toBeLessThan(0.05);
    expect(lat.a).toBeGreaterThan(11.8);
    expect(lat.a).toBeLessThan(12.2);
    expect(orientationFromUB(f.UB).detU).toBeCloseTo(1, 3);
  });
});
