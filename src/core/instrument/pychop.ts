/**
 * Energy resolution of the SNS direct-geometry chopper spectrometers (ARCS, SEQUOIA, CNCS): a port of the
 * closed-form model in Mantid's PyChop (scripts/pychop @ 67c2f43, GPL-3.0-or-later; CHOP by T. G. Perring, the
 * Python port by R. A. Ewings after J. W. Taylor's Matlab version, MulpyRep by D. J. Voneshen after R. I. Bewley;
 * the theory, as Chop.py cites it: Carlile, Taylor & Williams, RAL-85-052; Perring, PhD thesis, University of
 * Cambridge (1991); Perring, RAL-94-025, ICANS XII (1993)): Instruments.py getVanVar and getResolution, and
 * Chop.py tikeda (Ikeda–Carpenter moderator), tchop (Fermi chopper), tube_mts (³He tube absorption depth) and sam0
 * (sample). Instrument parameters are those of arcs.yaml, sequoia.yaml (tuned to ORNL vanadium data, mantid
 * PR #38591) and cncs.yaml at that commit.
 *
 * This file is a derivative of PyChop and stays under GPL-3.0-or-later (combined with NEXPLAN's AGPL-3.0 code as
 * GPL v3 section 13 permits): Copyright © 2018 ISIS Rutherford Appleton Laboratory UKRI, NScD Oak Ridge National
 * Laboratory, European Spallation Source, Institut Laue - Langevin & CSNS, Institute of High Energy Physics, CAS.
 * See THIRD_PARTY_NOTICES.md.
 *
 * The result is the Gaussian-equivalent FWHM (meV) of the incoherent elastic line at energy transfer E: time
 * widths at the moderator, the chopper(s), the aperture, the sample and the detector, propagated to the
 * detector (PyChop's Theory section). Tested against PyChop's own output over a grid of settings
 * (fixtures/pychop-resolution.json, scripts/data/gen_pychop_reference.py).
 */

const S2F2 = 8 * Math.LN2; // variance → FWHM²
const E2V = 437.393377; // neutron speed (m/s) per √meV
const E2K = 0.482596; // k² (Å⁻², with 2π) per meV

export type FermiInstrument = "arcs" | "sequoia";
export type CncsMode = "High Flux" | "Intermediate" | "High Resolution";

/** Fermi chopper packages: slit width, rotor radius and slat curvature radius (m). */
export const FERMI_PACKAGES: Record<FermiInstrument, Readonly<Record<string, { readonly slit: number; readonly radius: number; readonly rho: number; readonly label: string }>>> = {
  arcs: {
    "ARCS-100-1.5-AST": { slit: 1.52e-3, radius: 0.05, rho: 0.58, label: "100 meV, 1.5 mm (resolution)" },
    "ARCS-700-1.5-AST": { slit: 1.52e-3, radius: 0.05, rho: 1.535, label: "700 meV, 1.5 mm (flux)" },
    "ARCS-700-0.5-AST": { slit: 0.51e-3, radius: 0.05, rho: 1.535, label: "700 meV, 0.5 mm (fine)" },
  },
  sequoia: {
    "SEQ-100-2.0-AST": { slit: 2.03e-3, radius: 0.05, rho: 0.58, label: "100 meV, 2.0 mm (resolution)" },
    "SEQ-700-3.5-AST": { slit: 4.56e-3, radius: 0.05, rho: 1.535, label: "700 meV, 3.5 mm (flux)" },
    "SEQ-1000-1.5-AST": { slit: 1.524e-3, radius: 0.05, rho: 1.8345, label: "1000 meV, 1.5 mm (fine)" },
    "ARCS-700-0.5-AST": { slit: 0.51e-3, radius: 0.05, rho: 1.535, label: "700 meV, 0.5 mm (fine, ARCS rotor)" },
  },
};

/** Final-chopper frequencies (Hz) PyChop's interface offers: multiples of 60 up to the maximum. */
export const FREQUENCIES: Record<FermiInstrument | "cncs", readonly number[]> = {
  arcs: [60, 120, 180, 240, 300, 360, 420, 480, 540, 600],
  sequoia: [60, 120, 180, 240, 300, 360, 420, 480, 540, 600],
  cncs: [60, 120, 180, 240, 300],
};

