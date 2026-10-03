/**
 * SNS instrument catalog: goniometers, beams and sources, without detector
 * geometry (that is added by instrumentsSns.ts, loaded with the simulation
 * pages), so the header can list instruments without downloading detectors.
 *
 * Planning follows how each instrument is run: TOPAZ measures about ten chosen
 * orientations (a list), CORELLI rotation scans in 3° steps (rocking or full
 * volume, optionally interleaved), the chopper spectrometers ψ scans; NOMAD and
 * POWGEN have no goniometer (only the counting time is chosen).
 *
 * Goniometers and bands:
 *  - TOPAZ: see instruments.ts (cryogenic ω; ambient ω, φ with χ = 135°), 0.4–3.5 Å.
 *  - CORELLI: one sample rotation ω about the vertical +y axis, counter-clockwise. Mantid sets it
 *    up as Axis0="BL9:Mot:Sample:Axis1,0,1,0,1" (docs/source/algorithms/MDNorm-v1.rst,
 *    SingleCrystalDiffuseReduction-v1.rst; Testing/SystemTests/tests/framework/MDNormCORELLITest.py
 *    @ 67c2f43). The DAS has three such logs, BL9:Mot:Sample:Axis1–3, all (0,1,0,+1), for different
 *    rotation stages: CORELLI scripts use Axis3 alone for some experiments (rosswhitfield/corelli
 *    IPTS-20534/PMN/PMN_5K.py @ d9e4710), NeuXtalViz scans Axis3 with Axis1 and Axis2 at 0
 *    (neutrons/NeuXtalViz-tools src/NeuXtalViz/config/instruments.py @ 655afa3), and garnet-tools
 *    composes all three (src/garnet/config/instruments.py @ 4eb3206). Rotations about one axis
 *    add, so this is a single angle. Band 0.6–2.5 Å (garnet-tools; within ORNL's 10–200 meV
 *    incident-energy range).
 *  - NOMAD (0.1–3 Å, ORNL instrument page) and POWGEN are powder diffractometers: the sample
 *    is fixed (no goniometer axes). POWGEN's band depends on the
 *    choppers: the default is one 60 Hz frame (≈ 3956/(60·63) ≈ 1.05 Å wide for its ~63 m
 *    flight path) centred on 1.066 Å; adjust it to the chopper setting.
 *  - ARCS, SEQUOIA and CNCS are direct-geometry chopper spectrometers: a monochromatic
 *    beam of energy Ei, simulated here for elastic scattering (Bragg peaks at Ei), for single
 *    crystals on a vertical rotation ψ or for powders. Ei ranges and elastic resolution from the
 *    ORNL spec sheets (neutrons.ornl.gov/sites/default/files/{ARCS,SEQUOIA,CNCS}_spec_sheet.pdf,
 *    Dec 2021): ARCS 20–1500 meV (the ARCS web page says 10–1500), 3–5 % Ei; SEQUOIA 4–6000 meV,
 *    1–5 % Ei; CNCS 0.5–80 meV, 10–500 µeV. ψ is counter-clockwise about +y (Mantid sense +1); its
 *    motor log depends on the sample environment (Mantid examples: CCR13VRot on SEQUOIA,
 *    Testing/SystemTests/tests/framework/SNSConvertToMDTest.py; huber on CNCS,
 *    docs/source/algorithms/ConvertMultipleRunsToSingleCrystalMD-v1.rst).
 */
import { neutronWavelengthA } from "../physics/energy.ts";
import { CHI, OMEGA, PHI, type InstrumentPreset } from "./instruments.ts";

/** A catalog entry: an instrument preset without detectors, naming its geometry in src/data/instruments.json. */
export type CatalogEntry = Omit<InstrumentPreset, "detectors" | "l1"> & { readonly geometry: string };

/** Not an instrument: the generic X-ray or neutron beam set in the controls bar. */
export const GENERIC_INSTRUMENT = "generic";

