import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Vec3 } from "@materia/core/math/types";
import { directCovariance, FWHM_PER_SIGMA, fwhmAlong, GARNET_RESOLUTION, whiteBeamCovariance } from "./qResolution.ts";

const DEG = Math.PI / 180;
const reference = JSON.parse(readFileSync(new URL("../../../fixtures/qres-garnet.json", import.meta.url), "utf8")) as {
  rows: { instrument: "TOPAZ" | "CORELLI"; twoTheta: number; phi: number; lambda: number; covariance: number[][] }[];
};
const kfOf = (tt: number, phi: number): Vec3 => [Math.sin(tt * DEG) * Math.cos(phi * DEG), Math.sin(tt * DEG) * Math.sin(phi * DEG), Math.cos(tt * DEG)];
/** Radial (along Q), in-plane transverse and vertical unit directions of a reflection. */
function frame(u: Vec3): Vec3[] {
  const n = (v: Vec3): Vec3 => {
    const l = Math.hypot(...v);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const r = n([u[0], u[1], u[2] - 1]);
  const t = n([u[0], u[1], u[2] + 1]);
  return [r, t, [r[1] * t[2] - r[2] * t[1], r[2] * t[0] - r[0] * t[2], r[0] * t[1] - r[1] * t[0]]];
}

describe("Q resolution: garnet-tools' model for TOPAZ and CORELLI", () => {
  it("equals garnet-tools' own covariance (4eb3206, its code run on the pinned file) element by element", () => {
    expect(reference.rows.length).toBe(280);
    for (const r of reference.rows) {
      const S = whiteBeamCovariance(kfOf(r.twoTheta, r.phi), r.lambda, GARNET_RESOLUTION[r.instrument]);
      const scale = r.covariance[0]![0]! + r.covariance[1]![1]! + r.covariance[2]![2]!;
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(Math.abs(S[i]![j]! - r.covariance[i]![j]!)).toBeLessThan(1e-9 * scale);
    }
  });

  it("TOPAZ at 2θ = 90°, λ = 1 Å: FWHM about 0.06 Å⁻¹ radially and 0.09 Å⁻¹ vertically; sharper radially in backscattering", () => {
    const u = kfOf(90, 0);
    const [r, t, v] = frame(u).map((e) => fwhmAlong(whiteBeamCovariance(u, 1, GARNET_RESOLUTION.TOPAZ), e));
    expect(r).toBeCloseTo(0.0613, 3);
    expect(t).toBeCloseTo(0.0589, 3);
    expect(v).toBeCloseTo(0.0855, 3);
    const back = kfOf(150, 0);
    const rb = fwhmAlong(whiteBeamCovariance(back, 2, GARNET_RESOLUTION.TOPAZ), frame(back)[0]!);
    const qb = 2 * ((2 * Math.PI) / 2) * Math.sin(75 * DEG);
    // ORNL quotes Δd/d > 0.4 %: reached in backscattering.
    expect(rb / qb).toBeLessThan(0.004);
  });

  it("mosaic widens only across Q, by Q·η", () => {
    const u = kfOf(90, 30);
    const eta = (0.5 * DEG) / FWHM_PER_SIGMA;
    const plain = whiteBeamCovariance(u, 1.5, GARNET_RESOLUTION.CORELLI);
    const mosaic = whiteBeamCovariance(u, 1.5, GARNET_RESOLUTION.CORELLI, eta);
    const [r, t, v] = frame(u);
    const Q = 2 * ((2 * Math.PI) / 1.5) * Math.sin(45 * DEG);
    expect(fwhmAlong(mosaic, r!)).toBeCloseTo(fwhmAlong(plain, r!), 12);
    expect(fwhmAlong(mosaic, t!) ** 2 - fwhmAlong(plain, t!) ** 2).toBeCloseTo((Q * 0.5 * DEG) ** 2, 8);
    expect(fwhmAlong(mosaic, v!) ** 2 - fwhmAlong(plain, v!) ** 2).toBeCloseTo((Q * 0.5 * DEG) ** 2, 8);
  });

  it("chopper spectrometers (estimate): the energy term lies along k_f with σ_kf = 0.482596·σ_E/(2k_f)", () => {
    const u = kfOf(60, 0);
    const S = directCovariance(u, 3, 2.5, 0.2, 0, 0, 0);
    expect(fwhmAlong(S, u) / FWHM_PER_SIGMA).toBeCloseTo((0.482596 * 0.2) / (2 * 2.5), 10);
    expect(fwhmAlong(S, [0, 1, 0])).toBeCloseTo(0, 12);
  });

  it("chopper spectrometers (estimate): the outgoing angular spreads are physical angles, k_f·σ in Q at any elevation", () => {
    // Out of the horizontal plane (azimuth up to 27° at 2θ = 70°) the horizontal spread is still k_f·σ_H, not
    // k_f·σ_H·cos ν with ν the elevation of k_f.
    for (const nu of [0, 16, 27]) {
      const u = kfOf(70, nu);
      const S = directCovariance(u, 3, 2.5, 0, 0.004, 0.002, 0);
      const h = [u[2], 0, -u[0]].map((v) => v / Math.hypot(u[0], u[2])) as unknown as Vec3; // horizontal, ⟂ k_f
      const v = [-u[0] * u[1], u[0] ** 2 + u[2] ** 2, -u[1] * u[2]].map((x) => x / Math.hypot(u[0], u[2])) as unknown as Vec3; // ⟂ both
      expect(fwhmAlong(S, h) / FWHM_PER_SIGMA, `azimuth ${nu}°`).toBeCloseTo(2.5 * 0.004, 12);
      expect(fwhmAlong(S, v) / FWHM_PER_SIGMA, `azimuth ${nu}°`).toBeCloseTo(2.5 * 0.002, 12);
    }
  });
});
