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
 *    choppers: the default is the 60 Hz frame centred on 1.5 Å (0.967–2.033 Å, about
 *    3956/(60·63) ≈ 1.05 Å wide for its ~63 m flight path); the bar offers the standard frames.
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
    banks: {
      source:
        "Numbering: banks 0–5, as Mantid numbers the focused spectra (workspace index) and as the autoreduction's TOPAS files are named (SaveFocusedXYE, StartAtBankNumber = 0: …-0.xye to …-5.xye; mantid_total_scattering @ 1b93684). GSAS files, ADDIE and ORNL's tables number the same banks 1–6, in the same order: GSAS bank n is bank n − 1 here. Groups: banks 0–5 are the IDF assemblies Group1–Group6 (Mantid NOMAD_Definition.xml @ 67c2f43; CreateGroupingWorkspace GroupDetectorsBy='Group'; mantid utils/nomad/diagnostics.py: PANEL_COUNT = 6). Geometry: ORNL's NOMAD GSAS-II instrument file for 2023A (NOMAD_2023A_five_banks_Shifter_Si_640e_instrument_file.instprm, sha256 78b6a260…ee3d3, from neutrons.ornl.gov/nomad/users), whose banks 1–5 are banks 0–4 here: banks 1–4 at 2θ 31, 65, 120.4, 150.1° with flight paths 21.18, 20.66, 20.61, 20.29 m (L1 19.5 m) and their calibrated DIFC; bank 0's DIFC 1439.6 (its angle and path in the file are placeholders, so 15° is nominal); bank 5 is not in the file (left out for poor resolution), so its 7° and L2 are nominal and geometric. Resolution: the measured Δd/d (FWHM) per bank in ORNL's NOMAD overview (neutrons.ornl.gov/sites/default/files/NOMAD-Overview.pdf, slide 5, 2014, its banks 1–6: 0.029, 0.019, 0.0137, 0.0069, 0.0036, 0.039; slide 3 notes that 50 of the 99 eight-packs were installed then), consistent with the 2023A GSAS-II profiles. Calibrations can also exclude packs, which is not modelled.",
      list: [
        { name: "Bank 0", panels: range(1, 14), twoThetaDeg: 15, difc: 1439.612, dOverD: 0.029 },
        { name: "Bank 1", panels: range(15, 37), twoThetaDeg: 31, l2: 1.68, difc: 2851.105, dOverD: 0.019 },
        { name: "Bank 2", panels: range(38, 51), twoThetaDeg: 65, l2: 1.16, difc: 5612.385, dOverD: 0.0137 },
        { name: "Bank 3", panels: range(52, 63), twoThetaDeg: 120.4, l2: 1.11, difc: 9068.553, dOverD: 0.0069 },
        { name: "Bank 4", panels: range(64, 81), twoThetaDeg: 150.1, l2: 0.79, difc: 9912.083, dOverD: 0.0036 },
        { name: "Bank 5", panels: range(82, 99), twoThetaDeg: 7, dOverD: 0.039 },
      ],
    },
  },
  {
    id: "powgen",
    modes: ["powder"],
    label: "POWGEN",
    goniometer: { id: "powgen", label: "POWGEN", axes: [], note: "Powder diffractometer: the sample is fixed." },
    // Default band: the 60 Hz frame centred at 1.5 Å (see frames below).
    lambdaMin: 0.967,
    lambdaMax: 2.033,
    geometry: "POWGEN",
    source: `ORNL POWGEN page (60 m). Band: one of the standard chopper frames (Frame in the bar).`,
    frames: {
      source:
        "POWGEN characterisation file PG3_char_2020_01_04_PAC_limit_1.4MW.txt (Mantid test data, sha256 d5beede50de88c73bd1bebcb336017acb836cb26560aeb1c9a3100f598e8c1bc): frequency, centre wavelength, wavelength band and the d range kept by the reduction. PG3_char_2020_05_06-HighRes-PAC_1.4_MW.txt lists the same 60 Hz centres (0.800, 1.500, 2.665, 4.797 Å). Peak profiles for the 0.8, 1.5 and 2.665 Å frames: ORNL's POWGEN GSAS-II instrument files for 2026B, high-resolution guide, 60 Hz (GSAS-II_2026B.zip from neutrons.ornl.gov/powgen/users); they agree with the measured LaB6 resolution of Huq et al., J. Appl. Cryst. 52, 1189 (2019), Fig. 6.",
      list: [
        {
          hz: 60, centre: 0.8, lambdaMin: 0.267, lambdaMax: 1.333, dMin: 0.16, dMax: 7.9,
          profile: { file: "2026B_HighRes_60HzB1_CWL0p8.instprm (sha256 39e1985e…ae283)", alpha: 0.1708533072582208, beta0: 0.0075824082466843055, beta1: -0.00516577901541761, betaq: 0.05760976330830213, sig0: -50.93185615655676, sig1: -548.1087291088847, sig2: 472.73578172569887, sigq: 329.4080753435242 },
        },
        {
          hz: 60, centre: 1.5, lambdaMin: 0.967, lambdaMax: 2.033, dMin: 0.507, dMax: 12.2,
          profile: { file: "2026B_HighRes_60HzB2_CWL1p5.instprm (sha256 24ac6a4d…6322d)", alpha: 0.173, beta0: 0.011013, beta1: -0.020539, betaq: 0.110563, sig0: -86.861, sig1: -470.926, sig2: 204.536, sigq: 400.696 },
        },
        {
          hz: 60, centre: 2.665, lambdaMin: 2.132, lambdaMax: 3.198, dMin: 1.098, dMax: 20.3,
          profile: { file: "2026B_HighRes_60HzB3_CWL2p665.instprm (sha256 e1a27beb…16264)", alpha: 0.185, beta0: 0.005383, beta1: -0.118589, betaq: 0.211904, sig0: 301.715, sig1: -74.184, sig2: 73.021, sigq: -252.239 },
        },
        { hz: 60, centre: 4.797, lambdaMin: 4.264, lambdaMax: 5.33, dMin: 2.14, dMax: 34.8 },
        { hz: 60, centre: 0.533, lambdaMin: 0.05, lambdaMax: 1.066, dMin: 0.05, dMax: 7.5 },
        { hz: 20, centre: 1.599, lambdaMin: 0.05, lambdaMax: 3.198, dMin: 0.1, dMax: 20 },
        { hz: 10, centre: 3.198, lambdaMin: 0.05, lambdaMax: 6.396, dMin: 0.1, dMax: 40 },
      ],
    },
    banks: {
      source:
        "All 40 panels focused to one bank, as POWGEN data are reduced: every detector is group 1 in the Mantid test calibration PG3_PAC_HR_d46168_2020_05_06.h5 (43120 pixels, the 2018 IDF's 40 panels), and autoreduction uses an all-detector grouping (pg3_group_all.xml). Effective L2 = 3.18 m and 2θ = 90° with L1 = 60 m from PG3_char_2020_01_04_PAC_limit_1.4MW.txt (Mantid test data), giving DIFC 22585.7 µs/Å, as the 2024–25 autoreduction's FinalDIFC 22585.8.",
      list: [
        {
          name: "Bank 1 (all panels)",
          panels: [43, 48, 52, 55, 58, 61, 64, 67, 70, 73, 76, 79, 2, 3, 4, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 29, 30, 33, 36, 39].map((n) => `bank${n}`),
          twoThetaDeg: 90,
          l2: 3.18,
        },
      ],
    },
  },
  spectrometer("arcs", "ARCS", { eiMeV: 60, eiMin: 20, eiMax: 1500, elasticFwhm: 0.04 }, "ORNL ARCS spec sheet: 13.6 m to the sample, 3.0–3.4 m to the detectors, −28° to 135° horizontal, −27° to 26° vertical; Ei 20–1500 meV, elastic resolution 3–5 % Ei."),
  spectrometer("sequoia", "SEQUOIA", { eiMeV: 60, eiMin: 4, eiMax: 6000, elasticFwhm: 0.03 }, "ORNL SEQUOIA spec sheet: 20.0 m to the sample, 5.5–6.3 m to the detectors, −30° to 60° horizontal, ±18° vertical (rows B–D; the A row reaches −30°); Ei 4–6000 meV, elastic resolution 1–5 % Ei."),
  spectrometer("cncs", "CNCS", { eiMeV: 12, eiMin: 0.5, eiMax: 80, elasticFwhm: 0.02 }, "ORNL CNCS spec sheet: 36.2 m to the sample, 3.5 m to the detectors, ±16° vertical, horizontal −50° to +140° (the current IDF spans −53.6° to 132.6°); Ei 0.5–80 meV, elastic resolution 10–500 µeV."),
];

/** IDF component names bank{from}…bank{to}. */
function range(from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, k) => `bank${from + k}`);
}

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
