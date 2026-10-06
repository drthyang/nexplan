/**
 * Instrumental Q resolution as a covariance (Å⁻², Q = 2π|q|) for a detector direction and wavelength.
 *
 * Form (A. D. Stoica, Acta Cryst. A31, 193–196 (1975); J. B. Forsyth, in Chemical Crystallography with Pulsed
 * Neutrons and Synchrotron X-rays, eds. Carrondo & Jeffrey, Springer Netherlands (1988), pp. 117–135; the mosaic term is the
 * small-rotation result δQ = δω × Q), as ORNL's garnet-tools models single-crystal
 * peak shapes (neutrons/garnet-tools @ 4eb3206, src/garnet/reduction/resolution.py `_model_design_lab`,
 * BSD-3-Clause):
 *
 *   Σ = k²·[σ_γi(λ)²·γ̂iγ̂iᵀ + σ_νi(λ)²·ν̂iν̂iᵀ + σ_γf²·γ̂fγ̂fᵀ + σ_νf²·ν̂fν̂fᵀ + (σ_dl² + σ_dlb²/λ²)·qqᵀ] + η²·(Q²I − QQᵀ)
 *
 * with k = 2π/λ, q = k̂_f − k̂_i (so k·q = Q), γ̂i = x̂ and ν̂i = ŷ (incident divergence, horizontal and vertical),
 * γ̂f = (z, 0, −x) and ν̂f = (−xy, ρ², −yz)/ρ for k̂_f = (x, y, z), ρ = √(x² + z²) (the outgoing angles γ, ν of the
 * detector map), and an incident divergence that grows with λ until the guide saturates:
 * σ(λ) = σ·x/(1 + x^p)^(1/p), x = λ/λ₀. η is the sample mosaic (isotropic).
 *
 * The parameters for TOPAZ and CORELLI are garnet-tools' fits to measured peak shapes (config/instruments.py
 * DivergenceParams): ORNL's working model, not a published one. They are in degrees and on garnet's 99.7 %
 * containment scale, so a Gaussian σ is the value divided by √χ²₃(0.997) = 3.7325; the fitted mosaic of the
 * calibration crystal is left out, and the sample's is an input.
 *
 * Chopper spectrometers (`directCovariance`) have no published Q resolution. The estimate there is geometric: the
 * outgoing angle from the pixel and the sample over L2, an incident divergence if given, and the energy resolution
 * (pychop.ts) as a spread of k_f along k̂_f.
 */
import type { Mat3, Vec3 } from "@materia/core/math/types";

export const FWHM_PER_SIGMA = 2 * Math.sqrt(2 * Math.LN2);
const CONTAINMENT = 3.7324821051831023; // √χ²₃(0.997): scipy chi2.ppf(0.997, 3) = 13.9314227
const DEG = Math.PI / 180;

/** Gaussian σ of each term: angles in radians, σ_λ/λ dimensionless. */
export interface WhiteBeamResolution {
  readonly gammaI: number;
  readonly nuI: number;
  readonly lambda0GammaI: number;
  readonly lambda0NuI: number;
  readonly saturation: number;
  readonly gammaF: number;
  readonly nuF: number;
  readonly dl: number;
  readonly dlB: number;
}

/** garnet-tools DivergenceParams (degrees; σ_dl dimensionless), converted to Gaussian σ (radians). */
function fromGarnet(p: { gammaI: number; nuI: number; gammaF: number; nuF: number; dl: number; dlB: number; lambda0GammaI: number; lambda0NuI: number; q: number }): WhiteBeamResolution {
  return {
    gammaI: (p.gammaI * DEG) / CONTAINMENT,
    nuI: (p.nuI * DEG) / CONTAINMENT,
    gammaF: (p.gammaF * DEG) / CONTAINMENT,
    nuF: (p.nuF * DEG) / CONTAINMENT,
    dl: p.dl / CONTAINMENT,
    dlB: p.dlB / CONTAINMENT,
    lambda0GammaI: p.lambda0GammaI,
    lambda0NuI: p.lambda0NuI,
    saturation: p.q,
  };
}

/** garnet-tools @ 4eb3206, src/garnet/config/instruments.py, "DivergenceParams" for TOPAZ and CORELLI. */
export const GARNET_RESOLUTION: Readonly<Record<"TOPAZ" | "CORELLI", WhiteBeamResolution>> = {
  TOPAZ: fromGarnet({ gammaI: 1.131783, nuI: 1.148514, gammaF: 0.434934, nuF: 0.4667606, dl: 4.483816e-10, dlB: 0.003033906, lambda0GammaI: 0.8138951, lambda0NuI: 0.7602293, q: 11.21217 }),
  CORELLI: fromGarnet({ gammaI: 0.8005434, nuI: 1.044429, gammaF: 0.3397237, nuF: 0.3724028, dl: 0.007689985, dlB: 0.01551783, lambda0GammaI: 1.183729, lambda0NuI: 1.32463, q: 5.10228 }),
};

