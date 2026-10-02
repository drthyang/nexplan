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
 * 18.035 m (mantid instrument/TOPAZ_Definition_2022-11-21.xml:27).
 *
 * Validated end to end against Mantid's TOPAZ_3007 peaks (src/core/ub/topaz.test.ts).
 */
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
}

const OMEGA: GoniometerAxis = { name: "ω", direction: [0, 1, 0], sense: 1, min: -180, max: 360 };
const CHI: GoniometerAxis = { name: "χ", direction: [0, 0, 1], sense: 1, min: -180, max: 180 };
const PHI: GoniometerAxis = { name: "φ", direction: [0, 1, 0], sense: 1, min: -180, max: 360 };

export const UNIVERSAL: GoniometerModel = {
  id: "universal",
  label: "Eulerian ω, χ, φ (Mantid Universal)",
  axes: [OMEGA, CHI, PHI],
  note: "R = R_y(ω)·R_z(χ)·R_y(φ), counter-clockwise; beam +z, up +y.",
};

export const INSTRUMENTS: readonly InstrumentPreset[] = [
  {
    id: "topaz-cryo",
    label: "TOPAZ · cryogenic goniometer (ω)",
    goniometer: {
      id: "topaz-cryo",
      label: "TOPAZ cryogenic",
      axes: [{ ...OMEGA, min: 0, max: 360, log: "BL12:Mot:Gonioc:Omega" }],
      note: "ω about the vertical +y axis, counter-clockwise (χ = φ = 0).",
    },
    lambdaMin: 0.4,
    lambdaMax: 3.5,
    l1: 18.035,
    source: "garnet-tools and NeuXtalViz TOPAZ configs; ORNL TOPAZ specification (0.4–3.5 Å); Mantid TOPAZ IDF (L1).",
  },
  {
    id: "topaz-ambient",
    label: "TOPAZ · ambient goniometer (ω, φ; χ = 135°)",
    goniometer: {
      id: "topaz-ambient",
      label: "TOPAZ ambient",
      axes: [
        { ...OMEGA, min: 0, max: 360, log: "BL12:Mot:omega" },
        { ...CHI, fixed: 135, log: "BL12:Mot:chi" },
        { ...PHI, min: 0, max: 360, log: "BL12:Mot:phi" },
      ],
      note: "Mantid Universal axes with χ fixed at 135°.",
    },
    lambdaMin: 0.4,
    lambdaMax: 3.5,
    l1: 18.035,
    source: "garnet-tools and NeuXtalViz TOPAZ configs; ORNL TOPAZ page (χ fixed at 135°); ORNL specification (0.4–3.5 Å).",
  },
  {
    id: "universal",
    label: "Eulerian ω, χ, φ (Mantid Universal)",
    goniometer: UNIVERSAL,
    lambdaMin: 0.4,
    lambdaMax: 3.5,
    source: "Mantid Goniometer::makeUniversalGoniometer.",
  },
];
