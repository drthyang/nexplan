# NEXPLAN · Neutron Experiment Planner

**Plan neutron diffraction on SNS instruments, and see where the Bragg peaks land on the real detectors.**

Open it at **https://drthyang.github.io/nexplan/**. It runs in the browser: nothing to install, and your files
are never uploaded.

Status: **public beta.** The scattering tables are cross-checked against independent sources but are not yet
certified against the printed literature. The formulas are written out, with their literature sources, in
[CONVENTIONS](docs/CONVENTIONS.md); a code review on 2026-10-06 re-derived them
([what it changed](docs/CONVENTIONS.md#13-changes-from-the-2026-10-06-audit)).

## Quick start

1. Open the app and load a CIF (or a demo structure). The **Structure** and **Reflections** pages show what was read
   and every reflection with its structure factor.
2. Choose an instrument in the header: TOPAZ, CORELLI, NOMAD, POWGEN, ARCS, SEQUOIA or CNCS (or a generic X-ray or
   neutron beam).
3. Single crystal: load the UB on **Orientation** (or keep the CIF cell with U = I), then plan on **Single crystal**:
   type the reflections you need and press *Suggest settings* (TOPAZ), or set a rotation scan (CORELLI, ψ scans).
4. Powder: open **Powder** for the pattern of each focused bank, and **Detectors** for the rings on the real panels.

Everything runs in the browser tab and is kept in its storage, so a reload resumes the session.

## Why NEXPLAN

NEXPLAN grew out of running beamtimes on the diffractometers and spectrometers of ORNL's Spallation Neutron Source
(SNS). It collects, in one place, the checks that experience shows are worth doing before and during an experiment:

- Which reflections reach the detectors at a goniometer setting, and at what wavelength?
- Which settings record the peaks the experiment is for, near mid band and away from panel edges?
- Which d range does each detector bank record, and is d_min low enough to cover it?
- Can two lines be separated in a given bank, or with a given chopper frame?

It is also a way to learn how scattering looks in a real detector geometry: Bragg spots coloured by wavelength on
the actual TOPAZ or CORELLI panels, spots moving as the crystal turns, powder rings swept through a time-of-flight
frame, and the Ewald construction behind them.

## Planning an experiment

Load a CIF (or one of four demo structures from the Crystallography Open Database), choose an instrument in the
header, then work through the three groups of pages from left to right: **Sample** (Structure, Reflections),
**Setup** (Orientation, Detectors) and **Simulation** (Powder, Single crystal).

- **TOPAZ** (time-of-flight Laue, single crystal; cryogenic ω or ambient ω, φ with χ = 135° goniometers).
  - Type the wanted reflections. *Find a setting* turns the goniometer so that one reflection lands near the
    middle of a panel at a mid-band wavelength.
  - *Suggest settings* searches a grid of goniometer angles, within limits you can narrow, with one of two goals.
    *Full coverage* chooses up to N settings that place the wanted peaks well first, then record any not yet
    recorded, then the most symmetry families, then add second and third recordings for scaling. *Fewest settings*
    chooses as few settings as place every wanted peak well, prefers the one that centres them best (mid band,
    panel centre), and fine-tunes each off the grid.
  - Both are greedy searches over a grid of settings, with proven bounds for their first goal: Full coverage places
    at least 1 − 1/e as many wanted peaks well as the best grid settings of the same number would (Nemhauser,
    Wolsey & Fisher 1978), and Fewest settings needs at most ln n + 1 times the fewest settings that place every
    placeable wanted peak well (Johnson 1974; Chvátal 1979). Completeness and redundancy only break ties. They are
    good starting plans, not guaranteed optima.
  - The page shows completeness over symmetry families, reciprocal-space slices shaded by what the plan records,
    and exports the plan as CSV with its provenance.
- **CORELLI.** Rotation scans in 3° steps, optionally interleaved, or a rocking scan about the current angle,
  with completeness as the scan proceeds.
- **NOMAD, POWGEN.** The powder pattern of a focused bank, built the way the data are reduced (focused and divided by
  vanadium, so a line's intensity is Σ|F|²·d⁴·sin θ of the bank on its TOF axis), or of any single panel, on TOF, d
  or Q.
  - NOMAD's six banks use the per-bank Δd/d measured by ORNL (NOMAD overview, 2014, when 50 of the 99 eight-packs
    were installed).
  - POWGEN's single bank uses ORNL's GSAS-II profile for the chosen chopper frame (seven standard frames). The
    0.8 Å frame is tested to be within 25 % of the LaB₆ widths in Huq et al., J. Appl. Cryst. 52, 1189 (2019).
  - The page warns when the bank records d below the calculated d_min, and says whether a selected line is
    separated from its neighbours (≥ 1 FWHM apart) in this bank.
- **ARCS, SEQUOIA, CNCS.** The elastic powder pattern and Debye–Scherrer rings at the chosen Ei, and ψ scans for
  single crystals with the Bragg crossings solved exactly. The chopper setting in the header (a Fermi package and
  frequency, or a CNCS mode and disk frequency) sets the elastic width ΔE/E through Mantid PyChop's resolution, and
  with it the band; or type ΔE/E by hand.
- **Binning** (Single crystal page). The HKL range the plan records along chosen axes, down to a d_min, and a bin
  per axis from the instrument's resolution, as Mantid MDNorm parameters ready to copy: a 3D volume, or a slice
  that integrates one axis over a slab. The limits are written for Mantid's default Q convention, which labels the
  reflection NEXPLAN calls (h k l) as (−h −k −l), or for the crystallographic one.
  - TOPAZ and CORELLI: Q resolution from ORNL's garnet-tools model, which is fitted to measured peak shapes but not
    published. Incident divergence dominates it and is the least documented input.
  - ARCS, SEQUOIA and CNCS: an energy-transfer axis from Mantid PyChop's resolution for the chosen chopper (its ARCS
    and SEQUOIA parameters are tuned to ORNL vanadium data, Mantid PR #38591). These instruments have no published Q
    resolution, so the Q bins are a geometric estimate.
  - Bins are the sharpest quarter's FWHM over the bins per FWHM. Real peaks are wider, because of the sample's
    mosaic and size.
- **Generic X-ray or neutron beam.** Reflection lists and powder patterns at constant wavelength (X-ray
  polarization models included) or at one neutron TOF bank, on 2θ, TOF, d or Q.

**Masks and shadows** (Detectors page) apply on every simulation page, the planner included:

- Masks: pixels at the tube ends or panel edges, whole panels, and the detector IDs and components of a Mantid mask
  file (SaveMask XML), mapped to pixels with the numbering of the instrument definition.
- Shadows: directions the sample environment blocks, as a vertical opening, a leg at a horizontal angle, or a box,
  each fixed in the lab or turning with the goniometer stage it is mounted on. The detector map shows both.

Forbidden peaks are sometimes measured on purpose, since they can reveal an unreported phase, lower symmetry or
multiple scattering. A reflection that is systematically absent, has |F| ≈ 0, or lies below d_min can still be
simulated, wanted and planned. Its position needs no |F|, and a notice says what it is.

## Learning what the detectors see

- **Detectors** (Setup): the panels from the Mantid instrument definition, in 3D and unrolled.
  - Single crystals: the spots at the current setting, coloured by Laue wavelength, with pixel, λ and time of
    flight for each; turn ω and watch them move.
  - *Coverage*: every detector pixel a chosen reflection (or its equivalents) can reach over the goniometer range,
    solved per detector element from each pixel's angular extent, with no stepping gaps.
  - Powders: Debye–Scherrer rings on the panels in one time-of-flight slice; *Play* sweeps the slice through the
    band.
- **Orientation** (Setup): on request, the 3D Laue construction: reciprocal lattice, the Ewald spheres of the band,
  lab and sample frames, and, with an SNS instrument, the reflections in the band that miss every panel.
- **Reflections** and **Structure** (Sample): every signed hkl with d, Q and complex F, folded into symmetry
  families, with systematic and accidental absences flagged; a 3D view of the structure.
- **Scattering power** (Structure page): coherent, incoherent and absorption cross-sections per unit volume,
  attenuation length and Bragg line strengths, compared with a reference material (V, diamond, Si, CeO₂ or
  corundum). This is a relative comparison, not a counting time.

## Under the hood

- **CIF 1.1.** Quoted strings, semicolon text fields, loops over several lines, standard uncertainties, and `.`
  versus `?`. Block selection; ion and isotope type symbols. Defaults and assumptions are listed in the status
  card. CIF 2.0 files and save frames are rejected with a message.
- **Symmetry.** The 564 space-group settings tabulated by gemmi. Origin choices, rhombohedral or hexagonal axes and
  monoclinic cell choices are not guessed: an ambiguous file stops with a choice to make.
- **Structure factors.** X-ray f0 from Waasmaier & Kirfel (1995), neutral atoms and tabulated ions. Neutron b from
  Sears (1992), natural elements and isotopes, complex for absorbers; the sign convention is derived in
  [CONVENTIONS §5](docs/CONVENTIONS.md#5-scattering-amplitudes-and-the-sign-of-complex-b). Isotropic Debye–Waller
  factor (anisotropic ADPs enter as U_eq).
- **Orientation.** UB matrices in the ISAW format, as Mantid's SaveIsawUB writes them, in and out, matched to the
  CIF setting. Re-indexing for another cell (integer supercell, primitive cell or any ITA transformation), exported
  as a UB or as the equivalent Mantid TransformHKL call.
- **Instruments.** Detector geometry from the Mantid instrument definitions (pinned, below). Laue condition,
  goniometer composition, TOF and the B matrix follow Mantid's conventions
  ([CONVENTIONS §8–10](docs/CONVENTIONS.md#10-instrument-simulations)).
- **Your data stay in the browser.** The session (structure, orientation, instrument, plan) is kept in browser
  storage, so a reload resumes it; *Start over* clears it. Layouts are made for phones, tablets and desktop monitors.

## What NEXPLAN does not model

Treat its numbers as geometry plus relative intensities, within these limits:

- **No counting times or absolute intensities.** Intensities are |F|² with Lorentz (and, for X-rays, polarization)
  factors, relative, per unit volume or normalised. TOF patterns assume data normalised by the incident spectrum.
- **Not modelled:** detector efficiency, background, absorption, extinction, multiple scattering, preferred
  orientation, magnetic scattering, X-ray anomalous dispersion, gaps between the tubes of a pack, and inelastic
  scattering (the chopper spectrometers are simulated at the elastic line). Masked pixels and sample-environment
  shadows are modelled only as you set them (*Masks and shadows*, above); there are no defaults.
- **Complex b** for absorbing nuclei are the tabulated values at 2200 m/s.
- **Geometry is nominal.** Detector positions come from the Mantid definition at a pinned commit, not from a
  cycle's calibration. NOMAD banks 1–5 use calibrated DIFC values from ORNL's 2023A GSAS-II instrument file; other
  banks use the geometric DIFC.
- **"Recorded"** means the Laue wavelength is in the band, the sample environment does not block the scattered
  ray, and the ray's first panel records at that pixel (not masked, not switched off).

## Data you can check

Every table is generated from pinned upstream files (URL, commit and SHA-256 in
[`data-sources/sources.json`](data-sources/sources.json)) and cross-checked row by row. The reports and tests:

- [X-ray f0, Waasmaier & Kirfel 1995](docs/data-verification/XRAY_WK1995.md): all 209 species cross-checked.
- [Neutron b, Sears 1992](docs/data-verification/NEUTRON_SEARS1992.md): 324 rows cross-checked; 6 discrepant rows
  are listed for checking against the print.
- Systematic absences equal gemmi's for every one of the 564 settings (all hkl with |h|, |k|, |l| ≤ 4).
- Neutron structure factors equal gemmi 0.7.3's to a relative 1e-8, phases included, for five COD structures to
  d = 0.8 Å.
- [Consistency with Mantid](docs/data-verification/MANTID_CONSISTENCY.md): constants, DIFC and TOF, E ↔ λ, the B
  matrix, the goniometer and the wavelength of a reflection, transcribed from Mantid's source and tested.
- The energy resolution equals Mantid PyChop's (`67c2f43`) to 1e-6 for 1200 chopper settings, energies and energy
  transfers, including where the chopper does not transmit.
- The Q resolution equals ORNL garnet-tools' model (`4eb3206`, its own code run on the pinned file) to 1e-9 for
  280 directions and wavelengths on TOPAZ and CORELLI.
- [MATERIA's tables](docs/data-verification/MATERIA_TABLES.md): a wrong In value and dropped imaginary parts in
  MATERIA's neutron table, since fixed in MATERIA; and X-ray Cromer–Mann rows that fail physical checks, flagged in
  DABAX and in the copy shared by cctbx, gemmi and GSAS-II.

Instrument parameters and their sources (Mantid definitions, ORNL resolution files, POWGEN characterisation) are
in [CONVENTIONS §9–11](docs/CONVENTIONS.md#9-detector-geometry) and in `src/core/ub/instrumentCatalog.ts`.

A code review on 2026-10-06 re-derived the formulas against the literature and the pinned upstream code, with
numerical checks; it is not the domain-expert review the research release still awaits (PLAN §12). Most formulas
were confirmed. The corrections (focused-bank intensities, TOF patterns on Q, exact coverage of one-axis goniometers,
the Q convention of the MDNorm limits, two symmetry edge cases and smaller ones) each come with a test that fails on
the code before them; they are listed in [CONVENTIONS §13](docs/CONVENTIONS.md#13-changes-from-the-2026-10-06-audit).

## Key references

The full list is [CONVENTIONS §12](docs/CONVENTIONS.md#12-references); each formula in CONVENTIONS cites its source.

- Busing & Levy, *Acta Cryst.* 22, 457 (1967): UB matrix and goniometer angles.
- *International Tables for Crystallography* Vols. A (space groups, basis changes), B (structure factors) and C
  (Lorentz–polarization factors).
- Waasmaier & Kirfel, *Acta Cryst.* A51, 416 (1995): X-ray form factors. Sears, *Neutron News* 3(3), 26 (1992):
  neutron scattering lengths.
- Von Dreele, Jorgensen & Windsor, *J. Appl. Cryst.* 15, 581 (1982), and GSAS-II (Toby & Von Dreele, *J. Appl. Cryst.*
  46, 544 (2013)): TOF positions, Lorentz factor and peak shapes.
- Mantid (Arnold et al., *Nucl. Instrum. Methods* A764, 156 (2014)) at `67c2f43`: instrument definitions, units,
  goniometers, ISAW files and PyChop's resolution model.
- Nemhauser, Wolsey & Fisher, *Math. Program.* 14, 265 (1978), and Johnson, *J. Comput. Syst. Sci.* 9, 256 (1974):
  the planner's greedy guarantees.

## Develop

```bash
npm install
npm run data:fetch   # download the pinned sources and verify their SHA-256 (some tests read them)
npm run dev          # http://localhost:5173/nexplan/
npm test             # unit, gemmi-reference, Mantid-consistency and analytic tests
npm run typecheck
```

Data pipeline:

```bash
npm run data:build   # regenerate src/data/*.json and docs/data-verification/*.md
npm run data:check   # fail if generated files are stale (CI)
```

Python references (gemmi, pinned) are generated with `uv`. Their outputs are committed, so the tests need only
Node:

```bash
uv run --no-project --with gemmi==0.7.3 python scripts/data/gen_space_groups.py
uv run --no-project --with gemmi==0.7.3 python scripts/data/gen_reference_sf.py
```

The audited MATERIA modules live in `src/materia/`, copied from `drthyang/web-refinement` at a pinned commit. Do not
edit them here: fix MATERIA, bump the commit in `src/materia/UPSTREAM.json`, then run `npm run materia:sync`.

Layout:

```text
src/core/       science, independent of the UI: symmetry, structure, reflections, powder and TOF, UB and goniometers,
                instruments (detectors, simulation, coverage, planner, resolution, binning)
src/io/         CIF 1.1 reader, ISAW UB files
src/ui/         pages and cards (React); src/views/ 3D views (three.js); src/workers/ the calculation worker
src/data/       generated tables (npm run data:build); src/materia/ the pinned MATERIA copy
scripts/data/   fetch, parse and cross-check the pinned sources; generate the tables and reports
docs/           CONVENTIONS (the formulas, with references), PLAN, data-verification reports
```

The tests that read Mantid's TOPAZ_3007 files and instrument definitions from the pinned sources are skipped until
`npm run data:fetch` has run; the rest use committed fixtures.

Every push to `main` runs CI and deploys the site to GitHub Pages.

## Credits

- Detector geometry: Mantid instrument definitions (GPL-3.0-or-later), commit `67c2f43`. Only numerical geometry is
  extracted, with attribution.
- References: gemmi (space groups, absences, structure factors); Sears (1992); Waasmaier & Kirfel (1995).
- Demo structures: the Crystallography Open Database.
- Design system shared with [MATERIA](https://drthyang.github.io/web-refinement/), NEBULA3D and the RMCProfile
  Workbench.

## License

[GNU Affero General Public License v3.0 only](LICENSE) (AGPL-3.0-only), the same as MATERIA, whose code it
includes. © 2026 Tsung-Han Yang.