interface Geometry {
  /** Moderator (or pulse-shaping chopper) to final chopper, aperture to final chopper, chopper to sample, sample to detector (m). */
  readonly x0: number;
  readonly xa: number;
  readonly x1: number;
  readonly x2: number;
  /** Aperture width (m), moderator face angle (deg), sample thickness along the beam (m) and its shape factor, detector angle (deg). */
  readonly aperture: number;
  readonly thetaM: number;
  readonly sy: number;
  readonly sampleShape: number;
  readonly phi: number;
}

const FERMI_GEOMETRY: Record<FermiInstrument, Geometry & { readonly ikeda: readonly [number, number, number, number, number] }> = {
  // Plate sample (isam 0): uniform thickness, variance sy²/12.
  arcs: { x0: 11.61, xa: 9.342, x1: 2.0, x2: 3.0, aperture: 0.1751, thetaM: -13.75, sy: 0.048, sampleShape: 1 / 12, phi: 0, ikeda: [281.0, 79.0, 0.087, 0.4, 172.0] },
  // Annular can (isam 2): variance sy²/8.
  sequoia: { x0: 18.01, xa: 17.0, x1: 2.0, x2: 5.5, aperture: 0.05, thetaM: -13.75, sy: 0.048, sampleShape: 1 / 8, phi: 0, ikeda: [30.13, 10.0, 0.07, 0.08, 50.42] },
};

/** CNCS moderator pulse FWHM (µs) against wavelength (Å), cncs.yaml measured_width (from a moderator simulation). */
const CNCS_LAMBDA = [
  0.90445614, 0.97050943, 1.04138664, 1.11744009, 1.19904779, 1.28661538, 1.38057811, 1.48140303, 1.58959128, 1.70568063, 1.83024809, 1.96391283, 2.10733923, 2.2612402, 2.42638069, 2.60358156, 2.79372357, 2.99775183, 3.21668046,
  3.45159766, 3.70367109, 3.97415367, 4.26438985, 4.57582225, 4.90999885, 5.26858069, 5.65335009, 6.06621956, 6.50924128, 6.9846173, 7.49471047, 8.04205622, 8.62937515, 9.25958654, 9.93582285, 10.66144534, 11.44006072, 12.27553911,
  13.17203328, 14.13399926, 15.16621852, 16.27382172, 17.46231422, 18.73760346, 20.10602826, 21.57439041, 23.14998844, 24.84065387, 26.65479018, 28.60141458,
];
const CNCS_WIDTH = [
  11.29, 12.85, 14.77, 17.17, 20.19, 23.98, 28.75, 34.74, 42.13, 51.03, 61.31, 72.47, 83.71, 94.24, 103.81, 112.68, 121.38, 130.4, 139.97, 150.08, 160.57, 171.24, 181.89, 192.43, 202.77, 212.97, 223.05, 233.12, 243.24, 253.48, 263.89,
  274.45, 285.14, 295.86, 306.49, 316.87, 326.81, 336.06, 344.4, 351.6, 357.47, 361.86, 364.71, 366.0, 365.84, 364.36, 361.74, 358.23, 354.02, 349.37,
];

/** CNCS double-disk (chopper 4) slot widths per mode (mm); cncs.yaml variants. */
export const CNCS_SLOTS: Record<CncsMode, number> = { "High Flux": 110, Intermediate: 32, "High Resolution": 9.86 };

/** Chebyshev series on [a, b] (Numerical Recipes CHEBEV, as Chop.chbmts). */
function chebyshev(a: number, b: number, c: readonly number[], x: number): number {
  let d = 0;
  let dd = 0;
  const y = (2 * x - a - b) / (b - a);
  for (let j = c.length - 1; j > 0; j--) {
    const sv = d;
    d = 2 * y * d - dd + c[j]!;
    dd = sv;
  }
  return y * d - dd + 0.5 * c[0]!;
}