const outer = (a: Vec3, s: number, out: number[]) => {
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[3 * i + j]! += s * a[i]! * a[j]!;
};
const toMat = (m: number[]): Mat3 => [
  [m[0]!, m[1]!, m[2]!],
  [m[3]!, m[4]!, m[5]!],
  [m[6]!, m[7]!, m[8]!],
];

/** Outgoing-angle directions γ̂f, ν̂f for a unit k̂_f (garnet's convention: γ̂f is d k̂_f/dγ divided by cos ν). */
function outgoing(u: Vec3): [Vec3, Vec3] {
  const [x, y, z] = u;
  const rho = Math.hypot(x, z);
  return [
    [z, 0, -x],
    [(-x * y) / rho, rho, (-y * z) / rho],
  ];
}

/** Isotropic mosaic η (Gaussian σ, rad) about Q: η²·(Q²I − QQᵀ). */
function addMosaic(m: number[], Q: Vec3, eta: number) {
  if (!eta) return;
  const q2 = Q[0] ** 2 + Q[1] ** 2 + Q[2] ** 2;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[3 * i + j]! += eta ** 2 * ((i === j ? q2 : 0) - Q[i]! * Q[j]!);
}

/** White-beam (TOF Laue) covariance of Q (Å⁻², lab frame) for unit k̂_f `u` at wavelength λ (Å); `mosaic` a Gaussian σ (rad). */
export function whiteBeamCovariance(u: Vec3, lambda: number, p: WhiteBeamResolution, mosaic = 0): Mat3 {
  const k = (2 * Math.PI) / lambda;
  const sat = (l0: number) => {
    const x = lambda / l0;
    return x / (1 + x ** p.saturation) ** (1 / p.saturation);
  };
  const q: Vec3 = [u[0], u[1], u[2] - 1];
  const [gf, nf] = outgoing(u);
  const m = new Array<number>(9).fill(0);
  outer([1, 0, 0], k ** 2 * (p.gammaI * sat(p.lambda0GammaI)) ** 2, m);
  outer([0, 1, 0], k ** 2 * (p.nuI * sat(p.lambda0NuI)) ** 2, m);
  outer(gf, k ** 2 * p.gammaF ** 2, m);
  outer(nf, k ** 2 * p.nuF ** 2, m);
  outer(q, k ** 2 * (p.dl ** 2 + p.dlB ** 2 / lambda ** 2), m);
  addMosaic(m, [k * q[0], k * q[1], k * q[2]], mosaic);
  return toMat(m);
}

/**
 * Chopper-spectrometer estimate (Å⁻², lab frame): incident k_i along ẑ with divergence `incident` (Gaussian σ, rad,
 * both directions), outgoing k_f along `u` with angular σ `outH`, `outV` (rad), and the energy resolution as a spread
 * σ_E (meV) of |k_f| = √(0.482596·E_f) (Å⁻¹).
 */
export function directCovariance(u: Vec3, ki: number, kf: number, sigmaE: number, outH: number, outV: number, incident: number, mosaic = 0): Mat3 {
  // outH and outV are physical angles (pixel and sample sizes over L2), so both directions are unit vectors here;
  // garnet's γ̂f, of length cos ν, belongs to an uncertainty in the coordinate γ.
  const [g, nf] = outgoing(u);
  const rho = Math.hypot(u[0], u[2]);
  const gf: Vec3 = [g[0] / rho, g[1] / rho, g[2] / rho];
  const m = new Array<number>(9).fill(0);
  outer([1, 0, 0], ki ** 2 * incident ** 2, m);
  outer([0, 1, 0], ki ** 2 * incident ** 2, m);
  outer(gf, kf ** 2 * outH ** 2, m);
  outer(nf, kf ** 2 * outV ** 2, m);
  // dk_f/dE = 0.482596/(2 k_f): the energy spread moves k_f along its own direction.
  outer(u, ((0.482596 / (2 * kf)) * sigmaE) ** 2, m);
  addMosaic(m, [kf * u[0], kf * u[1], kf * u[2] - ki], mosaic);
  return toMat(m);
}

/** FWHM (Å⁻¹) of a Q covariance along a unit direction. */
export function fwhmAlong(S: Mat3, e: Vec3): number {
  let v = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) v += e[i]! * S[i]![j]! * e[j]!;
  return FWHM_PER_SIGMA * Math.sqrt(Math.max(0, v));
}
