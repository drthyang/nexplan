# NEXPLAN · Neutron Experiment Planner

**Plan neutron diffraction on SNS instruments, and see where the Bragg peaks land on the real detectors.**

Open it at **https://drthyang.github.io/nexplan/**. It runs in the browser: nothing to install, and your files
are never uploaded.

Status: **public beta.** The scattering tables are cross-checked against independent sources but are not yet
certified against the printed literature. NEXPLAN is not an official SNS planning tool: check a plan with the
instrument team before your beamtime.

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
header, then work through the pages from left to right: **Sample**, **Setup**, **Instrument**, **Simulation**.

- **TOPAZ** (time-of-flight Laue, single crystal; cryogenic ω or ambient ω, φ with χ = 135° goniometers).
  - Type the wanted reflections. *Find a setting* turns the goniometer so that one reflection lands near the
    middle of a panel at a mid-band wavelength.
  - *Suggest settings* searches a grid of goniometer angles, within limits you can narrow, with one of two goals.
    *Full coverage* chooses N settings that place the wanted peaks well first, then record the most symmetry
    families, then add second and third recordings for scaling. *Fewest settings* chooses as few settings as
    place every wanted peak well, prefers the one that centres them best (mid band, panel centre), and fine-tunes
    each off the grid.
  - Both are greedy searches: Full coverage is within (1 − 1/e) of the best coverage for its number of settings,
    and Fewest settings within a factor of ln n + 1 of the fewest. They are good starting plans, not guaranteed
    optima.
  - The page shows completeness over symmetry families, reciprocal-space slices shaded by what the plan records,
    and exports the plan as CSV with its provenance.
- **CORELLI.** Rotation scans in 3° steps, optionally interleaved, or a rocking scan about the current angle,
  with completeness as the scan proceeds.
- **NOMAD, POWGEN.** The powder pattern of a focused bank, built the way the data are reduced, or of any single
  panel, on TOF, d or Q.
  - NOMAD's six banks use the per-bank Δd/d measured by ORNL (NOMAD overview, 2014).
  - POWGEN's single bank uses ORNL's GSAS-II profile for the chosen chopper frame (seven standard frames). The
    0.8 Å frame is tested to be within 25 % of the LaB₆ widths in Huq et al., J. Appl. Cryst. 52, 1189 (2019).
  - The page warns when the bank records d below the calculated d_min, and says whether a selected line is
    separated from its neighbours (≥ 1 FWHM apart) in this bank.
- **ARCS, SEQUOIA, CNCS.** The elastic powder pattern and Debye–Scherrer rings at the chosen Ei, and ψ scans for
  single crystals with the Bragg crossings solved exactly.
- **Generic X-ray or neutron beam.** Reflection lists and powder patterns at constant wavelength (X-ray
  polarization models included) or at one neutron TOF bank, on 2θ, TOF, d or Q.

Forbidden peaks are sometimes measured on purpose, since they can reveal an unreported phase, lower symmetry or
multiple scattering. A reflection that is systematically absent, has |F| ≈ 0, or lies below d_min can still be
simulated, wanted and planned. Its position needs no |F|, and a notice says what it is.

## Learning what the detectors see

- **Detectors** (Instrument): the panels from the Mantid instrument definition, in 3D and unrolled.
  - Single crystals: the spots at the current setting, coloured by Laue wavelength, with pixel, λ and time of
    flight for each; turn ω and watch them move.
  - *Coverage*: every detector pixel a chosen reflection (or its equivalents) can reach over the goniometer range,
    solved exactly per detector element. This is the continuous form of NeuXtalViz's stepped "individual peak"
    coverage.
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
- **Not modelled:** detector efficiency, masked or dead pixels, sample-environment shadows, background, absorption,
  extinction, multiple scattering, preferred orientation, magnetic scattering, X-ray anomalous dispersion, and
  inelastic scattering (the chopper spectrometers are simulated at the elastic line).
- **Complex b** for absorbing nuclei are the tabulated values at 2200 m/s.
- **Geometry is nominal.** Detector positions come from the Mantid definition at a pinned commit, not from a
  cycle's calibration. NOMAD banks 1–5 use calibrated DIFC values from ORNL's 2023A GSAS-II instrument file; other
  banks use the geometric DIFC.
- **"Recorded"** means the Laue wavelength is in the band and the scattered ray hits a panel.

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
- [MATERIA's tables](docs/data-verification/MATERIA_TABLES.md): a wrong In value and dropped imaginary parts in
  MATERIA's neutron table; and X-ray Cromer–Mann rows that fail physical checks, flagged in DABAX and in the copy
  shared by cctbx, gemmi and GSAS-II.

Instrument parameters and their sources (Mantid definitions, ORNL resolution files, POWGEN characterisation) are
in [CONVENTIONS §9–11](docs/CONVENTIONS.md#9-detector-geometry) and in `src/core/ub/instrumentCatalog.ts`.

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

Every push to `main` runs CI and deploys the site to GitHub Pages.

## Credits

- Detector geometry: Mantid instrument definitions (GPL-3.0-or-later), commit `67c2f43`. Only numerical geometry is
  extracted, with attribution.
- Reflection coverage: after the "individual peak" planner in NeuXtalViz.
- References: gemmi (space groups, absences, structure factors); Sears (1992); Waasmaier & Kirfel (1995).
- Demo structures: the Crystallography Open Database.
- Design system shared with [MATERIA](https://drthyang.github.io/web-refinement/), NEBULA3D and the RMCProfile
  Workbench.

## License

[GNU Affero General Public License v3.0 only](https://www.gnu.org/licenses/agpl-3.0.html) (AGPL-3.0-only), the same as
MATERIA, whose code it includes. © 2026 Tsung-Han Yang.