// Chop.tube_mts (T. G. Perring): variance of the absorption depth across a ³He tube, in units of its radius².
const VX_F = [
  1.22690458305819, -0.3621914072547197, 6.0117947617747081e-2, 1.8037337764424607e-2, -1.4439005957980123e-2, 3.8147446724517908e-3, 1.3679160269450818e-5, -3.7851338401354573e-4, 1.3568342238781006e-4, -1.3336183765173537e-5,
  -7.5468390663036011e-6, 3.791958086930558e-6, -6.4560788919254541e-7, -1.0509789897250599e-7, 9.0282233408123247e-8, -2.1598200223849062e-8, -2.620075012504941e-10, 1.869327004300203e-9, -6.0097600840247623e-10,
  4.726319668968415e-11, 3.3052446335446462e-11, -1.4738090470256537e-11, 2.194517623177461e-12, 4.7409048908875206e-13, -3.3502478569147342e-13,
];
const VX_G = [
  1.862646413811875, 7.5988886169808666e-2, -8.3110620384910993e-3, 1.1236935254690805e-3, -1.0549380723194779e-4, -3.8256672783453238e-5, 2.2883355513325654e-5, -2.459551544851113e-6, -2.2063956882489855e-6, 7.2331970290773207e-7,
  2.2080170614557915e-7, -1.2957057474505262e-7, -2.9737380539129887e-8, 2.2171316129693253e-8, 5.9127004825576534e-9, -3.7179338302495424e-9, -1.4794271269158443e-9, 5.5412448241032308e-10, 3.8726354734119894e-10,
  -4.656241392453353e-11, -9.2734525614091013e-11, -1.1246343578630302e-11, 1.6909724176450425e-11, 5.6146245985821963e-12, -2.7408274955176282e-12,
];

function tubeDepthVariance(alf: number): number {
  const g0 = (32 - 3 * Math.PI ** 2) / 48;
  const g1 = 14 / 3 - Math.PI ** 2 / 8;
  const f = () => 0.25 * chebyshev(0, 10, VX_F, alf);
  const g = () => g0 + (g1 * chebyshev(-1, 1, VX_G, 1 - 18 / alf)) / alf ** 2;
  if (alf <= 9) return f();
  if (alf >= 10) return g();
  return (10 - alf) * f() + (alf - 9) * g();
}

/** Detector term (s², FWHM²): the spread of absorption depth in a 25 mm ³He tube at 10 atm, over v_f². */
function detectorTerm(kf: number, vf: number): number {
  const reff = (0.025 / 2) * (1 - 0.063);
  const alf = (2 * reff * ((143.23 * 3.49416) / 10) * 10) / kf;
  return (tubeDepthVariance(alf) * reff ** 2 * S2F2) / vf ** 2;
}

/** Ikeda–Carpenter moderator pulse variance (s²), Chop.tikeda. */
function ikeda([S1, S2, B1, B2, Emod]: readonly number[], ei: number): number {
  const sig = Math.sqrt(S1! ** 2 + (S2! ** 2 * 81.8048) / ei);
  const A = 4.37392e-4 * sig * Math.sqrt(ei);
  const B = ei <= 130 ? B1! : B2!;
  const R = Math.exp(-ei / Emod!);
  return (3 / A ** 2 + (R * (2 - R)) / B ** 2) * 1e-12;
}

/** Fermi chopper opening-time variance (s²), Chop.tchop; undefined when the chopper does not transmit (γ ≥ 4). */
function fermiTime(p: number, R: number, rho: number, f: number, ei: number): number | undefined {
  const w = 2 * Math.PI * f;
  const v = 437.392 * Math.sqrt(ei);
  const g = ((2 * R ** 2) / p) * Math.abs(1 / rho - (2 * w) / v);
  if (g >= 4) return undefined;
  const gs = g <= 1 ? (1 - g ** 4 / 10) / (1 - g ** 2 / 6) : (0.6 * g * (Math.sqrt(g) - 2) ** 2 * (Math.sqrt(g) + 8)) / (Math.sqrt(g) + 4);
  return ((p / (2 * R * w)) ** 2 / 6) * gs;
}

