/**
 * Goniometer and beam presets, each with its sources.
 *
 * Mantid conventions (mantid @ 67c2f43): beam +z, up +y (ReferenceFrame.cpp:52-54);
 * axis "name,x,y,z,sense" with sense +1 counter-clockwise (SetGoniometer.cpp:51);
 * R = R(axis0)·R(axis1)·R(axis2), axis 0 outermost (Goniometer.cpp:357-365);
 * Q_lab = R·Q_sample (Peak.cpp:503). "Universal" = ω (0,1,0,+1), χ (0,0,1,+1),
 * φ (0,1,0,+1) (Goniometer.cpp:298-302).
 *
 * TOPAZ: logs BL12:Mot:omega/chi/phi map to the Universal axes (neutrons/garnet-tools
 * src/garnet/config/instruments.py:81-85 @ 4eb3206). The ambient goniometer drives ω
 * and φ with χ fixed at 135°; the cryogenic goniometer drives ω only (neutrons/
 * NeuXtalViz-tools src/NeuXtalViz/config/instruments.py:170-186 @ 655afa3; ORNL TOPAZ
 * page). Wavelength band 0.4–3.5 Å (ORNL TOPAZ specification sheet, 2018). L1 =
 * 18.035 m (mantid instrument/TOPAZ_Definition_2022-11-21.xml:26).
 *
 * Validated end to end against Mantid's TOPAZ_3007 peaks (src/core/ub/topaz.test.ts).
 */
import type { DetectorPanel } from "../instrument/detectors.ts";
import type { GoniometerAxis, GoniometerModel } from "./goniometer.ts";

export interface InstrumentPreset {
  readonly id: string;
  readonly label: string;
  readonly goniometer: GoniometerModel;
  /** Default wavelength band (Å). */
  readonly lambdaMin: number;
  readonly lambdaMax: number;
  /** Moderator–sample distance (m), when known. */
  readonly l1?: number;
  readonly source: string;
  /** Detector panels (lab frame, m); absent = every direction counts as detected. */
  readonly detectors?: readonly DetectorPanel[];
  /** Sample kinds the instrument is simulated for: single crystals rotate, powders stay fixed. */
  readonly modes?: readonly ("single-crystal" | "powder")[];
  /**
   * Monochromatic incident beam (direct-geometry chopper spectrometers, elastic
   * line): default and allowed Ei (meV) and the elastic energy resolution ΔE/E (FWHM).
   * Absent = white beam (time-of-flight Laue) over [lambdaMin, lambdaMax].
   */
  readonly incident?: { readonly eiMeV: number; readonly eiMin: number; readonly eiMax: number; readonly elasticFwhm: number };
  /**
   * How a single-crystal measurement is usually planned: a short list of chosen
   * orientations (TOPAZ: about ten, picked for the peaks wanted) or a rotation
   * scan of one axis (CORELLI: rocking or full-volume scans in 3° steps).
   */
  readonly plan?: { readonly kind: "list" } | { readonly kind: "scan"; readonly start: number; readonly end: number; readonly step: number };
  /**
   * Focused banks of a TOF powder diffractometer, as its data are reduced:
   * member panels by IDF component name, and the effective 2θ and L2 Mantid
   * assigns after focusing when known (otherwise the solid-angle-weighted means).
   */
  readonly banks?: { readonly source: string; readonly list: readonly FocusedBankSpec[] };
  /**
   * Standard chopper settings of a white-beam instrument (POWGEN's frames): the
   * band each passes and the d range the reduction keeps (characterisation file).
   */
  readonly frames?: { readonly source: string; readonly list: readonly ChopperFrame[] };
}

export interface ChopperFrame {
  readonly hz: number;
  readonly centre: number;
  readonly lambdaMin: number;
  readonly lambdaMax: number;
  readonly dMin: number;
  readonly dMax: number;
  /** Peak profile of the focused data for this frame: GSAS-II TOF parameters (no Lorentzian), with their file. */
  readonly profile?: { readonly file: string; readonly alpha: number; readonly beta0: number; readonly beta1: number; readonly betaq: number; readonly sig0: number; readonly sig1: number; readonly sig2: number; readonly sigq: number };
}

export interface FocusedBankSpec {
  readonly name: string;
  readonly panels: readonly string[];
  readonly twoThetaDeg?: number;
  readonly l2?: number;
  /** Calibrated DIFC (µs/Å) of the focused bank, when published; otherwise from L1 + L2 and 2θ. */
  readonly difc?: number;
  /** Measured resolution Δd/d (FWHM) of the bank. */
  readonly dOverD?: number;
}

export const OMEGA: GoniometerAxis = { name: "ω", direction: [0, 1, 0], sense: 1, min: -180, max: 360 };
export const CHI: GoniometerAxis = { name: "χ", direction: [0, 0, 1], sense: 1, min: -180, max: 180 };
export const PHI: GoniometerAxis = { name: "φ", direction: [0, 1, 0], sense: 1, min: -180, max: 360 };

export const UNIVERSAL: GoniometerModel = {
  id: "universal",
  label: "Eulerian ω, χ, φ (Mantid Universal)",
  axes: [OMEGA, CHI, PHI],
  note: "R = R_y(ω)·R_z(χ)·R_y(φ), counter-clockwise; beam +z, up +y.",
};