export const SNS_CATALOG: readonly CatalogEntry[] = [
  {
    id: "topaz-cryo",
    modes: ["single-crystal"],
    plan: { kind: "list" },
    label: "TOPAZ · cryogenic (ω)",
    goniometer: { id: "topaz-cryo", label: "TOPAZ cryogenic", axes: [{ ...OMEGA, min: 0, max: 360, log: "BL12:Mot:Gonioc:Omega" }], note: "ω about the vertical +y axis, counter-clockwise (χ = φ = 0)." },
    lambdaMin: 0.4,
    lambdaMax: 3.5,
    geometry: "TOPAZ",
    source: `garnet-tools and NeuXtalViz TOPAZ configs; ORNL TOPAZ specification (0.4–3.5 Å).`,
  },
  {
    id: "topaz-ambient",
    modes: ["single-crystal"],
    plan: { kind: "list" },
    label: "TOPAZ · ambient (ω, φ; χ 135°)",
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
    geometry: "TOPAZ",
    source: `garnet-tools and NeuXtalViz TOPAZ configs; ORNL TOPAZ page (χ fixed at 135°).`,
  },
  {
    id: "corelli",
    modes: ["single-crystal"],
    plan: { kind: "scan", start: 0, end: 357, step: 3 },
    label: "CORELLI (ω)",
    goniometer: {
      id: "corelli",
      label: "CORELLI",
      axes: [{ ...OMEGA, min: 0, max: 360, log: "BL9:Mot:Sample:Axis1 (or Axis2/Axis3, depending on the rotation stage)" }],
      note: "One sample rotation ω about the vertical +y axis, counter-clockwise. The DAS logs it as BL9:Mot:Sample:Axis1, Axis2 or Axis3 depending on the rotation stage in use; all three are vertical, so together they are one angle.",
    },
    lambdaMin: 0.6,
    lambdaMax: 2.5,
    geometry: "CORELLI",
    source: `Mantid CORELLI examples (one vertical axis, BL9:Mot:Sample:Axis1); garnet-tools CORELLI config (0.6–2.5 Å).`,
  },
  {
    id: "nomad",
    modes: ["powder"],
    label: "NOMAD",
    goniometer: { id: "nomad", label: "NOMAD", axes: [], note: "Powder diffractometer: the sample is fixed." },
    lambdaMin: 0.1,
    lambdaMax: 3.0,
    geometry: "NOMAD",
    source: `ORNL NOMAD page (0.1–3 Å, 19.5 m).`,
  },
  {
    id: "powgen",
    modes: ["powder"],
    label: "POWGEN",
    goniometer: { id: "powgen", label: "POWGEN", axes: [], note: "Powder diffractometer: the sample is fixed." },
    lambdaMin: 0.54,
    lambdaMax: 1.59,
    geometry: "POWGEN",
    source: `ORNL POWGEN page (60 m). Band: one 60 Hz frame around 1.066 Å; set it to your chopper setting.`,
  },
  spectrometer("arcs", "ARCS", { eiMeV: 60, eiMin: 20, eiMax: 1500, elasticFwhm: 0.04 }, "ORNL ARCS spec sheet: 13.6 m to the sample, 3.0–3.4 m to the detectors, −28° to 135° horizontal, −27° to 26° vertical; Ei 20–1500 meV, elastic resolution 3–5 % Ei."),
  spectrometer("sequoia", "SEQUOIA", { eiMeV: 60, eiMin: 4, eiMax: 6000, elasticFwhm: 0.03 }, "ORNL SEQUOIA spec sheet: 20.0 m to the sample, 5.5–6.3 m to the detectors, −30° to 60° horizontal, ±18° vertical (rows B–D; the A row reaches −30°); Ei 4–6000 meV, elastic resolution 1–5 % Ei."),
  spectrometer("cncs", "CNCS", { eiMeV: 12, eiMin: 0.5, eiMax: 80, elasticFwhm: 0.02 }, "ORNL CNCS spec sheet: 36.2 m to the sample, 3.5 m to the detectors, ±16° vertical, horizontal −50° to +140° (the current IDF spans −53.6° to 132.6°); Ei 0.5–80 meV, elastic resolution 10–500 µeV."),
];

function spectrometer(id: string, name: string, incident: NonNullable<InstrumentPreset["incident"]>, spec: string): CatalogEntry {
  const lambda = neutronWavelengthA(incident.eiMeV);
  const half = incident.elasticFwhm / 4; // Δλ/λ = ΔE/(2E), split about λ
  return {
    id,
    modes: ["single-crystal", "powder"],
    plan: { kind: "scan", start: -90, end: 90, step: 1 },
    label: name,
    goniometer: { id, label: name, axes: [{ name: "ψ", direction: [0, 1, 0], sense: 1, min: -180, max: 360 }], note: "Single crystals: rotation ψ about the vertical +y axis, counter-clockwise (Mantid sense +1); the motor log depends on the sample environment. Powders: the sample is fixed." },
    lambdaMin: lambda * (1 - half),
    lambdaMax: lambda * (1 + half),
    geometry: name,
    incident,
    source: spec,
  };
}

/** Instruments grouped for menus. */
export const CATALOG_GROUPS: readonly { readonly label: string; readonly list: readonly CatalogEntry[] }[] = [
  { label: "Single-crystal diffractometers", list: SNS_CATALOG.filter((i) => !i.incident && i.modes?.includes("single-crystal")) },
  { label: "Powder diffractometers", list: SNS_CATALOG.filter((i) => !i.incident && i.modes?.includes("powder")) },
  { label: "Chopper spectrometers (elastic)", list: SNS_CATALOG.filter((i) => i.incident) },
];