/** Instruments.getVanVar and getResolution: the propagated FWHM (meV) from the moderator and chopper FWHM² (s²). */
function propagate(ei: number, transfer: number, tmod2: number, tchop2: number, g: Geometry, frequency: number): number {
  const om = 2 * Math.PI * frequency;
  const vi = E2V * Math.sqrt(ei);
  const vf = E2V * Math.sqrt(ei - transfer);
  const r = (vi / vf) ** 3;
  const t = Math.tan((g.thetaM * Math.PI) / 180);
  const norm = om * (g.xa + g.x1);
  const g1 = (1 - ((om * t) / vi) * (g.xa + g.x1)) / norm;
  const g2 = (1 - ((om * t) / vi) * (g.x0 - g.xa)) / norm;
  const f1 = (1 + (g.x1 / g.x0) * (1 - ((om * t) / vi) * (g.xa + g.x1))) / norm;
  const f2 = (1 + (g.x1 / g.x0) * (1 - ((om * t) / vi) * (g.x0 - g.xa))) / norm;
  const modfac = (g.x1 + r * g.x2) / g.x0;
  const chpfac = 1 + modfac;
  const apefac = f1 + ((r * g.x2) / g.x0) * g1;
  let v = tmod2 * modfac ** 2 + tchop2 * chpfac ** 2 + ((apefac ** 2 * g.aperture ** 2) / 12) * S2F2;
  v += detectorTerm(Math.sqrt(E2K * (ei - transfer)), vf);
  const samfac = -Math.sin((g.phi * Math.PI) / 180) / vf - f2 - ((r * g.x2) / g.x0) * g2;
  v += samfac ** 2 * g.sy ** 2 * g.sampleShape * S2F2;
  const ef = ei - transfer;
  return (2 * E2V * Math.sqrt(ef ** 3 * v)) / g.x2;
}

export type ChopperSetting = { readonly instrument: FermiInstrument; readonly package: string; readonly frequency: number } | { readonly instrument: "cncs"; readonly mode: CncsMode; readonly frequency: number };

/**
 * Energy resolution, FWHM (meV), at incident energy `ei` and energy transfer `transfer` (meV, < ei); undefined
 * when the chopper does not transmit at this energy and frequency.
 */
export function energyResolution(setting: ChopperSetting, ei: number, transfer = 0): number | undefined {
  if (!(transfer < ei) || !(ei > 0)) return undefined;
  if (setting.instrument === "cncs") {
    const lambda = Math.sqrt(81.8042 / ei);
    // Moderator FWHM from the table (linear in λ, held at its ends), seen through the pulse-shaping chopper.
    let k = 0;
    while (k < CNCS_LAMBDA.length - 2 && CNCS_LAMBDA[k + 1]! < lambda) k++;
    const l = Math.min(Math.max(lambda, CNCS_LAMBDA[0]!), CNCS_LAMBDA.at(-1)!);
    const tm = (CNCS_WIDTH[k]! + ((CNCS_WIDTH[k + 1]! - CNCS_WIDTH[k]!) * (l - CNCS_LAMBDA[k]!)) / (CNCS_LAMBDA[k + 1]! - CNCS_LAMBDA[k]!)) * 1e-6;
    const x0 = 34.785;
    const xm = 6.413;
    // Opening FWHM (s) of the final double disk (radius 282.5 mm, two counter-rotating disks, 12 mm guide) and of chopper 1 (60 Hz).
    const t4 = (CNCS_SLOTS[setting.mode] + 12) / (2 * Math.PI * 282.5 * 2 * setting.frequency) / 2;
    const t1 = (20 + 2) / (2 * Math.PI * 20 * 1 * 60) / 2;
    const tmod2 = Math.min(t1 ** 2, (tm * (1 - xm / x0)) ** 2);
    return propagate(ei, transfer, tmod2, t4 ** 2, { x0: x0 - xm, xa: x0, x1: 1.48, x2: 3.5, aperture: 0, thetaM: 32, sy: 0.01, sampleShape: 1 / 8, phi: 60 }, setting.frequency);
  }
  const geo = FERMI_GEOMETRY[setting.instrument];
  const pk = FERMI_PACKAGES[setting.instrument][setting.package];
  if (!pk) return undefined;
  const tc = fermiTime(pk.slit, pk.radius, pk.rho, setting.frequency, ei);
  if (tc === undefined) return undefined;
  return propagate(ei, transfer, ikeda(geo.ikeda, ei) * S2F2, tc * S2F2, geo, setting.frequency);
}
